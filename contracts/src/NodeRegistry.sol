// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title fldx NodeRegistry
/// @notice On-chain registry of compute nodes. Each node stakes the configured
///         ERC20 token (USDC on prod) and advertises its endpoint, ECDH
///         transport key, supported backends, and per-backend pricing. The
///         JobEscrow contract is allowed to slash stake on dispute; the owner
///         can also slash as an admin override.
///
///         The node's address (msg.sender) IS its identity. The same secp256k1
///         keypair the node persists off-chain (see crates/crypto::NodeIdentity)
///         derives this address. There is no separate on-chain identity step.
contract NodeRegistry {
    using SafeERC20 for IERC20;

    /// Bit indices into Node.backendBitmap. Mirrors Rust `protocol::BackendType`.
    enum Backend {
        MockTee, // 0
        Fhe, // 1
        Mcp, // 2
        Local // 3
    }

    uint8 public constant BACKEND_COUNT = 4;

    struct Node {
        string url;
        // X25519 public key (32 bytes). Clients ECDH against this for the
        // session-symmetric key. Same value the node advertises off-chain.
        bytes32 ecdhPubkey;
        // Bitmap: bit i set ⇒ node supports backend i. e.g. 0x9 = MockTee + Local.
        uint8 backendBitmap;
        uint64 maxTokens;
        // Price per 1k tokens, in stakeToken raw units (USDC = 6 decimals),
        // indexed by Backend. Zero means "this backend not priced" — combined
        // with the bitmap to determine real availability.
        uint256[BACKEND_COUNT] pricePer1k;
        uint256 stake;
        bool active;
    }

    IERC20 public immutable stakeToken;
    address public immutable owner;
    /// JobEscrow address allowed to slash. Set once, post-deploy.
    address public escrow;
    uint256 public minStake;

    mapping(address => Node) private _nodes;
    address[] public nodeList;
    mapping(address => uint256) private _nodeListIndex; // 1-based; 0 means absent

    event Registered(
        address indexed node, string url, bytes32 ecdhPubkey, uint8 backendBitmap, uint256 stake
    );
    event Updated(
        address indexed node, string url, uint8 backendBitmap, uint256[BACKEND_COUNT] pricePer1k
    );
    event Unregistered(address indexed node, uint256 returnedStake);
    event Slashed(address indexed node, address indexed recipient, uint256 amount);
    event EscrowSet(address indexed escrow);
    event MinStakeSet(uint256 minStake);

    error NotOwner();
    error NotAuthorized();
    error EscrowAlreadySet();
    error AlreadyRegistered();
    error NotRegistered();
    error StakeBelowMin(uint256 provided, uint256 required);
    error AmountExceedsStake(uint256 amount, uint256 stake);
    error InvalidBackend();

    constructor(IERC20 _stakeToken, address _owner, uint256 _minStake) {
        stakeToken = _stakeToken;
        owner = _owner;
        minStake = _minStake;
        emit MinStakeSet(_minStake);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// One-shot setter so the registry and escrow can be deployed independently
    /// without a CREATE2 dance. After this is set the owner can still rotate
    /// it via setEscrow if the escrow contract needs upgrading.
    function setEscrow(address _escrow) external onlyOwner {
        escrow = _escrow;
        emit EscrowSet(_escrow);
    }

    function setMinStake(uint256 _minStake) external onlyOwner {
        minStake = _minStake;
        emit MinStakeSet(_minStake);
    }

    function register(
        string calldata url,
        bytes32 ecdhPubkey,
        uint8 backendBitmap,
        uint64 maxTokens,
        uint256[BACKEND_COUNT] calldata pricePer1k,
        uint256 stake
    ) external {
        if (stake < minStake) revert StakeBelowMin(stake, minStake);
        Node storage n = _nodes[msg.sender];
        if (n.active) revert AlreadyRegistered();

        stakeToken.safeTransferFrom(msg.sender, address(this), stake);

        n.url = url;
        n.ecdhPubkey = ecdhPubkey;
        n.backendBitmap = backendBitmap;
        n.maxTokens = maxTokens;
        n.pricePer1k = pricePer1k;
        n.stake = stake;
        n.active = true;

        if (_nodeListIndex[msg.sender] == 0) {
            nodeList.push(msg.sender);
            _nodeListIndex[msg.sender] = nodeList.length; // 1-based
        }

        emit Registered(msg.sender, url, ecdhPubkey, backendBitmap, stake);
    }

    /// Update mutable metadata (url, pricing, capacity, supported backends)
    /// without touching stake. Useful for changing prices or rotating ECDH key.
    function update(
        string calldata url,
        bytes32 ecdhPubkey,
        uint8 backendBitmap,
        uint64 maxTokens,
        uint256[BACKEND_COUNT] calldata pricePer1k
    ) external {
        Node storage n = _nodes[msg.sender];
        if (!n.active) revert NotRegistered();

        n.url = url;
        n.ecdhPubkey = ecdhPubkey;
        n.backendBitmap = backendBitmap;
        n.maxTokens = maxTokens;
        n.pricePer1k = pricePer1k;

        emit Updated(msg.sender, url, backendBitmap, pricePer1k);
    }

    function unregister() external {
        Node storage n = _nodes[msg.sender];
        if (!n.active) revert NotRegistered();

        uint256 returned = n.stake;
        n.stake = 0;
        n.active = false;
        _removeFromList(msg.sender);

        if (returned > 0) {
            stakeToken.safeTransfer(msg.sender, returned);
        }
        emit Unregistered(msg.sender, returned);
    }

    /// Burn stake and pay it to `recipient`. Callable by the configured escrow
    /// (per-session dispute path) or the owner (admin override). If the slash
    /// drains the stake, the node becomes inactive.
    function slash(address node, address recipient, uint256 amount) external {
        if (msg.sender != escrow && msg.sender != owner) revert NotAuthorized();
        Node storage n = _nodes[node];
        if (!n.active) revert NotRegistered();
        if (amount > n.stake) revert AmountExceedsStake(amount, n.stake);

        n.stake -= amount;
        if (n.stake == 0) {
            n.active = false;
            _removeFromList(node);
        }
        if (amount > 0) {
            stakeToken.safeTransfer(recipient, amount);
        }
        emit Slashed(node, recipient, amount);
    }

    // --- Views ---

    function nodes(address node) external view returns (Node memory) {
        return _nodes[node];
    }

    function isActive(address node) external view returns (bool) {
        return _nodes[node].active;
    }

    function priceFor(address node, Backend backend) external view returns (uint256) {
        return _nodes[node].pricePer1k[uint8(backend)];
    }

    function supportsBackend(address node, Backend backend) external view returns (bool) {
        return _nodes[node].backendBitmap & (uint8(1) << uint8(backend)) != 0;
    }

    function nodeCount() external view returns (uint256) {
        return nodeList.length;
    }

    // --- Internal ---

    function _removeFromList(address node) internal {
        uint256 idx = _nodeListIndex[node];
        if (idx == 0) return; // not in list
        uint256 lastIdx = nodeList.length;
        if (idx != lastIdx) {
            address last = nodeList[lastIdx - 1];
            nodeList[idx - 1] = last;
            _nodeListIndex[last] = idx;
        }
        nodeList.pop();
        delete _nodeListIndex[node];
    }
}
