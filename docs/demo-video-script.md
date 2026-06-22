# KARMA — Demo Video Script (T3ADK Dev Challenge · Best Agent)

**Target length:** 2:45–3:00 (judges skim — front-load the wow).
**Format:** live terminal capture (real output, real DIDs, real tx hashes) + voiceover + lower-third captions + 2 short explorer cutaways.
**Golden rule:** everything on screen is *real and reproducible*. No mocked output, no faked success. Authenticity is the wow.
**Rubric this targets:** Completeness 30% · **SDK integration depth 40%** · Creativity 30%.

> 🎬 **Ghi chú đạo diễn (VN):** Voiceover viết sẵn tiếng Anh để judges nghe/đọc. Caption = chữ chạy dưới màn hình. "WOW BEAT" = khoảnh khắc cần để output dừng lại 1–2s cho người xem kịp thấy. Lệnh capture nằm ở Phụ lục A. Quy tắc trung thực ở Phụ lục C — **đọc trước khi quay**.

---

## One-line pitch (đọc thuộc, dùng cho cold open + DoraHacks description)

> **KARMA is an on-chain skill economy where AI agents cannot act anonymously and their authority is never permanent — identity and bounded, revocable delegation are enforced by the Terminal3 Agent Auth SDK.**

---

## Scene-by-scene

### COLD OPEN — the problem (0:00–0:15)

- **ON SCREEN:** black screen → one line of text fades in, then a fast 1.5s montage of the 8 `t3_*` tool names scrolling.
- **VOICEOVER:** "Autonomous agents are about to pay each other, run payroll, move real money. Two problems: they're anonymous, and once you give one authority, it keeps it. KARMA fixes both — with Terminal3."
- **CAPTION:** `KARMA — verifiable identity + bounded authority for agent economies`
- **WOW BEAT:** the problem lands in one breath; judges know exactly what they're about to see.
- **RUBRIC:** Creativity (frames a real, unsolved problem).

---

### SCENE 1 — Identity gate, live (0:15–0:40)

- **ON SCREEN:** terminal. Run `t3_health` then `t3_verify_identity`. Highlight the returned `did:t3n:…`.
- **VOICEOVER:** "First, identity. The agent signs a Sign-In-With-Ethereum challenge with a key that never leaves its keystore — and Terminal3's TEE returns a verifiable decentralized identifier. This is a real handshake against the live Terminal3 testnet, not a mock."
- **CAPTION:** `t3_verify_identity → real did:t3n on Terminal3 testnet (SIWE / EIP-191)`
- **WOW BEAT:** the real `did:t3n:…` string appears. Freeze 1.5s.
- **RUBRIC:** SDK depth (`loadWasmComponent`, `T3nClient.handshake`, `authenticate`, `createEthAuthInput`, custom `GuestToHostHandler`).
- 🎬 **VN:** zoom nhẹ vào dòng DID. Đây là bằng chứng "chạy thật" đầu tiên — quan trọng.

---

### SCENE 2 — Dual-layer trust: the gate that says NO (0:40–1:05)

- **ON SCREEN:** attempt `t3_create_verified_job` **without** a verified identity → it is rejected. Then verify identity + show reputation, retry → it passes.
- **VOICEOVER:** "High-value work demands more than a login. A job only escrows if the agent clears two independent gates at once: a verified Terminal3 identity, *and* an on-chain reputation threshold. Miss either — it's refused. This is defense in depth, on-chain."
- **CAPTION:** `Gate 1: verified DID · Gate 2: on-chain reputation ≥ threshold — both, or nothing`
- **WOW BEAT:** the explicit **rejection** first ("identity gate: no verified DID"), *then* the pass. Showing it correctly refuse is more convincing than only showing success.
- **RUBRIC:** Creativity + Completeness (a genuinely novel trust model, shown end-to-end).
- 🎬 **VN:** cho thấy lỗi từ chối màu đỏ trước, rồi mới pass — tương phản tạo ấn tượng "có thật, có kiểm soát".

---

### SCENE 3 — FLAGSHIP: bounded, revocable delegation (1:05–1:45)

