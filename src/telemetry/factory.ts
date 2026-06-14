import { ENV } from "../config/env.js";
import type { ITelemetryLogger } from "./interface.js";
import { FileLogger } from "./file_logger.js";
import { StdoutLogger } from "./stdout_logger.js";
import { StderrLogger } from "./stderr_logger.js";

export function createTelemetry(): ITelemetryLogger {
  switch (ENV.TELEMETRY_DRIVER) {
    case "file":
      return new FileLogger();
    case "stderr":
      return new StderrLogger();
    case "stdout":
    default:
      return new StdoutLogger();
  }
}

export const telemetry = createTelemetry();
