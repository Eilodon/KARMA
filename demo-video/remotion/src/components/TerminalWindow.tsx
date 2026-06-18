import React from "react";
import { theme } from "../theme";

/** A rounded terminal "window" with a title bar — wraps the recorded clip for polish. */
export const TerminalWindow: React.FC<{
  title: string;
  width: number;
  children: React.ReactNode;
}> = ({ title, width, children }) => {
  return (
    <div
      style={{
        width,
        borderRadius: 14,
        overflow: "hidden",
        border: `1px solid ${theme.border}`,
        boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
        background: theme.bg2,
      }}
    >
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 16px",
          background: theme.panelHi,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ff5f56" }} />
        <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#ffbd2e" }} />
        <span style={{ width: 13, height: 13, borderRadius: "50%", background: "#27c93f" }} />
        <span
          style={{
            marginLeft: 12,
            color: theme.dim,
            fontFamily: theme.mono,
            fontSize: 18,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ background: theme.bg2 }}>{children}</div>
    </div>
  );
};
