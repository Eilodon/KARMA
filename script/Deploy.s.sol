// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentSkillRegistry} from "../contracts/AgentSkillRegistry.sol";

/// @notice Deploy AgentSkillRegistry to Pharos Atlantic.
/// Usage: PRIVATE_KEY=0x... forge script script/Deploy.s.sol \
///        --rpc-url $PHAROS_RPC_URL --broadcast
contract Deploy is Script {
    function run() external returns (AgentSkillRegistry reg) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        // Review window is deploy-time config (immutable afterwards). Override with
        // KARMA_REVIEW_WINDOW_SECS; defaults to 3 days. Bounded on-chain to [1h, 30d].
        uint256 reviewWindowSecs = vm.envOr("KARMA_REVIEW_WINDOW_SECS", uint256(3 days));
        vm.startBroadcast(pk);
        reg = new AgentSkillRegistry(reviewWindowSecs);
        vm.stopBroadcast();
        console.log("AgentSkillRegistry deployed at:", address(reg));
        console.log("REVIEW_WINDOW (secs):", reviewWindowSecs);
    }
}
