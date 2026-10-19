// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OrdoTrust
/// @notice Who may decide what at an Ordo site, enforced on-chain.
///  - Roles are non-transferable credentials per site, granted only with the site admin's signature.
///  - Validators stake native currency; only an ACTIVE (credentialed, staked, not unstaking) validator's
///    signature can release a validation package.
///  - A validator's stake can be slashed only by two other active validators and a plant manager,
///    and the slashed amount goes to the site's quality fund, never to the people who signed.
/// Every authorisation is an Ordo EIP-712 signature (`OrdoSignature`, domain {name:"Ordo",version:"1",chainId})
/// — the same typed data the Ordo console asks people to sign — so anyone may relay it; the contract
/// checks who signed, not who sent the transaction.
contract OrdoTrust is ReentrancyGuard {
    uint8 public constant OPERATOR = 1;
    uint8 public constant SUPERVISOR = 2;
    uint8 public constant VALIDATOR = 4;
    uint8 public constant PLANT_MANAGER = 8;
    uint8 public constant ADMIN = 16;
    uint8 public constant VENDOR = 32;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 private constant SIG_TYPEHASH =
        keccak256("OrdoSignature(string action,string entity,string meaning,string comment,string site,string nonce,string issuedAt)");

    struct OrdoSig {
        string action;
        string entity;
        string meaning;
        string comment;
        string site;
        string nonce;
        string issuedAt;
        bytes signature;
    }

    struct Site {
        bool exists;
        address treasury; // the quality fund that receives slashed stake
    }
    struct Stake {
        uint256 amount;
        uint64 unlockAt; // 0 = staked and active; otherwise withdrawable from this time
    }
    struct Release {
        bytes32 contentHash;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
    }

    uint256 public immutable minStake;
    uint64 public immutable unstakeCooldown;

    mapping(bytes32 => Site) public sites;
    mapping(bytes32 => mapping(address => uint8)) public roles;
    mapping(bytes32 => mapping(address => Stake)) public stakes;
    mapping(bytes32 => mapping(bytes32 => Release)) public releases; // site → package key → release
    mapping(bytes32 => bool) public usedNonces;

    event SiteRegistered(bytes32 indexed site, string siteId, address indexed admin, address treasury);
    event RoleGranted(bytes32 indexed site, address indexed account, uint8 role, address indexed by);
    event RoleRevoked(bytes32 indexed site, address indexed account, uint8 role, address indexed by);
    event Staked(bytes32 indexed site, address indexed validator, uint256 amount, uint256 total);
    event UnstakeRequested(bytes32 indexed site, address indexed validator, uint64 unlockAt);
    event Withdrawn(bytes32 indexed site, address indexed validator, uint256 amount);
    event Released(bytes32 indexed site, string packageId, bytes32 contentHash, address performedBy, address reviewedBy, address approvedBy);
    event Slashed(bytes32 indexed site, address indexed validator, uint256 amount, string proposalId, address treasury);

    error UnknownSite();
    error SiteExists();
    error WrongAction();
    error WrongSite();
    error WrongEntity();
    error NonceUsed();
    error NotAuthorized(address signer);
    error BadRole();
    error NotValidator();
    error Unstaking();
    error StillLocked(uint64 unlockAt);
    error NothingStaked();
    error DuplicateSigner(address signer);
    error AmountTooHigh();
    error TransferFailed();
    error BadSignature();

    constructor(uint256 _minStake, uint64 _unstakeCooldown) {
        minStake = _minStake;
        unstakeCooldown = _unstakeCooldown;
    }

    // ------------------------------------------------------------------ signatures

    function siteKey(string memory siteId) public pure returns (bytes32) {
        return keccak256(bytes(siteId));
    }

    function digest(OrdoSig calldata s) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("1"), block.chainid));
        bytes32 structHash = keccak256(
            abi.encode(
                SIG_TYPEHASH,
                keccak256(bytes(s.action)),
                keccak256(bytes(s.entity)),
                keccak256(bytes(s.meaning)),
                keccak256(bytes(s.comment)),
                keccak256(bytes(s.site)),
                keccak256(bytes(s.nonce)),
                keccak256(bytes(s.issuedAt))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// Verify action, site and entity; burn the nonce; return the signer.
    function _consume(OrdoSig calldata s, string memory action, string memory siteId, string memory entity) internal returns (address) {
        if (keccak256(bytes(s.action)) != keccak256(bytes(action))) revert WrongAction();
        if (keccak256(bytes(s.site)) != keccak256(bytes(siteId))) revert WrongSite();
        if (keccak256(bytes(s.entity)) != keccak256(bytes(entity))) revert WrongEntity();
        bytes32 n = keccak256(bytes(s.nonce));
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return _recover(digest(s), s.signature);
    }

    function roleName(uint8 role) public pure returns (string memory) {
        if (role == OPERATOR) return "OPERATOR";
        if (role == SUPERVISOR) return "SUPERVISOR";
        if (role == VALIDATOR) return "VALIDATOR";
        if (role == PLANT_MANAGER) return "PLANT_MANAGER";
        if (role == ADMIN) return "ADMIN";
        if (role == VENDOR) return "VENDOR";
        revert BadRole();
    }

    function _roleEntity(address account, uint8 role) internal pure returns (string memory) {
        return string.concat(_hex(account), "#", roleName(role));
    }

    // ------------------------------------------------------------------ sites and roles

    /// The site's first admin registers it with signature action "site.register", entity = siteId.
    /// The admin receives ADMIN and PLANT_MANAGER; `treasury` is the site's quality fund.
    function registerSite(string calldata siteId, address treasury, OrdoSig calldata sig) external {
        bytes32 k = siteKey(siteId);
        if (sites[k].exists) revert SiteExists();
        address admin = _consume(sig, "site.register", siteId, siteId);
        sites[k] = Site(true, treasury == address(0) ? admin : treasury);
        roles[k][admin] = ADMIN | PLANT_MANAGER;
        emit SiteRegistered(k, siteId, admin, sites[k].treasury);
        emit RoleGranted(k, admin, ADMIN, admin);
        emit RoleGranted(k, admin, PLANT_MANAGER, admin);
    }

    /// Grant one role with a site admin's signature: action "role.grant", entity "<0xaccount>#<ROLE>".
    function grantRole(string calldata siteId, address account, uint8 role, OrdoSig calldata sig) external {
        bytes32 k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
        address admin = _consume(sig, "role.grant", siteId, _roleEntity(account, role));
        if (roles[k][admin] & ADMIN == 0) revert NotAuthorized(admin);
        roles[k][account] |= role;
        emit RoleGranted(k, account, role, admin);
    }

    /// Revoke one role with a site admin's signature: action "role.revoke".
    function revokeRole(string calldata siteId, address account, uint8 role, OrdoSig calldata sig) external {
        bytes32 k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
        address admin = _consume(sig, "role.revoke", siteId, _roleEntity(account, role));
        if (roles[k][admin] & ADMIN == 0) revert NotAuthorized(admin);
        roles[k][account] &= ~role;
        emit RoleRevoked(k, account, role, admin);
    }

    function hasRole(string calldata siteId, address account, uint8 role) external view returns (bool) {
        return roles[siteKey(siteId)][account] & role != 0;
    }

    // ------------------------------------------------------------------ staking

    function isActiveValidator(string calldata siteId, address account) public view returns (bool) {
        return _active(siteKey(siteId), account);
    }

    function _active(bytes32 k, address account) internal view returns (bool) {
        Stake storage s = stakes[k][account];
        return roles[k][account] & VALIDATOR != 0 && s.unlockAt == 0 && s.amount >= minStake;
    }

    /// A credentialed validator adds stake. Staking again cancels a pending unstake.
    function stake(string calldata siteId) external payable {
        bytes32 k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
        if (roles[k][msg.sender] & VALIDATOR == 0) revert NotValidator();
        Stake storage s = stakes[k][msg.sender];
        s.amount += msg.value;
        s.unlockAt = 0;
        emit Staked(k, msg.sender, msg.value, s.amount);
    }

    /// Stop validating: the validator is inactive at once and can withdraw after the cooldown,
    /// so a recall raised meanwhile can still slash.
    function requestUnstake(string calldata siteId) external {
        bytes32 k = siteKey(siteId);
        Stake storage s = stakes[k][msg.sender];
        if (s.amount == 0) revert NothingStaked();
        s.unlockAt = uint64(block.timestamp) + unstakeCooldown;
        emit UnstakeRequested(k, msg.sender, s.unlockAt);
    }

    function withdraw(string calldata siteId) external nonReentrant {
        bytes32 k = siteKey(siteId);
        Stake storage s = stakes[k][msg.sender];
        if (s.amount == 0) revert NothingStaked();
        if (s.unlockAt == 0 || block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);
        uint256 amount = s.amount;
        s.amount = 0;
        s.unlockAt = 0;
        emit Withdrawn(k, msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ releases

    /// Record a released validation package. sigs = [performed, reviewed, approved], each action
    /// "validation.sign" with entity "<packageId>#performed|reviewed|approved". Three different people;
    /// the reviewer and approver must be active validators and the approver a plant manager.
    function recordRelease(string calldata siteId, string calldata packageId, bytes32 contentHash, OrdoSig[3] calldata sigs) external {
        bytes32 k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
        address performed = _consume(sigs[0], "validation.sign", siteId, string.concat(packageId, "#performed"));
        address reviewed = _consume(sigs[1], "validation.sign", siteId, string.concat(packageId, "#reviewed"));
        address approved = _consume(sigs[2], "validation.sign", siteId, string.concat(packageId, "#approved"));
        if (performed == reviewed || performed == approved) revert DuplicateSigner(performed);
        if (reviewed == approved) revert DuplicateSigner(reviewed);
        if (!_active(k, reviewed)) revert NotAuthorized(reviewed);
        if (!_active(k, approved) || roles[k][approved] & PLANT_MANAGER == 0) revert NotAuthorized(approved);
        releases[k][keccak256(bytes(packageId))] = Release(contentHash, performed, reviewed, approved, uint64(block.timestamp));
        emit Released(k, packageId, contentHash, performed, reviewed, approved);
    }

    // ------------------------------------------------------------------ slashing

    /// Slash a validator. sigs = [validator A, validator B, plant manager], each action "validator.slash",
    /// entity "<0xvalidator>#<amount>#<proposalId>": two other active validators and a plant manager,
    /// all different and none of them the accused. The amount goes to the site's quality fund.
    function slash(string calldata siteId, address validator, uint256 amount, string calldata proposalId, OrdoSig[3] calldata sigs) external nonReentrant {
        bytes32 k = siteKey(siteId);
        if (!sites[k].exists) revert UnknownSite();
        string memory entity = string.concat(_hex(validator), "#", _dec(amount), "#", proposalId);
        address a = _consume(sigs[0], "validator.slash", siteId, entity);
        address b = _consume(sigs[1], "validator.slash", siteId, entity);
        address pm = _consume(sigs[2], "validator.slash", siteId, entity);
        if (a == b || a == pm) revert DuplicateSigner(a);
        if (b == pm) revert DuplicateSigner(b);
        if (a == validator || b == validator || pm == validator) revert NotAuthorized(validator);
        if (!_active(k, a)) revert NotAuthorized(a);
        if (!_active(k, b)) revert NotAuthorized(b);
        if (roles[k][pm] & PLANT_MANAGER == 0) revert NotAuthorized(pm);
        Stake storage s = stakes[k][validator];
        if (amount > s.amount) revert AmountTooHigh();
        s.amount -= amount;
        address treasury = sites[k].treasury;
        emit Slashed(k, validator, amount, proposalId, treasury);
        (bool ok, ) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ helpers (no mcopy: runs on any EVM)

    /// secp256k1 recovery of a 65-byte signature, rejecting malleable s values.
    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(sv) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(h, v, r, sv);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    /// Lowercase 0x-prefixed hex address, as Ordo writes addresses.
    function _hex(address a) internal pure returns (string memory) {
        bytes memory out = new bytes(42);
        bytes16 digits = "0123456789abcdef";
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; i--) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    function _dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory out = new bytes(len);
        while (v != 0) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(out);
    }
}
