// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {NodeRegistry} from "./NodeRegistry.sol";

/// @title flodex JobChannel
/// @notice Per-(client, node) USDC payment channels. Each agent request
///         produces an off-chain bilaterally-signed cumulative state
///         (nonce, cumOwed). Closing the channel submits the highest
///         signed state on-chain in a single tx — N requests amortise to 1
///         settle.
///
///         Two close paths:
///           * cooperative — both sigs supplied, instant payout.
///           * challenge   — one party submits, the other has
///             challengeWindow seconds to override with a higher-nonce
///             state. After the deadline, finalize() pays the latest.
///
///         Reclaim refunds the full deposit unilaterally to the client
///         after reclaimTimeout — the safety valve when the node disappears.
contract JobChannel {
    using SafeERC20 for IERC20;

    /// keccak256("flodex-v0-channel-update"). Off-chain code (Rust + TS) builds
    /// abi.encode(CHANNEL_UPDATE_DOMAIN, chainid, address(this), channelId,
    /// nonce, cumOwed) — six fixed 32-byte slots — keccak's the result, then
    /// EIP-191 wraps. Encoding the domain as bytes32 (precomputed hash)
    /// instead of a string keeps the layout deterministic across Rust/TS
    /// without an ABI encoder dep.
    bytes32 public constant CHANNEL_UPDATE_DOMAIN =
        keccak256("flodex-v0-channel-update");

    enum Status {
        None,
        Open,
        Challenged,
        Closed
    }

    struct Channel {
        address client;
        address node;
        uint256 deposit;
        uint256 latestCumOwed;
        uint64 latestNonce;
        uint64 challengeDeadline;
        uint64 openedAt;
        Status status;
    }

    NodeRegistry public immutable registry;
    IERC20 public immutable usdc;
    /// Time after challengeClose during which submitChallenge can override.
    uint64 public immutable challengeWindow;
    /// Time after open before client can unilaterally reclaim full deposit.
    uint64 public immutable reclaimTimeout;

    mapping(bytes32 => Channel) private _channels;

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed client,
        address indexed node,
        uint64 channelNonce,
        uint256 deposit
    );
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 newDeposit);
    event ChannelChallenged(
        bytes32 indexed channelId, uint64 nonce, uint256 cumOwed, uint64 deadline
    );
    event ChannelClosed(
        bytes32 indexed channelId, uint64 finalNonce, uint256 paid, uint256 refunded
    );
    event ChannelReclaimed(bytes32 indexed channelId, uint256 amount);

    error ChannelExists();
    error ChannelNotOpen();
    error ChannelNotChallengeable();
    error ChannelNotFinalizable();
    error NodeNotActive();
    error NotClient();
    error StaleNonce(uint64 supplied, uint64 latest);
    error InvalidClientSig(address recovered, address expected);
    error InvalidNodeSig(address recovered, address expected);
    error ChallengeWindowOpen(uint64 deadline);
    error ChallengeWindowClosed(uint64 deadline);
    error ReclaimTooEarly(uint64 reclaimAt);

    constructor(
        NodeRegistry _registry,
        IERC20 _usdc,
        uint64 _challengeWindow,
        uint64 _reclaimTimeout
    ) {
        registry = _registry;
        usdc = _usdc;
        challengeWindow = _challengeWindow;
        reclaimTimeout = _reclaimTimeout;
    }

    /// Deterministic channel id so off-chain code can derive it without a
    /// pre-flight tx. channelNonce is a per-pair counter so a (client, node)
    /// pair can open sequential channels (close, then re-open at nonce+1).
    function channelIdOf(address client, address node, uint64 channelNonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(client, node, channelNonce));
    }

    function openChannel(address node, uint64 channelNonce, uint256 deposit)
        external
        returns (bytes32)
    {
        bytes32 id = channelIdOf(msg.sender, node, channelNonce);
        Channel storage c = _channels[id];
        if (c.status != Status.None) revert ChannelExists();
        if (!registry.isActive(node)) revert NodeNotActive();

        usdc.safeTransferFrom(msg.sender, address(this), deposit);

        c.client = msg.sender;
        c.node = node;
        c.deposit = deposit;
        c.openedAt = uint64(block.timestamp);
        c.status = Status.Open;

        emit ChannelOpened(id, msg.sender, node, channelNonce, deposit);
        return id;
    }

    function topUp(bytes32 channelId, uint256 amount) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Open) revert ChannelNotOpen();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        c.deposit += amount;
        emit ChannelToppedUp(channelId, amount, c.deposit);
    }

    /// Both parties have signed the same (nonce, cumOwed) — close instantly.
    /// Callable by anyone holding the sigs (typically a participant).
    function cooperativeClose(
        bytes32 channelId,
        uint64 nonce,
        uint256 cumOwed,
        bytes calldata clientSig,
        bytes calldata nodeSig
    ) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Open && c.status != Status.Challenged) {
            revert ChannelNotOpen();
        }
        if (nonce < c.latestNonce) revert StaleNonce(nonce, c.latestNonce);

        _verifySigs(channelId, nonce, cumOwed, clientSig, nodeSig, c.client, c.node);

        c.latestNonce = nonce;
        c.latestCumOwed = cumOwed;
        _settle(channelId, c);
    }

    /// One-sided submission with both sigs — opens a window for the
    /// counterparty to override with a higher-nonce signed state.
    function challengeClose(
        bytes32 channelId,
        uint64 nonce,
        uint256 cumOwed,
        bytes calldata clientSig,
        bytes calldata nodeSig
    ) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Open) revert ChannelNotOpen();

        _verifySigs(channelId, nonce, cumOwed, clientSig, nodeSig, c.client, c.node);

        c.latestNonce = nonce;
        c.latestCumOwed = cumOwed;
        c.challengeDeadline = uint64(block.timestamp) + challengeWindow;
        c.status = Status.Challenged;

        emit ChannelChallenged(channelId, nonce, cumOwed, c.challengeDeadline);
    }

    /// During the challenge window, override with a strictly higher-nonce
    /// state. Both sigs still required (the on-chain truth is "what both
    /// parties signed"; the challenge race is just about which signed state
    /// was the latest).
    function submitChallenge(
        bytes32 channelId,
        uint64 nonce,
        uint256 cumOwed,
        bytes calldata clientSig,
        bytes calldata nodeSig
    ) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Challenged) revert ChannelNotChallengeable();
        if (block.timestamp >= c.challengeDeadline) {
            revert ChallengeWindowClosed(c.challengeDeadline);
        }
        if (nonce <= c.latestNonce) revert StaleNonce(nonce, c.latestNonce);

        _verifySigs(channelId, nonce, cumOwed, clientSig, nodeSig, c.client, c.node);

        c.latestNonce = nonce;
        c.latestCumOwed = cumOwed;

        emit ChannelChallenged(channelId, nonce, cumOwed, c.challengeDeadline);
    }

    /// After the challenge window, anyone can finalize — pays the node from
    /// latestCumOwed (capped at deposit), refunds the rest to the client.
    function finalize(bytes32 channelId) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Challenged) revert ChannelNotFinalizable();
        if (block.timestamp < c.challengeDeadline) {
            revert ChallengeWindowOpen(c.challengeDeadline);
        }
        _settle(channelId, c);
    }

    /// Client safety valve: full refund after reclaimTimeout if the node
    /// never engages. Only valid in Open status (challengeClose preempts).
    function reclaim(bytes32 channelId) external {
        Channel storage c = _channels[channelId];
        if (c.status != Status.Open) revert ChannelNotOpen();
        if (msg.sender != c.client) revert NotClient();
        uint64 reclaimAt = c.openedAt + reclaimTimeout;
        if (block.timestamp < reclaimAt) revert ReclaimTooEarly(reclaimAt);

        uint256 amount = c.deposit;
        c.deposit = 0;
        c.status = Status.Closed;

        if (amount > 0) usdc.safeTransfer(c.client, amount);
        emit ChannelReclaimed(channelId, amount);
    }

    // --- Views ---

    function channels(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    /// Builds the EIP-191-prefixed digest both parties sign over. Exposed so
    /// off-chain tooling can sanity-check its layout against the contract.
    function updateDigest(bytes32 channelId, uint64 nonce, uint256 cumOwed)
        public
        view
        returns (bytes32)
    {
        bytes32 hash = keccak256(
            abi.encode(
                CHANNEL_UPDATE_DOMAIN,
                block.chainid,
                address(this),
                channelId,
                nonce,
                cumOwed
            )
        );
        return MessageHashUtils.toEthSignedMessageHash(hash);
    }

    // --- Internal ---

    function _verifySigs(
        bytes32 channelId,
        uint64 nonce,
        uint256 cumOwed,
        bytes calldata clientSig,
        bytes calldata nodeSig,
        address expectedClient,
        address expectedNode
    ) internal view {
        bytes32 ethHash = updateDigest(channelId, nonce, cumOwed);
        address recoveredClient = ECDSA.recover(ethHash, clientSig);
        if (recoveredClient != expectedClient) {
            revert InvalidClientSig(recoveredClient, expectedClient);
        }
        address recoveredNode = ECDSA.recover(ethHash, nodeSig);
        if (recoveredNode != expectedNode) {
            revert InvalidNodeSig(recoveredNode, expectedNode);
        }
    }

    function _settle(bytes32 channelId, Channel storage c) internal {
        uint256 deposit = c.deposit;
        uint256 paid = c.latestCumOwed;
        if (paid > deposit) paid = deposit;
        uint256 refund = deposit - paid;

        c.status = Status.Closed;
        c.deposit = 0;

        if (paid > 0) usdc.safeTransfer(c.node, paid);
        if (refund > 0) usdc.safeTransfer(c.client, refund);

        emit ChannelClosed(channelId, c.latestNonce, paid, refund);
    }
}
