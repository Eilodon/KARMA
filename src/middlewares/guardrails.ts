import type { Phase } from "../types/schemas.js";

/**
 * Execution flow protection (Extracted from VECTOR).
 * Prevents LLMs from calling Tools when not in the appropriate Phase.
 */
export class PhaseGuardrails {
  ensureToolPhase(toolName: string, currentPhase: Phase, allowedPhases: Phase[]): void {
    if (!allowedPhases.includes(currentPhase)) {
      throw new Error(`[KARMA] Guardrail Error: Tool '${toolName}' is not allowed to run in phase '${currentPhase}'. Must be in phases: ${allowedPhases.join(", ")}`);
    }
  }
}

export const globalGuardrails = new PhaseGuardrails();
