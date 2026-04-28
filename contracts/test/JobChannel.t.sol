// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {JobChannel} from "../src/JobChannel.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract JobChannelTest is Test {
    MockUSDC internal usdc;
    NodeRegistry internal registry;
    JobChannel internal channelContract;

    address internal owner = address(0xA11CE);
    uint256 internal nodeKey;
    address internal node;
    uint256 internal clientKey;
    address internal client;

    uint256 internal constant MIN_STAKE = 100e6;
    uint64 internal constant CHALLENGE_WINDOW = 1 hours;
    uint64 internal constant RECLAIM_TIMEOUT = 24 hours;

    uint64 internal constant CHANNEL_NONCE = 0;

    function setUp() public {
        usdc = new MockUSDC();
        nodeKey = 0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1;
        node = vm.addr(nodeKey);
        clientKey = 0xC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11EC11E;
        client = vm.addr(clientKey);

        vm.prank(owner);
        registry = new NodeRegistry(usdc, owner, MIN_STAKE);
        channelContract = new JobChannel(registry, usdc, CHALLENGE_WINDOW, RECLAIM_TIMEOUT);

        // Fund + register the node.
        usdc.mint(node, 1_000e6);
        vm.prank(node);
        usdc.approve(address(registry), type(uint256).max);
        uint256[4] memory pricing;
        pricing[0] = 15_000;
        vm.prank(node);
        registry.register(
            "https://node.example",
            bytes32(uint256(0xCAFE)),
            uint8(0x1),
            uint64(100_000),
            pricing,
            200e6
        );

        // Fund + approve client.
        usdc.mint(client, 1_000e6);
        vm.prank(client);
        usdc.approve(address(channelContract), type(uint256).max);
    }

    function _channelId() internal view returns (bytes32) {
        return channelContract.channelIdOf(client, node, CHANNEL_NONCE);
    }

    function _sign(uint256 key, bytes32 channelId, uint64 nonce, uint256 cumOwed)
        internal
        view
        returns (bytes memory)
    {
        bytes32 ethHash = channelContract.updateDigest(channelId, nonce, cumOwed);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _open(uint256 deposit) internal returns (bytes32) {
        vm.prank(client);
        return channelContract.openChannel(node, CHANNEL_NONCE, deposit);
    }

    // --- open ---

    function test_openChannel_locksDeposit() public {
        bytes32 id = _open(50e6);
        assertEq(usdc.balanceOf(address(channelContract)), 50e6);
        assertEq(usdc.balanceOf(client), 1_000e6 - 50e6);

        JobChannel.Channel memory c = channelContract.channels(id);
        assertEq(uint8(c.status), uint8(JobChannel.Status.Open));
        assertEq(c.client, client);
        assertEq(c.node, node);
        assertEq(c.deposit, 50e6);
        assertEq(c.latestNonce, 0);
        assertEq(c.latestCumOwed, 0);
    }

    function test_openChannel_revertsExisting() public {
        _open(50e6);
        vm.prank(client);
        vm.expectRevert(JobChannel.ChannelExists.selector);
        channelContract.openChannel(node, CHANNEL_NONCE, 50e6);
    }

    function test_openChannel_revertsNodeNotActive() public {
        // Slash to drain stake → node inactive.
        vm.prank(owner);
        registry.setEscrow(address(this));
        registry.slash(node, address(0xDEAD), 200e6);

        vm.prank(client);
        vm.expectRevert(JobChannel.NodeNotActive.selector);
        channelContract.openChannel(node, CHANNEL_NONCE, 50e6);
    }

    // --- topUp ---

    function test_topUp_increasesDeposit() public {
        bytes32 id = _open(20e6);
        vm.prank(client);
        channelContract.topUp(id, 30e6);
        assertEq(channelContract.channels(id).deposit, 50e6);
        assertEq(usdc.balanceOf(address(channelContract)), 50e6);
    }

    function test_topUp_revertsNotOpen() public {
        bytes32 id = _open(20e6);
        bytes memory cs = _sign(clientKey, id, 0, 0);
        bytes memory ns = _sign(nodeKey, id, 0, 0);
        channelContract.cooperativeClose(id, 0, 0, cs, ns);

        vm.prank(client);
        vm.expectRevert(JobChannel.ChannelNotOpen.selector);
        channelContract.topUp(id, 1e6);
    }

    // --- cooperativeClose ---

    function test_cooperativeClose_paysAndRefunds() public {
        bytes32 id = _open(50e6);
        uint64 nonce = 7;
        uint256 cumOwed = 12e6;
        bytes memory cs = _sign(clientKey, id, nonce, cumOwed);
        bytes memory ns = _sign(nodeKey, id, nonce, cumOwed);

        uint256 nodeBefore = usdc.balanceOf(node);
        uint256 clientBefore = usdc.balanceOf(client);

        channelContract.cooperativeClose(id, nonce, cumOwed, cs, ns);

        assertEq(usdc.balanceOf(node), nodeBefore + cumOwed);
        assertEq(usdc.balanceOf(client), clientBefore + (50e6 - cumOwed));
        JobChannel.Channel memory c = channelContract.channels(id);
        assertEq(uint8(c.status), uint8(JobChannel.Status.Closed));
        assertEq(c.deposit, 0);
        assertEq(c.latestNonce, nonce);
    }

    function test_cooperativeClose_revertsBadClientSig() public {
        bytes32 id = _open(50e6);
        uint64 nonce = 1;
        uint256 cumOwed = 1e6;
        // Forge client sig with a wrong key.
        bytes memory cs = _sign(uint256(0xBEEF), id, nonce, cumOwed);
        bytes memory ns = _sign(nodeKey, id, nonce, cumOwed);
        vm.expectRevert();
        channelContract.cooperativeClose(id, nonce, cumOwed, cs, ns);
    }

    function test_cooperativeClose_revertsBadNodeSig() public {
        bytes32 id = _open(50e6);
        uint64 nonce = 1;
        uint256 cumOwed = 1e6;
        bytes memory cs = _sign(clientKey, id, nonce, cumOwed);
        bytes memory ns = _sign(uint256(0xBEEF), id, nonce, cumOwed);
        vm.expectRevert();
        channelContract.cooperativeClose(id, nonce, cumOwed, cs, ns);
    }

    function test_cooperativeClose_capsAtDeposit() public {
        // cumOwed > deposit — node gets capped at deposit, client refund 0.
        bytes32 id = _open(50e6);
        uint64 nonce = 9;
        uint256 cumOwed = 1_000e6; // more than deposit
        bytes memory cs = _sign(clientKey, id, nonce, cumOwed);
        bytes memory ns = _sign(nodeKey, id, nonce, cumOwed);

        uint256 nodeBefore = usdc.balanceOf(node);
        uint256 clientBefore = usdc.balanceOf(client);
        channelContract.cooperativeClose(id, nonce, cumOwed, cs, ns);
        assertEq(usdc.balanceOf(node), nodeBefore + 50e6);
        assertEq(usdc.balanceOf(client), clientBefore); // no refund
    }

    function test_cooperativeClose_revertsStaleNonce() public {
        bytes32 id = _open(50e6);
        // First, challenge with nonce=5
        uint64 nonce5 = 5;
        uint256 owed5 = 5e6;
        bytes memory cs5 = _sign(clientKey, id, nonce5, owed5);
        bytes memory ns5 = _sign(nodeKey, id, nonce5, owed5);
        channelContract.challengeClose(id, nonce5, owed5, cs5, ns5);

        // Now try cooperativeClose with stale nonce=3
        uint64 nonce3 = 3;
        uint256 owed3 = 3e6;
        bytes memory cs3 = _sign(clientKey, id, nonce3, owed3);
        bytes memory ns3 = _sign(nodeKey, id, nonce3, owed3);
        vm.expectRevert();
        channelContract.cooperativeClose(id, nonce3, owed3, cs3, ns3);
    }

    // --- challengeClose / submitChallenge / finalize ---

    function test_challengeClose_opensWindow() public {
        bytes32 id = _open(50e6);
        uint64 nonce = 3;
        uint256 owed = 3e6;
        bytes memory cs = _sign(clientKey, id, nonce, owed);
        bytes memory ns = _sign(nodeKey, id, nonce, owed);
        channelContract.challengeClose(id, nonce, owed, cs, ns);

        JobChannel.Channel memory c = channelContract.channels(id);
        assertEq(uint8(c.status), uint8(JobChannel.Status.Challenged));
        assertEq(c.latestNonce, nonce);
        assertEq(c.latestCumOwed, owed);
        assertEq(c.challengeDeadline, uint64(block.timestamp) + CHALLENGE_WINDOW);
    }

    function test_submitChallenge_higherNonceWins() public {
        bytes32 id = _open(50e6);
        // Initial challenge at nonce=3.
        bytes memory cs3 = _sign(clientKey, id, 3, 3e6);
        bytes memory ns3 = _sign(nodeKey, id, 3, 3e6);
        channelContract.challengeClose(id, 3, 3e6, cs3, ns3);

        // Counter with nonce=5.
        bytes memory cs5 = _sign(clientKey, id, 5, 5e6);
        bytes memory ns5 = _sign(nodeKey, id, 5, 5e6);
        channelContract.submitChallenge(id, 5, 5e6, cs5, ns5);

        JobChannel.Channel memory c = channelContract.channels(id);
        assertEq(c.latestNonce, 5);
        assertEq(c.latestCumOwed, 5e6);
    }

    function test_submitChallenge_revertsNotHigher() public {
        bytes32 id = _open(50e6);
        bytes memory cs = _sign(clientKey, id, 5, 5e6);
        bytes memory ns = _sign(nodeKey, id, 5, 5e6);
        channelContract.challengeClose(id, 5, 5e6, cs, ns);

        // Equal nonce — must revert.
        bytes memory csEq = _sign(clientKey, id, 5, 6e6);
        bytes memory nsEq = _sign(nodeKey, id, 5, 6e6);
        vm.expectRevert();
        channelContract.submitChallenge(id, 5, 6e6, csEq, nsEq);
    }

    function test_submitChallenge_revertsAfterDeadline() public {
        bytes32 id = _open(50e6);
        bytes memory cs = _sign(clientKey, id, 3, 3e6);
        bytes memory ns = _sign(nodeKey, id, 3, 3e6);
        channelContract.challengeClose(id, 3, 3e6, cs, ns);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        bytes memory cs5 = _sign(clientKey, id, 5, 5e6);
        bytes memory ns5 = _sign(nodeKey, id, 5, 5e6);
        vm.expectRevert();
        channelContract.submitChallenge(id, 5, 5e6, cs5, ns5);
    }

    function test_finalize_afterWindow() public {
        bytes32 id = _open(50e6);
        bytes memory cs = _sign(clientKey, id, 4, 4e6);
        bytes memory ns = _sign(nodeKey, id, 4, 4e6);
        channelContract.challengeClose(id, 4, 4e6, cs, ns);

        // Too early.
        vm.expectRevert();
        channelContract.finalize(id);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        uint256 nodeBefore = usdc.balanceOf(node);
        uint256 clientBefore = usdc.balanceOf(client);
        channelContract.finalize(id);

        assertEq(usdc.balanceOf(node), nodeBefore + 4e6);
        assertEq(usdc.balanceOf(client), clientBefore + (50e6 - 4e6));
        assertEq(uint8(channelContract.channels(id).status), uint8(JobChannel.Status.Closed));
    }

    // --- reclaim ---

    function test_reclaim_afterTimeout() public {
        bytes32 id = _open(50e6);
        // Just before timeout — reverts.
        vm.warp(block.timestamp + RECLAIM_TIMEOUT - 1);
        vm.prank(client);
        vm.expectRevert();
        channelContract.reclaim(id);

        // At timeout — succeeds.
        vm.warp(block.timestamp + 2);
        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        channelContract.reclaim(id);
        assertEq(usdc.balanceOf(client), before + 50e6);
        assertEq(uint8(channelContract.channels(id).status), uint8(JobChannel.Status.Closed));
    }

    function test_reclaim_onlyClient() public {
        bytes32 id = _open(50e6);
        vm.warp(block.timestamp + RECLAIM_TIMEOUT + 1);
        vm.prank(address(0xBAD));
        vm.expectRevert(JobChannel.NotClient.selector);
        channelContract.reclaim(id);
    }

    function test_reclaim_revertsAfterChallenge() public {
        bytes32 id = _open(50e6);
        bytes memory cs = _sign(clientKey, id, 1, 1e6);
        bytes memory ns = _sign(nodeKey, id, 1, 1e6);
        channelContract.challengeClose(id, 1, 1e6, cs, ns);

        vm.warp(block.timestamp + RECLAIM_TIMEOUT + 1);
        vm.prank(client);
        vm.expectRevert();
        channelContract.reclaim(id);
    }
}
