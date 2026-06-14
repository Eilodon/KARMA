export function isJsonRequest(method: string, contentType: string | undefined): boolean {
  if (method.toUpperCase() !== "POST") return true;
  if (!contentType) return false;
  const normalized = (contentType.split(";")[0] || "").trim().toLowerCase();
  return normalized === "application/json" || normalized.endsWith("+json");
}

export function isBodyTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { type?: string }).type === "entity.too.large";
}
