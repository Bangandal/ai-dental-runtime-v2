/**
 * Per-call abort signals for the OpenAI client.
 *
 * The constructor-level `timeout` option only bounds the time to response
 * *headers*: the SDK's fetchWithTimeout clears its timer as soon as fetch
 * resolves, while the body is parsed later via response.json(). A gateway that
 * returns headers and then stalls the body would hang the turn indefinitely.
 * A per-request AbortSignal is honored by fetch for the entire request,
 * including body reads, so response.json() rejects when it fires.
 *
 * Note: an aborted signal also stops SDK retries, so this acts as a *total*
 * bound per logical call (all attempts included), on top of the per-attempt
 * constructor timeout.
 */

export const OPENAI_CALL_TOTAL_TIMEOUT_MS = 90_000;

interface CreateCapableResource {
  create?: (...args: unknown[]) => unknown;
}

const WRAPPED_RESOURCES = ["responses", "conversations", "embeddings"] as const;

function wrapCreate(resource: CreateCapableResource, timeoutMs: number): void {
  const original = resource.create;
  if (typeof original !== "function") return;
  resource.create = function wrappedCreate(...args: unknown[]): unknown {
    // SDK create signatures are (body?, options?). Inject a timeout signal into
    // options when the caller did not provide one; never override an explicit signal.
    const body = args[0];
    const options = (args[1] ?? {}) as { signal?: AbortSignal } & Record<string, unknown>;
    const withSignal = options.signal ? options : { ...options, signal: AbortSignal.timeout(timeoutMs) };
    return original.call(resource, body, withSignal);
  };
}

/**
 * Patches create() on the client's responses/conversations/embeddings resources
 * (when present) to carry a per-call AbortSignal. Returns the same client so it
 * can wrap the constructor call inline. Resources the client does not expose are
 * skipped silently — test doubles with a partial surface keep working.
 */
export function bindOpenAIPerCallTimeout<T>(client: T, timeoutMs: number = OPENAI_CALL_TOTAL_TIMEOUT_MS): T {
  const record = client as Record<string, unknown>;
  for (const name of WRAPPED_RESOURCES) {
    const resource = record[name];
    if (resource && typeof resource === "object") {
      wrapCreate(resource as CreateCapableResource, timeoutMs);
    }
  }
  return client;
}
