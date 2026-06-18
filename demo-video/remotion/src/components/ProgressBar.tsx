import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Thin global progress bar across the whole video (mounted at the composition root). */
export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const pct = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, background: "rgba(255,255,255,0.06)" }}>
      <div
        style={{
          height: "100%",
          width: `${pct * 100}%`,
          background: `linear-gradient(90deg, ${theme.accent}, ${theme.cyan})`,
        }}
      />
    </div>
  );
};
