import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Animated lower-third "Proof: …" annotation — the core "prove it, don't tell it" caption. */
export const LowerThird: React.FC<{ text: string; accent?: string }> = ({
  text,
  accent = theme.accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const x = interpolate(enter, [0, 1], [-60, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: "absolute",
        left: 90,
        bottom: 96,
        transform: `translateX(${x}px)`,
        opacity,
        display: "flex",
        alignItems: "stretch",
        borderRadius: 10,
        overflow: "hidden",
        background: "rgba(13,17,23,0.86)",
        border: `1px solid ${theme.border}`,
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{ width: 8, background: accent }} />
      <div style={{ padding: "16px 26px", display: "flex", alignItems: "center", gap: 16 }}>
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 22,
            fontWeight: 700,
            color: accent,
            letterSpacing: 1,
          }}
        >
          ✓ PROOF
        </span>
        <span style={{ fontFamily: theme.sans, fontSize: 28, color: theme.text }}>{text}</span>
      </div>
    </div>
  );
};
