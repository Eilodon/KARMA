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

  /**
   * Fix 4 (ADR-006): accepts a *thunk*, not an already-running promise, so the
   * draining check and the decision to start the work are atomic — when the server
   * is draining the operation is never started (closes the track-after-start TOCTOU).
   * The caller is responsible for cleaning up any pre-created handles on a `false`.
   */
  track(start: () => Promise<unknown>, hardTimeoutMs: number = ENV.MCP_TOOL_TIMEOUT_MS + 60000): boolean {
    if (this.draining) {
      return false;
    }

    // Fix 4: hold the timer handle so it can be cleared once the task settles.
    // Previously the setTimeout was never cleared, leaking one timer + the rejected
    // promise closure per task for the full hardTimeoutMs (default ~6 min).
    let timer: NodeJS.Timeout | undefined;
    const safePromise = Promise.race([
      start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Task Hard Timeout (${hardTimeoutMs}ms)`)), hardTimeoutMs);
        timer.unref?.();
      })
    ]).catch(err => {
      console.error("[KARMA] Background Task cancelled due to timeout or error:", err);
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });

    this.activeTasks.add(safePromise);
    void safePromise.finally(() => {
      this.activeTasks.delete(safePromise);
    });
    return true;
  }

  async awaitAll(timeoutMs: number = 30000): Promise<void> {
    if (this.activeTasks.size === 0) return;
    console.error(`[KARMA] Waiting for ${this.activeTasks.size} background task(s) to complete... (Timeout: ${timeoutMs}ms)`);
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout waiting for tasks")), timeoutMs);
    });

    try {
      await Promise.race([
        Promise.allSettled(Array.from(this.activeTasks)),
        timeoutPromise
      ]);
      if (this.activeTasks.size > 0) {
        console.error(`[KARMA] ${this.activeTasks.size} task(s) remaining after first await pass.`);
      }
      console.error(`[KARMA] All tasks cleaned up.`);
    } catch {
      console.error(`[KARMA] Abandoning hanging tasks due to timeout.`);
    }
  }
}

export const globalTaskTracker = new TaskTracker();
