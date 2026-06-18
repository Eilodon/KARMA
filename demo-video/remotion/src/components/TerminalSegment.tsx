import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { theme } from "../theme";
import manifest from "../manifest.json";
import type { Segment, Tx } from "../KarmaDemo";
import { TerminalWindow } from "./TerminalWindow";
import { LowerThird } from "./LowerThird";
import { ChapterPill } from "./ChapterPill";
import { TxPanel } from "./TxPanel";

const CHAPTERS = (manifest.segments as unknown as Segment[]).filter((s) => s.chapter);
const chapterPos = (id: string): [number, number] => {
  const i = CHAPTERS.findIndex((s) => s.id === id);
  return [i + 1, CHAPTERS.length];
};

const titleFor = (id: string): string => {
  const map: Record<string, string> = {
    discover: "agent ~ pnpm demo:discover",
    "trust-gate": "agent ~ pnpm demo:trust-gate",
    demo: "agent ~ pnpm demo",
    verify: "agent ~ pnpm demo:verify",
  };
  return map[id] ?? `agent ~ ${id}`;
};

const PlaceholderTerminal: React.FC<{ id: string }> = ({ id }) => (
  <div
    style={{
      height: 900,
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      padding: "0 60px",
      fontFamily: theme.mono,
      color: theme.dim,
      fontSize: 30,
    }}
  >
    <div style={{ color: theme.green }}>$ {titleFor(id).replace("agent ~ ", "")}</div>
    <div style={{ marginTop: 18, color: theme.yellow }}>
      ◐ live capture pending — run demo-video/build.sh with KEYSTORE_PASSWORD set
    </div>
  </div>
);

export const TerminalSegment: React.FC<{ seg: Segment; txs: Tx[]; explorer: string }> = ({
  seg,
  txs,
  explorer,
}) => {
  const frame = useCurrentFrame();
  const [idx, total] = chapterPos(seg.id);
  const WIN_W = 1380;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 50% 30%, ${theme.bg2} 0%, ${theme.bg} 70%)`,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ marginTop: -40 }}>
        <TerminalWindow title={titleFor(seg.id)} width={WIN_W}>
          {seg.clip ? (
            frame < seg.clipFrames ? (
              <OffthreadVideo
                src={staticFile(seg.clip)}
                style={{ width: WIN_W, display: "block" }}
              />
            ) : seg.last ? (
              <Img src={staticFile(seg.last)} style={{ width: WIN_W, display: "block" }} />
            ) : null
          ) : (
            <PlaceholderTerminal id={seg.id} />
          )}
        </TerminalWindow>
      </div>

      <ChapterPill label={seg.chapter} index={idx} total={total} />

      <Sequence from={12} name="lower-third">
        <LowerThird text={seg.proof} />
      </Sequence>

      {seg.showTxs ? (
        // Reveal the hash summary on the freeze-frame tail, so it never covers live output.
        <Sequence from={Math.max(20, seg.clipFrames)} name="tx-panel">
          <TxPanel txs={txs} explorer={explorer} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
