import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Top-right chapter marker pill. */
export const ChapterPill: React.FC<{ label: string; index: number; total: number }> = ({
  label,
  index,
  total,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const y = interpolate(enter, [0, 1], [-30, 0]);

  return (
    <div
      style={{
        position: "absolute",
        top: 56,
        right: 72,
        transform: `translateY(${y}px)`,
        opacity,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 20px",
        borderRadius: 999,
        background: "rgba(124,92,255,0.14)",
        border: `1px solid ${theme.accent}`,
        fontFamily: theme.mono,
      }}
    >
      <span style={{ color: theme.accent, fontSize: 20, fontWeight: 700 }}>
        {String(index).padStart(2, "0")}/{String(total).padStart(2, "0")}
      </span>
      <span style={{ color: theme.text, fontSize: 22, letterSpacing: 1 }}>{label}</span>
    </div>
  );
};
