/**
 * Preflight balance gate for the KARMA demo-video pipeline.
 *
 * Reads Alpha + Beta live balances and refuses to start a capture the wallets cannot
 * finish — so we never "burn the wallet" mid-take. Beta is the bottleneck (it pays the
 * escrow that is not recovered). Costs are the real measured per-run figures.
 *
 *   PHAROS_RPC_URL=... pnpm exec tsx demo-video/preflight.mts
 *
 * Env (all optional, defaults match demo-video/config.sh):
 *   PREFLIGHT_DEMO=1|0        a full 5-tx `demo` run will be taken (default 1)
 *   PREFLIGHT_TRUSTGATE=1|0   a `trust-gate` run will be taken (default 1)
 *   BETA_COST_WEI ALPHA_COST_WEI TRUSTGATE_ALPHA_WEI SAFETY_RUNS
 *
 * Exit 0 = GO, exit 1 = NO-GO (build aborts).
 */
import { createPublicClient, http, formatEther } from "viem";

const RPC = process.env.PHAROS_RPC_URL ?? "https://atlantic.dplabs-internal.com";
const ALPHA = "0x857c2F11E9EDDdC7DDc03d035B0998De3c7677ec" as const;
const BETA = "0x00d5f57009279aB0195264Fa2160F43055deD938" as const;

const n = (k: string, d: bigint): bigint => {
  const v = process.env[k];
  return v && /^\d+$/.test(v) ? BigInt(v) : d;
};
const BETA_COST = n("BETA_COST_WEI", 588761000000000n);
const ALPHA_COST = n("ALPHA_COST_WEI", 395764000000000n);
const TRUSTGATE_ALPHA = n("TRUSTGATE_ALPHA_WEI", 288055000000000n);
const SAFETY_RUNS = n("SAFETY_RUNS", 1n);
const wantDemo = process.env.PREFLIGHT_DEMO !== "0";
const wantTrustgate = process.env.PREFLIGHT_TRUSTGATE !== "0";

const f = (w: bigint) => `${formatEther(w)} PHRS`;
const c = (s: string, code: string) =>
  process.env.NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`;

async function main(): Promise<void> {
  const client = createPublicClient({ transport: http(RPC) });
  const [alphaBal, betaBal] = await Promise.all([
    client.getBalance({ address: ALPHA }),
    client.getBalance({ address: BETA }),
  ]);

  // Budget required for ONE capture take of the requested segments.
  const alphaNeed =
    (wantDemo ? ALPHA_COST : 0n) + (wantTrustgate ? TRUSTGATE_ALPHA : 0n);
  const betaNeed = wantDemo ? BETA_COST : 0n; // Beta spends only in the full demo loop

  // Headroom = how many more full demo runs each wallet can fund after this take.
  const alphaRunsLeft = ALPHA_COST > 0n ? alphaBal / ALPHA_COST : 999n;
  const betaRunsLeft = BETA_COST > 0n ? betaBal / BETA_COST : 999n;

  console.log(c("\n┌─ Preflight: wallet budget gate ─────────────────────────────┐", "36"));
  console.log(`  RPC            ${RPC}`);
  console.log(`  Alpha (prov.)  ${f(alphaBal)}   ~${alphaRunsLeft} full runs left`);
  console.log(`  Beta  (req.)   ${f(betaBal)}   ${c("~" + betaRunsLeft + " full runs left", betaRunsLeft <= 1n ? "31" : "33")}  <- bottleneck`);
  console.log(`  Per full run   Alpha ${f(ALPHA_COST)}   Beta ${f(BETA_COST)} (incl. 0.0001 escrow)`);
  console.log(`  This take      demo=${wantDemo ? "yes" : "no"}  trust-gate=${wantTrustgate ? "yes" : "no"}`);
  console.log(`  Need this take Alpha ${f(alphaNeed)}   Beta ${f(betaNeed)}`);

  // GO requires: enough for THIS take, plus SAFETY_RUNS of headroom on the bottleneck.
  const alphaOk = alphaBal >= alphaNeed + ALPHA_COST * (wantDemo ? SAFETY_RUNS : 0n);
  const betaOk = betaBal >= betaNeed + BETA_COST * (wantDemo ? SAFETY_RUNS : 0n);

  if (alphaOk && betaOk) {
    console.log(c("  VERDICT: GO ✓  enough for this take + " + SAFETY_RUNS + " retry of headroom", "32"));
    console.log(c("└─────────────────────────────────────────────────────────────┘\n", "36"));
    process.exit(0);
  }
  console.log(c("  VERDICT: NO-GO ✗", "31"));
  if (!betaOk) console.log(c(`    Beta too low: need >= ${f(betaNeed + BETA_COST * SAFETY_RUNS)} for take + ${SAFETY_RUNS} retry. Top up Beta from the faucet.`, "31"));
  if (!alphaOk) console.log(c(`    Alpha too low: need >= ${f(alphaNeed + ALPHA_COST * SAFETY_RUNS)}. Top up Alpha from the faucet.`, "31"));
  console.log(c("└─────────────────────────────────────────────────────────────┘\n", "36"));
  process.exit(1);
}

main().catch((e) => {
  console.error("PREFLIGHT FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
