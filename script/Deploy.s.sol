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
        vm.startBroadcast(pk);
        reg = new AgentSkillRegistry();
        vm.stopBroadcast();
        console.log("AgentSkillRegistry deployed at:", address(reg));
    }
}
