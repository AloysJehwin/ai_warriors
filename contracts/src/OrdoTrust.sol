// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OrdoProofs} from "./OrdoProofs.sol";

/// @title OrdoTrust
/// @notice Who may decide what at an Ordo site, enforced on-chain.
///  - Roles are non-transferable credentials per site, granted only with the site admin's signature.
///  - Validators stake native currency; only an ACTIVE (credentialed, staked, not unstaking) validator's
///    signature can release a validation package.
///  - A validator's stake can be slashed only by two other active validators and a plant manager,
///    and the slashed amount goes to the site's quality fund, never to the people who signed.
/// Every authorisation is an Ordo EIP-712 signature (`OrdoSignature`, domain {name:"Ordo",version:"2",chainId,
/// verifyingContract}) — the same typed data the Ordo console asks people to sign — so anyone may relay it; the
/// contract checks who signed, not who sent the transaction. The domain names this deployment, so a signature made
/// for it cannot be replayed on a redeployed contract (where its nonce would be fresh). Releases are `OrdoRelease`
/// statements (OrdoProofs) that cover exactly what is released.
contract OrdoTrust is ReentrancyGuard {
    uint8 public constant OPERATOR = 1;
    uint8 public constant SUPERVISOR = 2;
    uint8 public constant VALIDATOR = 4;
    uint8 public constant PLANT_MANAGER = 8;
    uint8 public constant ADMIN = 16;
    uint8 public constant VENDOR = 32;
    /// a machine's gateway: it signs stage readings (OrdoProofs.OrdoReading)
    uint8 public constant DEVICE = 64;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
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
        bytes32 proofRoot;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
    }

    uint256 public immutable minStake;
    uint64 public immutable unstakeCooldown;
    /// Ordo's relayer: only it may register a site, so nobody can claim a site id first (ids are public in HCS anchors)
    address public immutable registrar;

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
    event Released(bytes32 indexed site, string packageId, string runId, string lot, bytes32 contentHash, bytes32 proofRoot, address performedBy, address reviewedBy, address approvedBy);
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
    error NotRegistrar();
    error AlreadyReleased();

    constructor(uint256 _minStake, uint64 _unstakeCooldown, address _registrar) {
        minStake = _minStake;
        unstakeCooldown = _unstakeCooldown;
        registrar = _registrar;
    }

    // ------------------------------------------------------------------ signatures

    function siteKey(string memory siteId) public pure returns (bytes32) {
        return keccak256(bytes(siteId));
    }

    function digest(OrdoSig calldata s) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("2"), block.chainid, address(this)));
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
        if (role == DEVICE) return "DEVICE";
        revert BadRole();
    }

    function _roleEntity(address account, uint8 role) internal pure returns (string memory) {
        return string.concat(_hex(account), "#", roleName(role));
    }

    // ------------------------------------------------------------------ sites and roles

    /// The site's first admin registers it with signature action "site.register", entity "<siteId>#<0xtreasury>", and
    /// Ordo's registrar sends it, so only the site Ordo knows can be registered, by the admin Ordo knows.
    /// The admin receives ADMIN and PLANT_MANAGER; `treasury` is the site's quality fund (0 = the admin).
    function registerSite(string calldata siteId, address treasury, OrdoSig calldata sig) external {
        if (msg.sender != registrar) revert NotRegistrar();
        bytes32 k = siteKey(siteId);
        if (sites[k].exists) revert SiteExists();
        address admin = _consume(sig, "site.register", siteId, string.concat(siteId, "#", _hex(treasury)));
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
        _withdraw(siteKey(siteId), msg.sender);
    }

    /// After the cooldown anyone may pay a validator's stake back to that validator. Ordo schedules this call
    /// on Hedera's Schedule Service when the unstake is requested, so the stake comes back without anyone acting.
    function withdrawFor(string calldata siteId, address validator) external nonReentrant {
        _withdraw(siteKey(siteId), validator);
    }

    function _withdraw(bytes32 k, address validator) private {
        Stake storage s = stakes[k][validator];
        if (s.amount == 0) revert NothingStaked();
        if (s.unlockAt == 0 || block.timestamp < s.unlockAt) revert StillLocked(s.unlockAt);
        uint256 amount = s.amount;
        s.amount = 0;
        s.unlockAt = 0;
        emit Withdrawn(k, validator, amount);
        (bool ok, ) = validator.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ releases

    /// Record a released validation package. sigs = [performed, reviewed, approved], each an `OrdoRelease` that names
    /// this site, package, run and lot, this content hash and proof root, and its own meaning. Three different people:
    /// the performer holds a role at the site, the reviewer and approver are active validators and the approver a
    /// plant manager. A package is released once; its record cannot be overwritten.
    function recordRelease(OrdoProofs.ReleaseLot calldata lot, OrdoProofs.ReleaseSig[3] calldata sigs) external {
        bytes32 k = siteKey(lot.siteId);
        if (!sites[k].exists) revert UnknownSite();
        bytes32 pk = keccak256(bytes(lot.packageId));
        if (releases[k][pk].releasedAt != 0) revert AlreadyReleased();
        address[3] memory who;
        who[0] = _consumeRelease(sigs[0], lot, "performed");
        who[1] = _consumeRelease(sigs[1], lot, "reviewed");
        who[2] = _consumeRelease(sigs[2], lot, "approved");
        if (who[0] == who[1] || who[0] == who[2]) revert DuplicateSigner(who[0]);
        if (who[1] == who[2]) revert DuplicateSigner(who[1]);
        if (roles[k][who[0]] == 0) revert NotAuthorized(who[0]);
        if (!_active(k, who[1])) revert NotAuthorized(who[1]);
        if (!_active(k, who[2]) || roles[k][who[2]] & PLANT_MANAGER == 0) revert NotAuthorized(who[2]);
        releases[k][pk] = Release(lot.contentHash, lot.proofRoot, who[0], who[1], who[2], uint64(block.timestamp));
        emit Released(k, lot.packageId, lot.runId, lot.lotLabel, lot.contentHash, lot.proofRoot, who[0], who[1], who[2]);
    }

    function _consumeRelease(OrdoProofs.ReleaseSig calldata s, OrdoProofs.ReleaseLot calldata lot, string memory meaning) internal returns (address) {
        bytes32 n = OrdoProofs.releaseNonce(s);
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return OrdoProofs.releaseSigner(s, lot, meaning);
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
