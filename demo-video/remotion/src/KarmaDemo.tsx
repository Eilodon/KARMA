import React from "react";
import { AbsoluteFill, Sequence, Audio, staticFile } from "remotion";
import manifest from "./manifest.json";
import { theme } from "./theme";
import { TitleCard } from "./components/TitleCard";
import { TerminalSegment } from "./components/TerminalSegment";
import { ShotSegment } from "./components/ShotSegment";
import { Outro } from "./components/Outro";
import { ProgressBar } from "./components/ProgressBar";

export type Tx = { label: string; hash: string };
export type Segment = {
  id: string;
  kind: "title" | "terminal" | "shot" | "outro";
  chapter: string;
  proof: string;
  showTxs?: boolean;
  narr: { src: string | null; duration: number } | null;
  clip: string | null;
  clipFrames: number;
  last: string | null;
  shot: string | null;
  contractShot: string | null;
  durationInFrames: number;
};

const M = manifest as unknown as {
  fps: number; width: number; height: number;
  explorer: string; contract: string; txs: Tx[]; segments: Segment[];
};

const Router: React.FC<{ seg: Segment }> = ({ seg }) => {
  switch (seg.kind) {
    case "title":
      return <TitleCard contract={M.contract} explorer={M.explorer} />;
    case "shot":
      return <ShotSegment seg={seg} explorer={M.explorer} />;
    case "outro":
      return <Outro contract={M.contract} explorer={M.explorer} />;
    default:
      return <TerminalSegment seg={seg} txs={M.txs} explorer={M.explorer} />;
  }
};

export const KarmaDemo: React.FC = () => {
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.sans }}>
      {M.segments.map((seg) => {
        const node = (
          <Sequence key={seg.id} from={from} durationInFrames={seg.durationInFrames} name={seg.id}>
            <Router seg={seg} />
            {seg.narr?.src ? <Audio src={staticFile(seg.narr.src)} /> : null}
          </Sequence>
        );
        from += seg.durationInFrames;
        return node;
      })}
      <ProgressBar />
    </AbsoluteFill>
  );
};
