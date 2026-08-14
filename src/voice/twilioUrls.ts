export function buildTwilioMediaStreamUrl(publicBaseUrl: string): string {
  const wsScheme = publicBaseUrl.startsWith("https://") ? "wss" : "ws";
  const host = publicBaseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `${wsScheme}://${host}/voice/media-stream`;
}
