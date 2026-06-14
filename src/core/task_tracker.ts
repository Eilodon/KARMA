import { ENV } from "../config/env.js";

export class TaskTracker {
  private activeTasks: Set<Promise<unknown>> = new Set();
  private draining = false;

  beginDraining(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  track(promise: Promise<unknown>, hardTimeoutMs: number = ENV.MCP_TOOL_TIMEOUT_MS + 60000): boolean {
    if (this.draining) {
      return false;
    }

    const safePromise = Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Task Hard Timeout (${hardTimeoutMs}ms)`)), hardTimeoutMs))
    ]).catch(err => {
      console.error("[SUPER-MCP] Background Task bị hủy do quá timeout hoặc lỗi:", err);
    });

    this.activeTasks.add(safePromise);
    void safePromise.finally(() => {
      this.activeTasks.delete(safePromise);
    });
    return true;
  }

  async awaitAll(timeoutMs: number = 30000): Promise<void> {
    if (this.activeTasks.size === 0) return;
    console.error(`[SUPER-MCP] Đang chờ ${this.activeTasks.size} task(s) chạy ngầm hoàn tất... (Timeout: ${timeoutMs}ms)`);
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout waiting for tasks")), timeoutMs);
    });

    try {
      await Promise.race([
        Promise.allSettled(Array.from(this.activeTasks)),
        timeoutPromise
      ]);
      if (this.activeTasks.size > 0) {
        console.error(`[SUPER-MCP] Vẫn còn ${this.activeTasks.size} task(s) sau lượt chờ đầu tiên.`);
      }
      console.error(`[SUPER-MCP] Tất cả task đã dọn dẹp xong.`);
    } catch {
      console.error(`[SUPER-MCP] Bỏ qua các task đang treo do quá thời gian chờ (Timeout).`);
    }
  }
}

export const globalTaskTracker = new TaskTracker();
