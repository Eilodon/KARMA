export const theme = {
  bg: "#0a0e14",
  bg2: "#0d1117",
  panel: "#0f141c",
  panelHi: "#141b24",
  border: "#222c38",
  text: "#e6edf3",
  dim: "#8b949e",
  cyan: "#39d0d8",
  magenta: "#d2a8ff",
  green: "#3fb950",
  red: "#ff7b72",
  yellow: "#e3b341",
  blue: "#58a6ff",
  accent: "#7c5cff",
  mono: "'DejaVu Sans Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
  sans: "'Inter', 'Segoe UI', system-ui, 'Liberation Sans', sans-serif",
};

export const shortHash = (h: string, head = 10, tail = 8): string =>
  h && h.length > head + tail ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
