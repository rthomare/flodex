// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract JobEscrowTest is Test {
    MockUSDC internal usdc;
    NodeRegistry internal registry;
    JobEscrow internal escrow;

    address internal owner = address(0xA11CE);
    uint256 internal nodeKey;
    address internal node;
    address internal client = address(0xC11E);

    uint256 internal constant MIN_STAKE = 100e6;
    uint64 internal constant RECLAIM_TIMEOUT = 1 hours;

    function setUp() public {
        usdc = new MockUSDC();
        nodeKey = 0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1;
        node = vm.addr(nodeKey);

        vm.prank(owner);
        registry = new NodeRegistry(usdc, owner, MIN_STAKE);
        escrow = new JobEscrow(registry, usdc, RECLAIM_TIMEOUT);
        vm.prank(owner);
        registry.setEscrow(address(escrow));

        // Fund + register the node.
        usdc.mint(node, 1_000e6);
        vm.prank(node);
        usdc.approve(address(registry), type(uint256).max);
        uint256[4] memory pricing;
        pricing[0] = 15_000; // mock-tee: 15_000 micro-USDC per 1k tokens = $0.015/k
        vm.prank(node);
        registry.register(
            "https://node.example",
            bytes32(uint256(0xCAFE)),
            uint8(0x1), // bit 0 = mock-tee only
            uint64(100_000),
            pricing,
            200e6
        );

        // Fund + approve client.
        usdc.mint(client, 1_000e6);
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _signReceipt(bytes32 sessionId, uint256 totalTokens) internal view returns (bytes memory) {
        bytes32 receiptHash = keccak256(
            abi.encode(
                escrow.RECEIPT_DOMAIN(), block.chainid, address(escrow), sessionId, totalTokens
            )
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(receiptHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(nodeKey, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function test_openSession_locksFunds() public {
        bytes32 sid = keccak256("session-1");
        vm.prank(client);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);

        assertEq(usdc.balanceOf(address(escrow)), 50e6);
        assertEq(usdc.balanceOf(client), 1_000e6 - 50e6);
        JobEscrow.Session memory s = escrow.sessions(sid);
        assertTrue(s.open);
        assertEq(s.client, client);
        assertEq(s.node, node);
        assertEq(s.maxSpend, 50e6);
    }

    function test_openSession_revertsBackendNotSupported() public {
        bytes32 sid = keccak256("session-bad-backend");
        vm.prank(client);
        vm.expectRevert(JobEscrow.BackendNotSupported.selector);
        escrow.openSession(sid, node, NodeRegistry.Backend.Local, 50e6);
    }

    function test_openSession_revertsNodeNotActive() public {
        // Slash the node to drain stake → inactive.
        vm.prank(owner);
        registry.slash(node, address(0xDEAD), 200e6);

        bytes32 sid = keccak256("session-dead-node");
        vm.prank(client);
        vm.expectRevert(JobEscrow.NodeNotActive.selector);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);
    }

    function test_settle_paysNodeRefundsClient() public {
        bytes32 sid = keccak256("session-2");
        vm.prank(client);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);

        // 1000 tokens × $0.015/1k = $0.015 = 15_000 micro-USDC.
        uint256 totalTokens = 1_000;
        bytes memory sig = _signReceipt(sid, totalTokens);

        uint256 nodeBalBefore = usdc.balanceOf(node);
        uint256 clientBalBefore = usdc.balanceOf(client);

        escrow.settle(sid, totalTokens, sig);

        uint256 expectedCost = 15_000;
        assertEq(usdc.balanceOf(node), nodeBalBefore + expectedCost);
        assertEq(usdc.balanceOf(client), clientBalBefore + (50e6 - expectedCost));
        assertFalse(escrow.sessions(sid).open);
    }

    function test_settle_revertsBadSignature() public {
        bytes32 sid = keccak256("session-3");
        vm.prank(client);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);

        // Sign with a different private key — recovered signer won't match node.
        uint256 wrongKey = 0xBEEF;
        bytes32 receiptHash = keccak256(
            abi.encode(
                escrow.RECEIPT_DOMAIN(), block.chainid, address(escrow), sid, uint256(1_000)
            )
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(receiptHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(); // InvalidSignature
        escrow.settle(sid, 1_000, sig);
    }

    function test_settle_revertsCostExceedsMaxSpend() public {
        bytes32 sid = keccak256("session-4");
        vm.prank(client);
        // Open with very small maxSpend — even tiny usage will overflow it.
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 5_000);

        uint256 totalTokens = 1_000; // costs 15_000, > 5_000 maxSpend
        bytes memory sig = _signReceipt(sid, totalTokens);

        vm.expectRevert();
        escrow.settle(sid, totalTokens, sig);
    }

    function test_reclaim_afterTimeout() public {
        bytes32 sid = keccak256("session-stuck");
        vm.prank(client);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);

        // Just before timeout — should still revert.
        vm.warp(block.timestamp + RECLAIM_TIMEOUT - 1);
        vm.prank(client);
        vm.expectRevert();
        escrow.reclaim(sid);

        // At timeout — succeeds.
        vm.warp(block.timestamp + 2);
        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        escrow.reclaim(sid);
        assertEq(usdc.balanceOf(client), before + 50e6);
        assertFalse(escrow.sessions(sid).open);
    }

    function test_reclaim_onlyClient() public {
        bytes32 sid = keccak256("session-reclaim-stranger");
        vm.prank(client);
        escrow.openSession(sid, node, NodeRegistry.Backend.MockTee, 50e6);

        vm.warp(block.timestamp + RECLAIM_TIMEOUT + 1);
        vm.prank(address(0xBAD));
        vm.expectRevert(JobEscrow.NotClient.selector);
        escrow.reclaim(sid);
    }
}
