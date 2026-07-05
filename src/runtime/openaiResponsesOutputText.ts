// Collects all output_text parts from response.output[] in order, then:
// - if all parts are identical → return only the first (dedup model duplicate-block bug)
// - if parts differ → concatenate in order (preserve valid split output)
// - if no parts found → return null (caller falls back to response.output_text)
export function readResponseOutputTextDeduped(output: unknown): string | null {
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    const obj = asObject(item);
    if (!obj) continue;
    if (readString(obj.type) !== "message") continue;
    const content = obj.content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      const contentObj = asObject(contentItem);
      if (!contentObj) continue;
      if (readString(contentObj.type) !== "output_text") continue;
      const text = readString(contentObj.text);
      if (text && text.length > 0) parts.push(text);
    }
  }

  if (parts.length === 0) return null;
  if (parts.every((p) => p === parts[0])) return parts[0]!;
  return parts.join("");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
