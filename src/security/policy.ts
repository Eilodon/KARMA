import type { ToolDefinition, ToolSecurityPolicy } from "../mcp/adapter/tool_registry.js";

export interface ToolPolicyDecision {
  allowed: boolean;
  reasons: string[];
  effectivePolicy: Required<Omit<ToolSecurityPolicy, "waiverReason">> & { waiverReason?: string };
}

function effectivePolicy<T = Record<string, unknown>>(tool: ToolDefinition<T>): ToolPolicyDecision["effectivePolicy"] {
  const declared = tool.securityPolicy || {};
  const capabilities = new Set(tool.capabilities || []);
  const accessesPrivateData = Boolean(
    declared.accessesPrivateData ||
    capabilities.has("secrets.read") ||
    capabilities.has("fs.read")
  );
  const exposesUntrustedContent = Boolean(
    declared.exposesUntrustedContent ||
    tool.annotations.openWorldHint
  );
  const externalCommunication = Boolean(
    declared.externalCommunication ||
    capabilities.has("network") ||
    capabilities.has("process.spawn")
  );
  const destructiveEffects = Boolean(
    declared.destructiveEffects ||
    tool.annotations.destructiveHint ||
    capabilities.has("fs.write") ||
    capabilities.has("secrets.write") ||
    capabilities.has("destructive")
  );

  return {
    accessesPrivateData,
    exposesUntrustedContent,
    externalCommunication,
    destructiveEffects,
    allowLethalTrifecta: Boolean(declared.allowLethalTrifecta),
    waiverReason: declared.waiverReason,
  };
}

export function evaluateToolPolicy<T = Record<string, unknown>>(tool: ToolDefinition<T>): ToolPolicyDecision {
  const policy = effectivePolicy(tool);
  const reasons: string[] = [];
  const exfiltrationTrifecta = policy.accessesPrivateData && policy.exposesUntrustedContent && policy.externalCommunication;
  const destructiveTrifecta = policy.accessesPrivateData && policy.exposesUntrustedContent && policy.destructiveEffects;

  if ((exfiltrationTrifecta || destructiveTrifecta) && !policy.allowLethalTrifecta) {
    reasons.push("lethal-trifecta policy requires an explicit waiver");
  }

  if (policy.allowLethalTrifecta && (!policy.waiverReason || policy.waiverReason.trim().length < 20)) {
    reasons.push("lethal-trifecta waiver requires a concrete waiverReason");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    effectivePolicy: policy,
  };
}

export function assertToolPolicy<T = Record<string, unknown>>(tool: ToolDefinition<T>): void {
  const decision = evaluateToolPolicy(tool);
  if (!decision.allowed) {
    throw new Error(`[KARMA] Tool '${tool.name}' rejected by security policy: ${decision.reasons.join("; ")}`);
  }
}