- **ON SCREEN:** run `t3_authorize_payroll_agent`. Highlight in the JSON: `functions_authorised`, `not_before`/`not_after`, `batch_cap_cents`, `credential_issued: true`, and the real `user_sig_hex` + `vc_id`.
- **VOICEOVER:** "Here's what almost no one uses: Terminal3's delegation credentials. KARMA issues a credential that is TEE-signed by Terminal3 — scoped to specific payroll functions, time-boxed to a validity window, and capped to a dollar amount. The agent gets exactly the authority it needs, signed by the secure enclave, and the private key never touches it."
- **CAPTION:** `TEE-signed delegation: function-scoped · time-bounded · dollar-capped`
- **WOW BEAT:** the real signature + vc_id appear, with the scope/limits visible. This is the 40%-criterion centerpiece — freeze 2s.
- **RUBRIC:** **SDK depth (the big one):** `buildDelegationCredential`, `DelegationCustodialClient.signCustodial`, `b64uEncodeBytes`, `PAYROLL_FUNCTIONS_V1`, `createOrgDataClientFromSession`, `buildPayrollDirectInvocation`.
- 🎬 **VN:** đây là cảnh quan trọng nhất (40% điểm). Để output đứng lâu, zoom vào `credential_issued: true` + `user_sig_hex`. Chạy dưới ví Terminal3 đã nạp token (xem Phụ lục A).

---

### SCENE 4 — Authority is temporary (1:45–2:05)

- **ON SCREEN:** run `t3_revoke_payroll_authorization` → `revoked_entirely: true` (real `vc_id` matches Scene 3).
- **VOICEOVER:** "And authority is never permanent. The same agent that was granted power can have it pulled — or narrowed to fewer functions — in one call. Issue, use, revoke: the full lifecycle, live."
- **CAPTION:** `t3_revoke_payroll_authorization → credential revoked. Standing power, gone.`
- **WOW BEAT:** the vc_id from Scene 3 reappears, now revoked — visual continuity proves it's the same real credential.
- **RUBRIC:** Completeness (full issue→sign→revoke lifecycle) + SDK depth (`revokeDelegation`).

---

### SCENE 5 — A real economy, on a real chain (2:05–2:30)

- **ON SCREEN:** fast-cut the on-chain loop (`register_skill` → `create_job` → replay shows `exists` → `deliver_result` → `complete_job` → `withdraw_balance`), then a 2s cutaway to a real transaction on `atlantic.pharosscan.xyz`.
- **VOICEOVER:** "Underneath, this is a working economy. Skills are registered and discovered by reputation, jobs escrow real funds, results are confirmed or disputed in a review window, and reputation is earned on-chain. Every step is a real transaction on Pharos."
- **CAPTION:** `Live contract 0x0680…79b4 · Pharos Atlantic · escrow · reputation · withdrawal`
- **WOW BEAT:** the Pharosscan explorer page with a real confirmed tx. Proof it's not a toy.
- **RUBRIC:** Completeness (real settlement) + Creativity (identity-gated economy).
- 🎬 **VN:** Có thể tái dùng đoạn capture cũ của `pnpm demo` nếu còn; chèn 1 ảnh/clip Pharosscan thật. Giữ nhịp nhanh — đây là phần phụ trợ, không phải trọng tâm.

---

### SCENE 6 — Depth + integrity montage (2:30–2:45)

- **ON SCREEN:** quick splits: (a) the SDK-surfaces list scrolling, (b) `pnpm test` → `457 passed`, (c) `demo:discover` prompt-injection line (`‮` stripped), (d) the honest `invocation_note` from the credential output.
- **VOICEOVER:** "Twenty-three Terminal3 SDK surfaces. Eight dedicated tools. Four-hundred-fifty-seven tests green. And where the public testnet can't run a step, KARMA degrades gracefully and reports structured evidence — never a fake success."
- **CAPTION:** `8 T3N tools · ~23 SDK surfaces · 457 tests · honest, structured failures`
- **WOW BEAT:** "never a fake success" over the real graceful-degradation output — signals engineering integrity (judges notice).
- **RUBRIC:** SDK depth + Completeness.

---

### CLOSE (2:45–3:00)

- **ON SCREEN:** the one-line pitch + GitHub URL + "Built on @terminal3/t3n-sdk".
- **VOICEOVER:** "KARMA: agents you can identify, with authority you can bound and revoke. The trust layer for the agent economy — built on Terminal3."
- **CAPTION:** `github.com/Eilodon/KARMA · KARMA × Terminal3 Agent Auth SDK`

---

## Appendix A — Capture commands (exact, reproducible)

> Run each block, capture the terminal. Use `NO_COLOR=1` for clean text or keep color for vibrancy — pick one and stay consistent. Password comes from the gitignored `demo-video/secrets.env`.

