import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setConcurrency(2);
Config.setChromiumOpenGlRenderer("angle");
// Reuse the system Chrome (no extra browser download). Override at CLI with --browser-executable.
