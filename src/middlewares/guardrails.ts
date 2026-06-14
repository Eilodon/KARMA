import type { Phase } from "../types/schemas.js";

/**
 * Bảo vệ luồng thực thi (Trích xuất từ VECTOR).
 * Chặn không cho LLM gọi các Tool khi chưa ở đúng Phase tương ứng.
 */
export class PhaseGuardrails {
  ensureToolPhase(toolName: string, currentPhase: Phase, allowedPhases: Phase[]): void {
    if (!allowedPhases.includes(currentPhase)) {
      throw new Error(`[SUPER-MCP] Lỗi Guardrail: Tool '${toolName}' không được phép chạy ở phase '${currentPhase}'. Cần thuộc các phase: ${allowedPhases.join(", ")}`);
    }
  }
}

export const globalGuardrails = new PhaseGuardrails();
