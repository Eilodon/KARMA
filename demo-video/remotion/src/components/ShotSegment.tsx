import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import manifest from "../manifest.json";
import type { Segment } from "../KarmaDemo";
import { ChapterPill } from "./ChapterPill";
import { LowerThird } from "./LowerThird";

const CHAPTERS = (manifest.segments as unknown as Segment[]).filter((s) => s.chapter);

export const ShotSegment: React.FC<{ seg: Segment; explorer: string }> = ({ seg, explorer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  const scale = interpolate(a, [0, 1], [1.06, 1]);
  const opacity = interpolate(a, [0, 1], [0, 1]);
  const idx = CHAPTERS.findIndex((s) => s.id === seg.id) + 1;

  return (
    <AbsoluteFill style={{ background: theme.bg, justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          width: 1340,
          borderRadius: 12,
          overflow: "hidden",
          border: `1px solid ${theme.border}`,
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          opacity,
          transform: `scale(${scale})`,
          marginTop: -30,
        }}
      >
        <div
          style={{
            height: 46,
            background: theme.panelHi,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 18px",
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ff5f56" }} />
          <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ffbd2e" }} />
          <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#27c93f" }} />
          <span
            style={{
              marginLeft: 14,
              flex: 1,
              background: theme.bg,
              borderRadius: 8,
              padding: "6px 16px",
              color: theme.dim,
              fontFamily: theme.mono,
              fontSize: 18,
            }}
          >
            {explorer.replace(/^https?:\/\//, "")}/tx/0x…155dac
          </span>
        </div>
        {seg.shot ? (
          <Img src={staticFile(seg.shot)} style={{ width: 1340, display: "block", background: "#fff" }} />
        ) : (
          <div style={{ height: 700, background: "#fff" }} />
        )}
      </div>

      <ChapterPill label={seg.chapter} index={idx} total={CHAPTERS.length} />
      <LowerThird text={seg.proof} accent={theme.green} />
    </AbsoluteFill>
  );
};