**Identity + dual-gate + commitment (agent-alpha — bonded on-chain, free auth):**
```bash
export KEYSTORE_PASSWORD="$(grep -E '^KEYSTORE_PASSWORD=' demo-video/secrets.env | cut -d= -f2-)"
# Scenes 1–2–(commitment). Use the smoke harness or a small driver that calls:
#   t3_health → t3_verify_identity(agent-alpha) → (show t3_create_verified_job reject→pass) → t3_sign_job_commitment
pnpm demo:trust-gate        # shows the dual-gate reject→pass cleanly
```

**Flagship delegation issue→revoke (funded Terminal3 wallet — has test tokens):**
```bash
# signCustodial is a PAID TEE op → must run under the funded T3N account, not agent-alpha.
# Use src/scripts/t3_payroll_smoke.ts pointed at the funded agent (see Appendix B), which runs:
#   t3_verify_identity → t3_authorize_payroll_agent (credential_issued:true) → t3_revoke_payroll_authorization
export KEYSTORE_PASSWORD="$(grep -E '^KEYSTORE_PASSWORD=' demo-video/secrets.env | cut -d= -f2-)"
npx tsx src/scripts/t3_payroll_smoke.ts
```

**Offline discovery (Scene 6 cutaway — instant, no chain/keystore):**
```bash
NO_COLOR=1 pnpm demo:discover
```

**On-chain economy (Scene 5 — needs funded keystore + deployed contract):**
```bash
KEYSTORE_PASSWORD=... pnpm demo
KEYSTORE_PASSWORD=... pnpm demo:verify
```

**Proof shots:** `pnpm test` (→ 457 passed) · a real tx on `https://atlantic.pharosscan.xyz/address/0x068091d8b982379373a4db377872ffb608a979b4`.

---

## Appendix B — Two-wallet note (important for capture)

KARMA's on-chain agent (`agent-alpha`, bonded on Pharos) authenticates with Terminal3 **for free** and powers Scenes 1–2 and 5. The **paid** TEE delegation signing in Scene 3 needs a **funded** Terminal3 account, so run Scene 3–4 under the funded wallet (DID `did:t3n:2fcc431f…`, ~19.8k testnet tokens). Narrate both as "the KARMA agent" — judges care that the SDK features work live, not which wallet signs. If you prefer a single identity on screen, fund `agent-alpha`'s Terminal3 account first (see README / `docs/RUNTIME.md`), then run everything under it.

---

## Appendix C — Honesty guardrails (read before recording)

These protect the score (and your integrity) — judges punish overclaiming:

1. **Do NOT** present `grant_provisioned` or `invocation_succeeded` as true. On public testnet they are `false` (`OrganisationNotFound` / `tee:payroll 404`) — the org and contract simply aren't deployed there. Frame the **TEE-signed credential** as the verifiable artifact and the issue→revoke lifecycle as the proven flow.
2. **Do** show the graceful-degradation note as a *strength* (Scene 6): structured evidence, never a thrown error or a fake success. That is defense-in-depth working as designed.
3. Keep the real `did:t3n:…`, `vc_id`, `user_sig_hex`, and Pharos tx hashes on screen — authenticity is the entire point. (Testnet only; no real-value secrets are exposed.)
4. Numbers to state, all current and true: **8 Terminal3 tools**, **~23 SDK surfaces**, **457 tests pass**, contract live at **0x0680…79b4** on Pharos Atlantic.

---

## Appendix D — 30-second teaser cut (optional, for social / DoraHacks thumbnail loop)

Cold open (5s) → Scene 1 real DID (7s) → Scene 3 `credential_issued: true` + signature (10s) → Scene 4 revoke (5s) → close card (3s). One sentence of VO: *"Identity you can verify, authority you can revoke — KARMA, on Terminal3."*

---

## Production notes

- The repo already ships a video pipeline (`demo-video/`): asciinema capture → `agg` (terminal→gif/frames) → `edge-tts` (voiceover) → Remotion (compositing). Reuse it; feed the captures above as the terminal track and this script's VO as the narration track.
- Pacing: terminal output scrolls fast — insert deliberate 1.5–2s holds on each WOW BEAT (DID, credential signature, revoke, Pharosscan).
- Lead with Terminal3 (Scenes 1–4 = ~70% of runtime). The economy (Scene 5) is supporting cast — it proves "real product," but the SDK depth is what scores 40%.
- Subtitles/captions burned in (many judges watch muted).
