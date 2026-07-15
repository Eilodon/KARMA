/**
 * KARMA Stellar SEP-24 anchor cash-out — real protocol handshake against Stellar's own
 * public test anchor (testanchor.stellar.org), the reference SEP-24 implementation the
 * Stellar Development Foundation runs for exactly this purpose.
 *
 * Completes the "freelancer cashes out to local currency" leg of the pivot story: after
 * earning reputation (ZK proof, `demo:stellar`) and getting paid (x402, `demo:stellar:x402`),
 * agent-alpha authenticates to a REAL anchor (SEP-10) and opens a REAL SEP-24 interactive
 * withdrawal request for USDC — a real JWT, a real anchor-issued transaction id, and a real
 * interactive KYC URL come back from testanchor.stellar.org, not a stub.
 *
 * Honest scope: the interactive KYC step itself is anchor-hosted and meant for a human to
 * click through — that's what SEP-24 is, a wallet cannot complete it server-side by design.
 * This script proves the protocol handshake end-to-end (auth + request + status poll) is
 * real; it prints the interactive_url a human would open next rather than pretending to
 * finish it. Same disclosure pattern this repo already uses elsewhere (see DEMO_STELLAR.md)
 * — a claim we can't back up is worse than no claim.
 *
 *   KEYSTORE_PASSWORD=<password> pnpm exec tsx src/scripts/demo_stellar_anchor_cashout.ts
 */
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { keystoreManager } from "../lib/keystore.js";

const ANCHOR_HOME_DOMAIN = "testanchor.stellar.org";

interface AnchorToml {
  WEB_AUTH_ENDPOINT: string;
  TRANSFER_SERVER_SEP0024: string;
  NETWORK_PASSPHRASE: string;
}

function parseToml(text: string): AnchorToml {
  const get = (key: string): string => {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(key)) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== key) continue;
      const match = /^"([^"]*)"/.exec(trimmed.slice(eq + 1).trim());
      if (match) return match[1];
    }
    throw new Error(`[anchor] stellar.toml missing ${key}`);
  };
  return {
    WEB_AUTH_ENDPOINT: get("WEB_AUTH_ENDPOINT"),
    TRANSFER_SERVER_SEP0024: get("TRANSFER_SERVER_SEP0024"),
    NETWORK_PASSPHRASE: get("NETWORK_PASSPHRASE"),
  };
}

async function main(): Promise<void> {
  const pw = process.env.KEYSTORE_PASSWORD;
  if (!pw) throw new Error("KEYSTORE_PASSWORD not set");
  await keystoreManager.load("./keystore.json", pw);

  const kp = keystoreManager.getStellarKeypair("agent-alpha");
  const account = kp.publicKey();

  // ── SEP-1: discover the anchor's real endpoints from its stellar.toml ─────────────
  console.log(`[anchor] fetching SEP-1 stellar.toml from ${ANCHOR_HOME_DOMAIN}...`);
  const tomlRes = await fetch(`https://${ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml`);
  if (!tomlRes.ok) throw new Error(`stellar.toml fetch failed: ${tomlRes.status}`);
  const toml = parseToml(await tomlRes.text());
  console.log("[anchor] WEB_AUTH_ENDPOINT =", toml.WEB_AUTH_ENDPOINT);
  console.log("[anchor] TRANSFER_SERVER_SEP0024 =", toml.TRANSFER_SERVER_SEP0024);

  // ── SEP-10: authenticate as agent-alpha's real, funded Stellar account ────────────
  console.log(`[client] agent-alpha (${account}) — requesting SEP-10 challenge...`);
  const challengeRes = await fetch(`${toml.WEB_AUTH_ENDPOINT}?account=${account}`);
  if (!challengeRes.ok) throw new Error(`SEP-10 challenge failed: ${challengeRes.status}`);
  const { transaction: challengeXdr, network_passphrase } = (await challengeRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };
  const networkPassphrase = network_passphrase ?? toml.NETWORK_PASSPHRASE;

  const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
  tx.sign(kp);
  const signedXdr = tx.toXDR();
  console.log("[client] signed the challenge with agent-alpha's real Stellar keypair");

  const tokenRes = await fetch(toml.WEB_AUTH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });
  if (!tokenRes.ok) {
    throw new Error(`SEP-10 token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };
  console.log("[client] real SEP-10 JWT obtained (session token, not a stub)");

  // ── SEP-24: open a real interactive withdrawal request for USDC ───────────────────
  console.log("[client] requesting SEP-24 interactive withdrawal (USDC)...");
  const withdrawRes = await fetch(`${toml.TRANSFER_SERVER_SEP0024}/transactions/withdraw/interactive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ asset_code: "USDC", account }),
  });
  if (!withdrawRes.ok) {
    throw new Error(`SEP-24 interactive request failed: ${withdrawRes.status} ${await withdrawRes.text()}`);
  }
  const interactive = (await withdrawRes.json()) as { type: string; url: string; id: string };
  console.log("[anchor] interactive withdrawal opened:", interactive);
  console.log(
    `[anchor] a human would open this URL next to complete KYC + pick a cash-out method: ${interactive.url}`,
  );

  // ── Poll the real transaction record — proves the handshake is live, not a stub ───
  const statusRes = await fetch(`${toml.TRANSFER_SERVER_SEP0024}/transaction?id=${interactive.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const statusBody = (await statusRes.json()) as {
    transaction: { id: string; status: string; kind: string };
  };
  console.log("[anchor] real transaction record:", statusBody.transaction);

  console.log("[demo] SEP-24 handshake PASS — real anchor, real JWT, real transaction id:", interactive.id);
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
