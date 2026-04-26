// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {NodeRegistry} from "./NodeRegistry.sol";

/// @title flodex JobEscrow
/// @notice Per-session USDC escrow. Client opens a session against a node,
///         locking up `maxSpend`. Node executes the agent loop off-chain and
///         later submits a signed receipt of total token usage. The contract
///         computes cost from the registry's per-node pricing, pays the node,
///         and refunds the rest to the client. Sessions stuck past the
///         reclaim timeout can be reclaimed unilaterally by the client.
///
///         The receipt is signed with the node's secp256k1 identity (same
///         key it persists on-disk; same Ethereum address it registered
///         from). Verification uses `ecrecover` via OZ's ECDSA library.
contract JobEscrow {
    using SafeERC20 for IERC20;

    /// Tag included in the receipt hash so off-chain signing tools can never
    /// be tricked into producing a valid receipt by reusing some unrelated
    /// payload of the same shape. Bumped if the receipt schema changes.
    string public constant RECEIPT_DOMAIN = "flodex-v0-receipt";

    struct Session {
        address client;
        address node;
        NodeRegistry.Backend backend;
        uint256 maxSpend;
        uint64 openedAt;
        bool open;
    }

    NodeRegistry public immutable registry;
    IERC20 public immutable usdc;
    /// Seconds after openSession before the client can reclaim unilaterally.
    uint64 public immutable reclaimTimeout;

    mapping(bytes32 => Session) private _sessions;

    event SessionOpened(
        bytes32 indexed sessionId,
        address indexed client,
        address indexed node,
        NodeRegistry.Backend backend,
        uint256 maxSpend
    );
    event Settled(
        bytes32 indexed sessionId, uint256 totalTokens, uint256 paid, uint256 refunded
    );
    event Reclaimed(bytes32 indexed sessionId, address indexed client, uint256 amount);

    error SessionAlreadyOpen();
    error SessionNotOpen();
    error NodeNotActive();
    error BackendNotSupported();
    error CostExceedsMaxSpend(uint256 cost, uint256 maxSpend);
    error InvalidSignature(address recovered, address expected);
    error ReclaimTooEarly(uint64 openedAt, uint64 reclaimAt);
    error NotClient();

    constructor(NodeRegistry _registry, IERC20 _usdc, uint64 _reclaimTimeout) {
        registry = _registry;
        usdc = _usdc;
        reclaimTimeout = _reclaimTimeout;
    }

    /// Open a session: pulls `maxSpend` from the caller into escrow, books a
    /// claim against `node` at the chosen `backend`. The sessionId is caller-
    /// supplied so off-chain code can correlate to its own ECDH session.
    function openSession(
        bytes32 sessionId,
        address node,
        NodeRegistry.Backend backend,
        uint256 maxSpend
    ) external {
        if (_sessions[sessionId].openedAt != 0) revert SessionAlreadyOpen();
        if (!registry.isActive(node)) revert NodeNotActive();
        if (!registry.supportsBackend(node, backend)) revert BackendNotSupported();

        usdc.safeTransferFrom(msg.sender, address(this), maxSpend);

        _sessions[sessionId] = Session({
            client: msg.sender,
            node: node,
            backend: backend,
            maxSpend: maxSpend,
            openedAt: uint64(block.timestamp),
            open: true
        });

        emit SessionOpened(sessionId, msg.sender, node, backend, maxSpend);
    }

    /// Settle a session against a node-signed receipt. Anyone can submit (the
    /// node usually does, but the client could too once it has the signature).
    /// Receipt format the node signs is the EIP-191-prefixed keccak256 of:
    ///     RECEIPT_DOMAIN || chainId || address(this) || sessionId || totalTokens
    function settle(bytes32 sessionId, uint256 totalTokens, bytes calldata signature) external {
        Session storage s = _sessions[sessionId];
        if (!s.open) revert SessionNotOpen();

        bytes32 receiptHash = keccak256(
            abi.encode(
                RECEIPT_DOMAIN, block.chainid, address(this), sessionId, totalTokens
            )
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(receiptHash);
        address signer = ECDSA.recover(ethHash, signature);
        if (signer != s.node) revert InvalidSignature(signer, s.node);

        uint256 price = registry.priceFor(s.node, s.backend);
        // cost = totalTokens * price / 1000 (price is per 1k tokens)
        uint256 cost = (totalTokens * price) / 1_000;
        if (cost > s.maxSpend) revert CostExceedsMaxSpend(cost, s.maxSpend);
        uint256 refund = s.maxSpend - cost;

        s.open = false;

        if (cost > 0) usdc.safeTransfer(s.node, cost);
        if (refund > 0) usdc.safeTransfer(s.client, refund);

        emit Settled(sessionId, totalTokens, cost, refund);
    }

    /// Client safety valve: if the node has gone away and never settles, the
    /// client can reclaim the full escrow once the timeout has elapsed.
    function reclaim(bytes32 sessionId) external {
        Session storage s = _sessions[sessionId];
        if (!s.open) revert SessionNotOpen();
        if (msg.sender != s.client) revert NotClient();
        uint64 reclaimAt = s.openedAt + reclaimTimeout;
        if (block.timestamp < reclaimAt) revert ReclaimTooEarly(s.openedAt, reclaimAt);

        uint256 amount = s.maxSpend;
        s.open = false;
        if (amount > 0) usdc.safeTransfer(s.client, amount);

        emit Reclaimed(sessionId, s.client, amount);
    }

    function sessions(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }
}
