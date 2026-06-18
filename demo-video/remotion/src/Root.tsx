import React from "react";
import { Composition } from "remotion";
import { KarmaDemo } from "./KarmaDemo";
import manifest from "./manifest.json";

const total = manifest.segments.reduce((a, s) => a + s.durationInFrames, 0);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="KarmaDemo"
      component={KarmaDemo}
      durationInFrames={Math.max(total, 1)}
      fps={manifest.fps}
      width={manifest.width}
      height={manifest.height}
    />
  );
};
