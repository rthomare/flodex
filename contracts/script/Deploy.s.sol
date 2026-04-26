// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deploys NodeRegistry + JobEscrow.
///
/// Required env vars:
///   PRIVATE_KEY      — deployer's private key
///   MIN_STAKE        — minimum stake (in raw USDC units, 6 decimals)
///   RECLAIM_TIMEOUT  — seconds before client can reclaim a stuck session
///
/// Optional:
///   USDC_ADDRESS     — pre-existing USDC on the target chain. If unset, a
///                      MockUSDC is deployed (devnet only).
///   OWNER            — registry owner (slasher / config). Defaults to deployer.
///
/// Usage (local Anvil):
///   anvil &
///   PRIVATE_KEY=$(cast wallet new --json | jq -r '.[0].private_key') \
///   MIN_STAKE=100000000 RECLAIM_TIMEOUT=3600 \
///   forge script script/Deploy.s.sol:Deploy --rpc-url http://localhost:8545 --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 minStake = vm.envUint("MIN_STAKE");
        uint64 reclaimTimeout = uint64(vm.envUint("RECLAIM_TIMEOUT"));
        address owner = vm.envOr("OWNER", vm.addr(deployerKey));

        IERC20 usdc;
        try vm.envAddress("USDC_ADDRESS") returns (address existing) {
            usdc = IERC20(existing);
            console2.log("Using existing USDC", existing);
        } catch {
            vm.startBroadcast(deployerKey);
            MockUSDC mock = new MockUSDC();
            vm.stopBroadcast();
            usdc = IERC20(address(mock));
            console2.log("Deployed MockUSDC", address(mock));
        }

        vm.startBroadcast(deployerKey);
        NodeRegistry registry = new NodeRegistry(usdc, owner, minStake);
        JobEscrow escrow = new JobEscrow(registry, usdc, reclaimTimeout);
        // Wire escrow into registry so it can slash. setEscrow is owner-only;
        // when OWNER is set to a different address we can't auto-wire here —
        // the owner has to make the call themselves afterwards.
        if (owner == vm.addr(deployerKey)) {
            registry.setEscrow(address(escrow));
        }
        vm.stopBroadcast();

        console2.log("NodeRegistry", address(registry));
        console2.log("JobEscrow   ", address(escrow));
        console2.log("USDC        ", address(usdc));
        console2.log("Owner       ", owner);
        if (owner != vm.addr(deployerKey)) {
            console2.log("WARN: registry.setEscrow not called - owner must call manually");
        }
    }
}
