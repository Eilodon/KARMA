export interface ITelemetryLogger {
  log(event: string, meta: Record<string, unknown>): Promise<void>;
}
