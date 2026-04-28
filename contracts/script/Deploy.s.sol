// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {NodeRegistry} from "../src/NodeRegistry.sol";
import {JobChannel} from "../src/JobChannel.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deploys NodeRegistry + JobChannel.
///
/// Required env vars:
///   PRIVATE_KEY              — deployer's private key
///   MIN_STAKE                — minimum stake (raw USDC base units, 6 decimals)
///   CHALLENGE_WINDOW         — seconds an opened challenge stays contestable
///   CHANNEL_RECLAIM_TIMEOUT  — seconds before client can unilaterally reclaim
///
/// Optional:
///   USDC_ADDRESS  — pre-existing USDC. If unset, deploys MockUSDC (devnet only).
///   OWNER         — registry owner (slasher / config). Defaults to deployer.
///   REGISTRY_ADDRESS — reuse an existing NodeRegistry instead of deploying a
///                      new one. Useful when only redeploying the channel
///                      contract on Base Sepolia.
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 minStake = vm.envUint("MIN_STAKE");
        uint64 challengeWindow = uint64(vm.envUint("CHALLENGE_WINDOW"));
        uint64 reclaimTimeout = uint64(vm.envUint("CHANNEL_RECLAIM_TIMEOUT"));
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

        NodeRegistry registry;
        try vm.envAddress("REGISTRY_ADDRESS") returns (address existing) {
            registry = NodeRegistry(existing);
            console2.log("Using existing NodeRegistry", existing);
        } catch {
            vm.startBroadcast(deployerKey);
            registry = new NodeRegistry(usdc, owner, minStake);
            vm.stopBroadcast();
            console2.log("Deployed NodeRegistry", address(registry));
        }

        vm.startBroadcast(deployerKey);
        JobChannel channelContract =
            new JobChannel(registry, usdc, challengeWindow, reclaimTimeout);
        vm.stopBroadcast();

        console2.log("JobChannel  ", address(channelContract));
        console2.log("USDC        ", address(usdc));
        console2.log("Owner       ", owner);
        console2.log("ChallengeWindow ", challengeWindow);
        console2.log("ReclaimTimeout  ", reclaimTimeout);
    }
}
