// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrdoSigned} from "./OrdoSigned.sol";
import {IExtendedResolver, ITextResolver, OrdoEnsName, OrdoEnsRoles} from "./OrdoEnsRoles.sol";

/// The gateway call a CCIP-Read client makes for an off-chain answer (EIP-3668, as in ENS's OffchainResolver).
interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory result, uint64 expires, bytes memory sig);
}

/// @title OrdoLotResolver
/// @notice Gives every production lot an ENS name, `lot-<order>.<site>.<parent>`, that resolves to its passport,
///         with no registration and no gas per lot.
///
/// It is the resolver of each site name. ENSv2 resolution walks down to the closest name with a resolver, so every
/// `lot-…` name under a site reaches it (ENSIP-10 wildcard):
///  - A lot's release record is on-chain: `recordRelease` stores it only with three EIP-712 signatures from people
///    whose ENS member names carry the right roles (OrdoEnsRoles), so revoking a name stops that person releasing.
///    `com.ordo.release*` text records are answered from it directly.
///  - Everything else about the lot (passport URL, status, product…) comes from Ordo's ledger through CCIP-Read
///    (EIP-3668): the resolver reverts with OffchainLookup, the client asks Ordo's gateway, and `resolveWithProof`
///    accepts the answer only if Ordo's signer signed it.
///  - Names that are not lots (the site name itself) are passed to `fallbackResolver`, where their records live.
contract OrdoLotResolver is OrdoSigned {
    struct Release {
        bytes32 site;
        bytes32 contentHash;
        address performedBy;
        address reviewedBy;
        address approvedBy;
        uint64 releasedAt;
        string packageId;
    }

    OrdoEnsRoles public immutable credentials;
    IExtendedResolver public immutable fallbackResolver;
    address public owner;
    address public signer;
    string[] private gateways;

    /// lot node (namehash) → its latest release, and how many it has had
    mapping(bytes32 => Release) public latestRelease;
    mapping(bytes32 => uint256) public releaseCount;

    event LotReleased(bytes32 indexed node, bytes32 indexed site, string lotLabel, string packageId, bytes32 contentHash, address performedBy, address reviewedBy, address approvedBy);
    event GatewayChanged(address signer, string[] urls);

    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error NotOwner();
    error NotALot();
    error UnknownSite();
    error DuplicateSigner(address signer);
    error NotCredentialed(address signer, uint8 needs);
    error ExpiredAnswer();
    error BadAnswer();

    bytes4 private constant TEXT = ITextResolver.text.selector;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 private constant SIG_TYPEHASH =
        keccak256("OrdoSignature(string action,string entity,string meaning,string comment,string site,string nonce,string issuedAt)");

    constructor(OrdoEnsRoles _credentials, IExtendedResolver _fallback, address _signer, string[] memory _gateways) {
        credentials = _credentials;
        fallbackResolver = _fallback;
        owner = msg.sender;
        signer = _signer;
        gateways = _gateways;
    }

    function setGateway(address _signer, string[] memory urls) external {
        if (msg.sender != owner) revert NotOwner();
        signer = _signer;
        gateways = urls;
        emit GatewayChanged(_signer, urls);
    }

    function gatewayUrls() external view returns (string[] memory) {
        return gateways;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == type(IExtendedResolver).interfaceId;
    }

    // ------------------------------------------------------------------ releases

    /// Record that a lot was released. sigs = [performed, reviewed, approved], each action "validation.sign" with
    /// entity "<packageId>#performed|reviewed|approved", the same signatures OrdoTrust takes. `chainIds` are the
    /// chains each person signed for (their EIP-712 domain). Three different people: the performer must hold a role at the
    /// site, the reviewer VALIDATOR, the approver VALIDATOR and PLANT_MANAGER, all through their ENS member names.
    function recordRelease(string calldata siteId, string calldata lotLabel, string calldata packageId, bytes32 contentHash, uint256[3] calldata chainIds, OrdoSig[3] calldata sigs) external {
        if (!_isLot(bytes(lotLabel))) revert NotALot();
        bytes32 k = keccak256(bytes(siteId));
        string[] memory site = credentials.siteLabels(k);
        if (site.length == 0) revert UnknownSite();
        address performed = _consumeOn(sigs[0], siteId, string.concat(packageId, "#performed"), chainIds[0]);
        address reviewed = _consumeOn(sigs[1], siteId, string.concat(packageId, "#reviewed"), chainIds[1]);
        address approved = _consumeOn(sigs[2], siteId, string.concat(packageId, "#approved"), chainIds[2]);
        if (performed == reviewed || performed == approved) revert DuplicateSigner(performed);
        if (reviewed == approved) revert DuplicateSigner(reviewed);
        _require(k, performed, 0);
        _require(k, reviewed, credentials.VALIDATOR());
        _require(k, approved, credentials.VALIDATOR() | credentials.PLANT_MANAGER());

        bytes32 node = OrdoEnsName.namehash(OrdoEnsName.prepend(lotLabel, site));
        latestRelease[node] = Release(k, contentHash, performed, reviewed, approved, uint64(block.timestamp), packageId);
        releaseCount[node] += 1;
        emit LotReleased(node, k, lotLabel, packageId, contentHash, performed, reviewed, approved);
    }

    /// needs = 0: any role at the site
    function _require(bytes32 site, address who, uint8 needs) internal view {
        uint8 has = credentials.roles(site, who);
        if (needs == 0 ? has == 0 : has & needs != needs) revert NotCredentialed(who, needs);
    }

    function releaseDigest(OrdoSig calldata s, uint256 chainId) public pure returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ordo"), keccak256("1"), chainId));
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

    function _consumeOn(OrdoSig calldata s, string calldata siteId, string memory entity, uint256 chainId) internal returns (address) {
        if (keccak256(bytes(s.action)) != keccak256("validation.sign")) revert WrongAction();
        if (keccak256(bytes(s.site)) != keccak256(bytes(siteId))) revert WrongSite();
        if (keccak256(bytes(s.entity)) != keccak256(bytes(entity))) revert WrongEntity();
        bytes32 n = keccak256(bytes(s.nonce));
        if (usedNonces[n]) revert NonceUsed();
        usedNonces[n] = true;
        return _recover(releaseDigest(s, chainId), s.signature);
    }

    // ------------------------------------------------------------------ resolution

    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        uint256 len = uint8(name[0]);
        if (!_isLot(name[1:1 + len])) return fallbackResolver.resolve(name, data);

        if (data.length >= 4 && bytes4(data[0:4]) == TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            Release storage r = latestRelease[node];
            if (r.releasedAt != 0 && _startsWith(bytes(key), "com.ordo.release")) {
                (bool known, string memory value) = _releaseText(node, r, key);
                if (known) return abi.encode(value);
            }
        }
        bytes memory callData = abi.encodeCall(IResolverService.resolve, (name, data));
        revert OffchainLookup(address(this), gateways, callData, this.resolveWithProof.selector, callData);
    }

    /// Accept a gateway answer signed by Ordo's signer: sig over keccak256(0x1900, this, expires, keccak256(request), keccak256(result)).
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        if (expires < block.timestamp) revert ExpiredAnswer();
        bytes32 h = keccak256(abi.encodePacked(hex"1900", address(this), expires, keccak256(extraData), keccak256(result)));
        if (sig.length != 65 || this.recoverSigner(h, sig) != signer) revert BadAnswer();
        return result;
    }

    /// Exposed so resolveWithProof can recover from memory bytes through calldata.
    function recoverSigner(bytes32 h, bytes calldata sig) external pure returns (address) {
        return _recover(h, sig);
    }

    function _releaseText(bytes32 node, Release storage r, string memory key) internal view returns (bool, string memory) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("com.ordo.release")) return (true, _hex32(r.contentHash));
        if (k == keccak256("com.ordo.release.package")) return (true, r.packageId);
        if (k == keccak256("com.ordo.release.at")) return (true, _dec(r.releasedAt));
        if (k == keccak256("com.ordo.release.count")) return (true, _dec(releaseCount[node]));
        if (k == keccak256("com.ordo.release.signers"))
            return (true, string.concat(credentials.memberName(r.site, r.performedBy), ",", credentials.memberName(r.site, r.reviewedBy), ",", credentials.memberName(r.site, r.approvedBy)));
        return (false, "");
    }

    function _isLot(bytes memory label) internal pure returns (bool) {
        return label.length > 4 && _startsWith(label, "lot-");
    }

    function _startsWith(bytes memory b, bytes memory prefix) internal pure returns (bool) {
        if (b.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) if (b[i] != prefix[i]) return false;
        return true;
    }
}
