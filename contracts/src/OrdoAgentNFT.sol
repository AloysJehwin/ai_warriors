// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Ordo's agents as ERC-7857 intelligent NFTs (0G Galileo)
/// @notice One token per agent per site. Its intelligent data says what the agent is allowed to be: the hash of the
/// policy it acts under, the model it runs, the autonomy each line gives it and its encrypted configuration on 0G
/// Storage. Ordo updates the data whenever one of those changes, so the token's `Updated` history is the agent's
/// audit trail. The site's plant managers are its authorized users.
/// @dev Follows the ERC-7857 metadata and authorization interfaces (IntelligentData, intelligentDatasOf, Updated,
/// authorizeUsage, revokeAuthorization, authorizedUsersOf). An Ordo agent belongs to its site, so tokens do not
/// transfer: there is no iTransferFrom or iCloneFrom, and plain ERC-721 transfers revert.
contract OrdoAgentNFT is ERC721 {
    struct IntelligentData {
        string dataDescription;
        bytes32 dataHash;
    }

    uint256 public constant MAX_AUTHORIZED_USERS = 100;

    /// @notice Ordo's account: it mints and updates agents
    address public minter;
    uint256 public totalSupply;
    mapping(uint256 tokenId => string) public agentOf;
    mapping(string agent => uint256) public tokenOfAgent;
    mapping(uint256 tokenId => IntelligentData[]) private _datas;
    mapping(uint256 tokenId => address[]) private _authorized;

    event Minted(uint256 indexed tokenId, address indexed to, string agent);
    event Updated(uint256 indexed tokenId, IntelligentData[] oldDatas, IntelligentData[] newDatas);
    event Authorization(address indexed from, address indexed to, uint256 indexed tokenId);
    event AuthorizationRevoked(address indexed from, address indexed to, uint256 indexed tokenId);
    event MinterChanged(address indexed minter);

    error NotMinter();
    error NotOwnerOrMinter();
    error NotTransferable();
    error AgentExists(string agent);
    error TooManyUsers();
    error AlreadyAuthorized(address user);
    error NotAuthorized(address user);

    constructor(address minter_) ERC721("Ordo Agent", "ORDO-AGENT") {
        minter = minter_;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }
    modifier onlyOwnerOrMinter(uint256 tokenId) {
        if (msg.sender != minter && msg.sender != _requireOwned(tokenId)) revert NotOwnerOrMinter();
        _;
    }

    function setMinter(address minter_) external onlyMinter {
        minter = minter_;
        emit MinterChanged(minter_);
    }

    /// @param agent "<site>/<agent>", unique
    function mint(IntelligentData[] calldata iDatas, address to, string calldata agent) external onlyMinter returns (uint256 tokenId) {
        if (tokenOfAgent[agent] != 0) revert AgentExists(agent);
        tokenId = ++totalSupply;
        agentOf[tokenId] = agent;
        tokenOfAgent[agent] = tokenId;
        _safeMint(to, tokenId);
        for (uint256 i; i < iDatas.length; ++i) _datas[tokenId].push(iDatas[i]);
        emit Minted(tokenId, to, agent);
        emit Updated(tokenId, new IntelligentData[](0), iDatas);
    }

    function update(uint256 tokenId, IntelligentData[] calldata newDatas) external onlyMinter {
        _requireOwned(tokenId);
        IntelligentData[] memory old = _datas[tokenId];
        delete _datas[tokenId];
        for (uint256 i; i < newDatas.length; ++i) _datas[tokenId].push(newDatas[i]);
        emit Updated(tokenId, old, newDatas);
    }

    function intelligentDatasOf(uint256 tokenId) external view returns (IntelligentData[] memory) {
        _requireOwned(tokenId);
        return _datas[tokenId];
    }

    function authorizeUsage(uint256 tokenId, address user) external onlyOwnerOrMinter(tokenId) {
        address[] storage users = _authorized[tokenId];
        if (users.length >= MAX_AUTHORIZED_USERS) revert TooManyUsers();
        for (uint256 i; i < users.length; ++i) if (users[i] == user) revert AlreadyAuthorized(user);
        users.push(user);
        emit Authorization(msg.sender, user, tokenId);
    }

    function revokeAuthorization(uint256 tokenId, address user) external onlyOwnerOrMinter(tokenId) {
        address[] storage users = _authorized[tokenId];
        for (uint256 i; i < users.length; ++i) {
            if (users[i] == user) {
                users[i] = users[users.length - 1];
                users.pop();
                emit AuthorizationRevoked(msg.sender, user, tokenId);
                return;
            }
        }
        revert NotAuthorized(user);
    }

    function authorizedUsersOf(uint256 tokenId) external view returns (address[] memory) {
        _requireOwned(tokenId);
        return _authorized[tokenId];
    }

    /// @dev Only minting moves a token: agents stay with their site.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert NotTransferable();
        return super._update(to, tokenId, auth);
    }
}
