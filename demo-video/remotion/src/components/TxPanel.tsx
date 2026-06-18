import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme, shortHash } from "../theme";
import type { Tx } from "../KarmaDemo";

/** Right-side panel listing the real on-chain tx hashes, revealed one by one. */
export const TxPanel: React.FC<{ txs: Tx[]; explorer: string }> = ({ txs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const panel = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const opacity = interpolate(panel, [0, 1], [0, 1]);
  const x = interpolate(panel, [0, 1], [80, 0]);

  return (
    <div
      style={{
        position: "absolute",
        top: 150,
        right: 72,
        width: 560,
        transform: `translateX(${x}px)`,
        opacity,
        background: "rgba(15,20,28,0.92)",
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: "22px 24px",
        boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
        fontFamily: theme.mono,
      }}
    >
      <div style={{ color: theme.dim, fontSize: 20, marginBottom: 16, letterSpacing: 1 }}>
        ON-CHAIN · Pharos Atlantic
      </div>
      {txs.map((t, i) => {
        const at = 10 + i * 8;
        const rowSpring = spring({ frame: frame - at, fps, config: { damping: 200 }, durationInFrames: 12 });
        const ro = interpolate(rowSpring, [0, 1], [0, 1]);
        const ry = interpolate(rowSpring, [0, 1], [10, 0]);
        return (
          <div
            key={t.label}
            style={{
              opacity: ro,
              transform: `translateY(${ry}px)`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderBottom: i < txs.length - 1 ? `1px solid ${theme.border}` : "none",
            }}
          >
            <span style={{ color: theme.green, fontSize: 22 }}>
              <span style={{ color: theme.dim, marginRight: 10 }}>{i + 1}.</span>
              {t.label}
            </span>
            <span style={{ color: theme.cyan, fontSize: 20 }}>{shortHash(t.hash)}</span>
          </div>
        );
      })}
    </div>
  );
};
