import { loadWasmComponent } from "@terminal3/t3n-sdk";

console.error("[T3N Probe] Loading WASM component...");
try {
  const wasm = await loadWasmComponent();
  console.error("[T3N Probe] WASM OK:", typeof wasm);
  console.error("[T3N Probe] PASS — Risk #2 closed.");
  process.exit(0);
} catch (err) {
  console.error("[T3N Probe] FAIL:", err);
  console.error("[T3N Probe] Try explicit wasmPath override if path resolution failed.");
  process.exit(1);
}
