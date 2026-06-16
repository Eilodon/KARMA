/**
 * Fail-closed proof of the trusted main KARMA runtime.
 *
 * The external plugin worker (src/core/plugin_worker.ts) is a per-call `fork()` with a fresh
 * V8 isolate: module state does NOT carry across the process boundary, so a marker set by the
 * parent is absent in the worker. This module turns the karma.tool canary from FAIL-OPEN (absence
 * of KARMA_PLUGIN_WORKER ⇒ "assume in-process") into FAIL-CLOSED (positive proof required).
 *
 * The marker is set exactly once by the trusted loader (PluginLoader.loadAll), which only ever
 * runs in the parent — the worker loads plugins through its own plugin_worker.loadTools() and
 * never calls this. A future runner that forgets to mark trusted is denied by default, closing
 * the gap that an env-var convention (KARMA_PLUGIN_WORKER) leaves open. See spec D-1 / DEBT-001.
 */
let trusted = false;

/** Declare that this process is the trusted in-process KARMA runtime. Idempotent. */
export function markTrustedRuntime(): void {
  trusted = true;
}

/** True only after markTrustedRuntime() ran in this process. Default (and the worker) is false. */
export function isTrustedRuntime(): boolean {
  return trusted;
}

/** Test-only: restore the untrusted default so canary fail-closed behavior can be exercised. */
export function resetTrustedRuntimeForTest(): void {
  trusted = false;
}
