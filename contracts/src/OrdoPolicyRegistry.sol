// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title OrdoPolicyRegistry
/// @notice Publishes which autonomy policy each production line runs under. Ordo's policy guard
///         hashes its local policy file and refuses L3/L4 automation if it differs from this record,
///         so every automated decision can be traced to a policy a plant manager signed on-chain.
contract OrdoPolicyRegistry is AccessControl {
    bytes32 public constant PLANT_MANAGER_ROLE = keccak256("PLANT_MANAGER_ROLE");

    struct Policy {
        uint8 autonomyLevel; // 1..4 = L1 Assist .. L4 Autonomous
        bytes32 policyHash; // sha256 of the canonical policy file
        uint32 version;
        uint64 updatedAt;
    }

    /// @dev key = keccak256(bytes(lineId)), e.g. keccak256("LINE-02")
    mapping(bytes32 => Policy) public policies;

    event PolicyUpdated(bytes32 indexed line, uint8 autonomyLevel, bytes32 policyHash, uint32 version, address indexed by);

    error InvalidLevel(uint8 level);
    error VersionNotIncreasing(uint32 current, uint32 proposed);

    constructor(address admin, address plantManager) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PLANT_MANAGER_ROLE, plantManager);
    }

    function setPolicy(bytes32 line, uint8 level, bytes32 policyHash, uint32 version) external onlyRole(PLANT_MANAGER_ROLE) {
        if (level < 1 || level > 4) revert InvalidLevel(level);
        Policy storage p = policies[line];
        if (version <= p.version) revert VersionNotIncreasing(p.version, version);
        policies[line] = Policy(level, policyHash, version, uint64(block.timestamp));
        emit PolicyUpdated(line, level, policyHash, version, msg.sender);
    }
}
