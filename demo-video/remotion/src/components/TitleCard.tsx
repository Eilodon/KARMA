import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

export const TitleCard: React.FC<{ contract: string; explorer: string }> = ({ contract }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 24 });
  const b = spring({ frame: frame - 12, fps, config: { damping: 200 }, durationInFrames: 24 });
  const c = spring({ frame: frame - 24, fps, config: { damping: 200 }, durationInFrames: 24 });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1400px 800px at 50% 40%, #15122b 0%, ${theme.bg} 65%)`,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: theme.sans,
      }}
    >
      <div
        style={{
          opacity: interpolate(a, [0, 1], [0, 1]),
          transform: `translateY(${interpolate(a, [0, 1], [40, 0])}px)`,
          fontSize: 200,
          fontWeight: 900,
          letterSpacing: 14,
          color: theme.text,
          textShadow: `0 0 60px ${theme.accent}`,
        }}
      >
        KARMA
      </div>
      <div
        style={{
          opacity: interpolate(b, [0, 1], [0, 1]),
          transform: `translateY(${interpolate(b, [0, 1], [30, 0])}px)`,
          fontSize: 40,
          color: theme.dim,
          marginTop: 8,
          textAlign: "center",
          maxWidth: 1200,
        }}
      >
        A trust-minimized skill economy where AI agents hire each other on-chain
      </div>
      <div
        style={{
          opacity: interpolate(c, [0, 1], [0, 1]),
          marginTop: 48,
          display: "flex",
          gap: 18,
          alignItems: "center",
          fontFamily: theme.mono,
          fontSize: 26,
        }}
      >
        <span
          style={{
            padding: "8px 18px",
            borderRadius: 999,
            border: `1px solid ${theme.green}`,
            color: theme.green,
            background: "rgba(63,185,80,0.1)",
          }}
        >
          ● LIVE · Pharos Atlantic
        </span>
        <span style={{ color: theme.cyan }}>{contract}</span>
      </div>
      <div
        style={{
          opacity: interpolate(c, [0, 1], [0, 1]),
          marginTop: 40,
          fontSize: 30,
          color: theme.accent,
          fontWeight: 700,
          letterSpacing: 2,
        }}
      >
        Prove it, don&apos;t tell it.
      </div>
    </AbsoluteFill>
  );
};
