// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract NodeRegistryTest is Test {
    MockUSDC internal usdc;
    NodeRegistry internal registry;

    address internal owner = address(0xA11CE);
    address internal node = address(0xB0B);
    address internal escrowSentinel = address(0xE5C0);

    uint256 internal constant MIN_STAKE = 100e6; // 100 USDC
    uint256 internal constant NODE_FUND = 1_000e6;

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        registry = new NodeRegistry(usdc, owner, MIN_STAKE);
        vm.prank(owner);
        registry.setEscrow(escrowSentinel);

        usdc.mint(node, NODE_FUND);
        vm.prank(node);
        usdc.approve(address(registry), type(uint256).max);
    }

    function _defaultPricing() internal pure returns (uint256[4] memory p) {
        p[0] = 15_000; // mock-tee: $0.015 / 1k tokens (in micro-USDC)
        p[1] = 0;
        p[2] = 0;
        p[3] = 5_000; // local: $0.005 / 1k tokens
    }

    function _register(address who, uint256 stake) internal {
        uint256[4] memory pricing = _defaultPricing();
        vm.prank(who);
        registry.register(
            "https://node.example",
            bytes32(uint256(0xCAFE)),
            uint8(0x9), // mock-tee + local
            uint64(100_000),
            pricing,
            stake
        );
    }

    function test_register_storesAndPullsStake() public {
        _register(node, 200e6);

        NodeRegistry.Node memory n = registry.nodes(node);
        assertTrue(n.active);
        assertEq(n.stake, 200e6);
        assertEq(n.url, "https://node.example");
        assertEq(n.maxTokens, 100_000);
        assertEq(n.backendBitmap, uint8(0x9));
        assertEq(usdc.balanceOf(address(registry)), 200e6);
        assertEq(usdc.balanceOf(node), NODE_FUND - 200e6);
        assertEq(registry.nodeCount(), 1);
    }

    function test_register_revertsBelowMinStake() public {
        uint256[4] memory pricing = _defaultPricing();
        vm.prank(node);
        vm.expectRevert(
            abi.encodeWithSelector(NodeRegistry.StakeBelowMin.selector, 50e6, MIN_STAKE)
        );
        registry.register(
            "https://node.example", bytes32(0), uint8(1), uint64(1), pricing, 50e6
        );
    }

    function test_register_revertsIfAlreadyActive() public {
        _register(node, 200e6);
        uint256[4] memory pricing = _defaultPricing();
        vm.prank(node);
        vm.expectRevert(NodeRegistry.AlreadyRegistered.selector);
        registry.register(
            "https://other", bytes32(0), uint8(1), uint64(1), pricing, 200e6
        );
    }

    function test_priceFor_andSupportsBackend() public {
        _register(node, 200e6);
        assertEq(registry.priceFor(node, NodeRegistry.Backend.MockTee), 15_000);
        assertEq(registry.priceFor(node, NodeRegistry.Backend.Local), 5_000);
        assertTrue(registry.supportsBackend(node, NodeRegistry.Backend.MockTee));
        assertFalse(registry.supportsBackend(node, NodeRegistry.Backend.Fhe));
        assertTrue(registry.supportsBackend(node, NodeRegistry.Backend.Local));
    }

    function test_update_changesMetadataLeavesStake() public {
        _register(node, 200e6);

        uint256[4] memory pricing;
        pricing[0] = 20_000;
        vm.prank(node);
        registry.update(
            "https://updated", bytes32(uint256(0xBEEF)), uint8(0x1), uint64(50_000), pricing
        );

        NodeRegistry.Node memory n = registry.nodes(node);
        assertEq(n.url, "https://updated");
        assertEq(n.ecdhPubkey, bytes32(uint256(0xBEEF)));
        assertEq(n.backendBitmap, uint8(0x1));
        assertEq(n.maxTokens, 50_000);
        assertEq(n.stake, 200e6); // unchanged
        assertEq(registry.priceFor(node, NodeRegistry.Backend.MockTee), 20_000);
    }

    function test_unregister_returnsStake() public {
        _register(node, 200e6);
        vm.prank(node);
        registry.unregister();

        NodeRegistry.Node memory n = registry.nodes(node);
        assertFalse(n.active);
        assertEq(n.stake, 0);
        assertEq(usdc.balanceOf(node), NODE_FUND);
        assertEq(registry.nodeCount(), 0);
    }

    function test_slash_byEscrow_payOut() public {
        _register(node, 200e6);
        address recipient = address(0xDEAD);
        vm.prank(escrowSentinel);
        registry.slash(node, recipient, 50e6);

        NodeRegistry.Node memory n = registry.nodes(node);
        assertEq(n.stake, 150e6);
        assertTrue(n.active);
        assertEq(usdc.balanceOf(recipient), 50e6);
    }

    function test_slash_drainsStakeMarksInactive() public {
        _register(node, 200e6);
        address recipient = address(0xDEAD);
        vm.prank(escrowSentinel);
        registry.slash(node, recipient, 200e6);

        NodeRegistry.Node memory n = registry.nodes(node);
        assertEq(n.stake, 0);
        assertFalse(n.active);
        assertEq(registry.nodeCount(), 0);
        assertEq(usdc.balanceOf(recipient), 200e6);
    }

    function test_slash_unauthorizedReverts() public {
        _register(node, 200e6);
        vm.prank(address(0xBAD));
        vm.expectRevert(NodeRegistry.NotAuthorized.selector);
        registry.slash(node, address(this), 1);
    }

    function test_slash_amountExceedsStakeReverts() public {
        _register(node, 200e6);
        vm.prank(escrowSentinel);
        vm.expectRevert(
            abi.encodeWithSelector(NodeRegistry.AmountExceedsStake.selector, 300e6, 200e6)
        );
        registry.slash(node, address(this), 300e6);
    }

    function test_setEscrow_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(NodeRegistry.NotOwner.selector);
        registry.setEscrow(address(0x1));

        vm.prank(owner);
        registry.setEscrow(address(0x123));
        assertEq(registry.escrow(), address(0x123));
    }
}
