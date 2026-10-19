// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentSpendVault
/// @notice Lets an AI agent pay maintenance vendors, but only within hard limits enforced on-chain:
///         allow-listed vendors, a per-payment cap and a per-day cap per agent, an escrow that a human
///         releases once the work is done, and an admin kill switch. Every payment carries the hash of
///         the Ordo ledger entry that justified it.
/// @dev On Hedera the EVM denominates HBAR in tinybars (8 decimals); caps and amounts use the chain's
///      native unit as seen by the contract.
contract AgentSpendVault is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");

    struct Caps {
        uint256 perTx;
        uint256 perDay;
    }

    enum Status {
        None,
        Escrowed,
        Released,
        Refunded
    }

    struct WorkOrder {
        address agent;
        address vendor;
        uint256 amount;
        uint64 expiresAt;
        Status status;
        bytes32 incidentHash;
    }

    mapping(address => Caps) public caps;
    mapping(address => bool) public vendorAllowed;
    /// @dev agent => day index (block.timestamp / 1 days) => amount committed that day
    mapping(address => mapping(uint256 => uint256)) public spentOnDay;
    mapping(bytes32 => WorkOrder) public workOrders;
    uint256 public escrowedTotal;

    event CapsSet(address indexed agent, uint256 perTx, uint256 perDay);
    event VendorSet(address indexed vendor, bool allowed);
    event Paid(address indexed agent, address indexed vendor, uint256 amount, bytes32 indexed incidentHash);
    event Escrowed(bytes32 indexed id, address indexed agent, address indexed vendor, uint256 amount, uint64 expiresAt, bytes32 incidentHash);
    event Released(bytes32 indexed id, address indexed by);
    event Refunded(bytes32 indexed id);
    event Withdrawn(address indexed to, uint256 amount);

    error VendorNotAllowed(address vendor);
    error ZeroAmount();
    error OverPerTxCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 wouldSpend, uint256 cap);
    error InsufficientFree(uint256 amount, uint256 free);
    error WorkOrderExists(bytes32 id);
    error NotEscrowed(bytes32 id);
    error NotExpired(bytes32 id, uint64 expiresAt);
    error TransferFailed();

    constructor(address admin, address agent, address releaser, Caps memory agentCaps) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, agent);
        _grantRole(RELEASER_ROLE, releaser);
        caps[agent] = agentCaps;
        emit CapsSet(agent, agentCaps.perTx, agentCaps.perDay);
    }

    receive() external payable {}

    // ---------- Admin ----------
    function setCaps(address agent, uint256 perTx, uint256 perDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        caps[agent] = Caps(perTx, perDay);
        emit CapsSet(agent, perTx, perDay);
    }

    function setVendor(address vendor, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        vendorAllowed[vendor] = allowed;
        emit VendorSet(vendor, allowed);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraw funds that are not held in escrow.
    function withdraw(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 free = address(this).balance - escrowedTotal;
        if (amount > free) revert InsufficientFree(amount, free);
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    // ---------- Agent ----------
    /// @notice Small direct payment, e.g. a call-out fee.
    function pay(address payable vendor, uint256 amount, bytes32 incidentHash) external onlyRole(AGENT_ROLE) whenNotPaused nonReentrant {
        _commit(msg.sender, vendor, amount);
        _send(vendor, amount);
        emit Paid(msg.sender, vendor, amount, incidentHash);
    }

    /// @notice Hold funds for a work order; a human with RELEASER_ROLE releases them when the work is done.
    function escrow(bytes32 id, address vendor, uint256 amount, uint64 ttl, bytes32 incidentHash) external onlyRole(AGENT_ROLE) whenNotPaused nonReentrant {
        if (workOrders[id].status != Status.None) revert WorkOrderExists(id);
        _commit(msg.sender, vendor, amount);
        uint64 expiresAt = uint64(block.timestamp) + ttl;
        workOrders[id] = WorkOrder(msg.sender, vendor, amount, expiresAt, Status.Escrowed, incidentHash);
        escrowedTotal += amount;
        emit Escrowed(id, msg.sender, vendor, amount, expiresAt, incidentHash);
    }

    // ---------- People ----------
    function release(bytes32 id) external onlyRole(RELEASER_ROLE) whenNotPaused nonReentrant {
        WorkOrder storage w = workOrders[id];
        if (w.status != Status.Escrowed) revert NotEscrowed(id);
        w.status = Status.Released;
        escrowedTotal -= w.amount;
        _send(payable(w.vendor), w.amount);
        emit Released(id, msg.sender);
    }

    /// @notice After expiry anyone may return an unreleased escrow to the vault's free balance.
    ///         Works while paused, so funds are never stuck.
    function refund(bytes32 id) external nonReentrant {
        WorkOrder storage w = workOrders[id];
        if (w.status != Status.Escrowed) revert NotEscrowed(id);
        if (block.timestamp < w.expiresAt) revert NotExpired(id, w.expiresAt);
        w.status = Status.Refunded;
        escrowedTotal -= w.amount;
        emit Refunded(id);
    }

    // ---------- Views ----------
    function spentToday(address agent) external view returns (uint256) {
        return spentOnDay[agent][block.timestamp / 1 days];
    }

    function freeBalance() external view returns (uint256) {
        return address(this).balance - escrowedTotal;
    }

    // ---------- Internal ----------
    function _commit(address agent, address vendor, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (!vendorAllowed[vendor]) revert VendorNotAllowed(vendor);
        Caps memory c = caps[agent];
        if (amount > c.perTx) revert OverPerTxCap(amount, c.perTx);
        uint256 day = block.timestamp / 1 days;
        uint256 wouldSpend = spentOnDay[agent][day] + amount;
        if (wouldSpend > c.perDay) revert OverDailyCap(wouldSpend, c.perDay);
        uint256 free = address(this).balance - escrowedTotal;
        if (amount > free) revert InsufficientFree(amount, free);
        spentOnDay[agent][day] = wouldSpend;
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
