import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  registerTwilioIncomingRoute,
  type TwilioIncomingRouteApp,
  type TwilioIncomingRequest,
  type TwilioIncomingReply,
} from "../src/voice/twilioIncomingRoute.ts";

type PostHandler = (req: TwilioIncomingRequest, reply: TwilioIncomingReply) => Promise<void>;

function makeApp() {
  const handlers = new Map<string, PostHandler>();
  const app: TwilioIncomingRouteApp = {
    post(path, handler) { handlers.set(path, handler); },
  };
  return { app, handlers };
}

function makeReply() {
  const state = { statusCode: 200, headers: {} as Record<string, string>, body: "" };
  const reply: TwilioIncomingReply = {
    code(n) { state.statusCode = n; return reply; },
    header(k, v) { state.headers[k] = v; return reply; },
    send(d) { state.body = d; },
  };
  return { reply, state };
}

function makeReq(overrides: Partial<TwilioIncomingRequest> = {}): TwilioIncomingRequest {
  return {
    headers: {},
    body: {},
    url: "https://host.example.com/voice/incoming",
    ...overrides,
  };
}

/** Compute a valid Twilio signature for a given URL and empty body params. */
function validSig(authToken: string, url: string, params: Record<string, string> = {}): string {
  const sorted = Object.keys(params).sort();
  const data = url + sorted.map(k => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

const TEST_TOKEN = "test_token_abc123";
const TEST_URL = "https://host.example.com/voice/incoming";

test("twilioIncomingRoute: returns TwiML with correct stream URL when auth passes", async () => {
  const { app, handlers } = makeApp();
  registerTwilioIncomingRoute(app, {
    twilioAuthToken: TEST_TOKEN,
    voicePublicBaseUrl: "https://host.example.com",
  });

  const handler = handlers.get("/voice/incoming")!;
  const { reply, state } = makeReply();
  const sig = validSig(TEST_TOKEN, TEST_URL);
  await handler(makeReq({ headers: { "x-twilio-signature": sig } }), reply);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["Content-Type"], "text/xml");
  assert.ok(state.body.includes("wss://host.example.com/voice/media-stream"), `Expected wss URL in: ${state.body}`);
  assert.ok(state.body.includes("<Response>"), `Expected <Response> in: ${state.body}`);
  assert.ok(state.body.includes("<Connect>"), `Expected <Connect> in: ${state.body}`);
  assert.ok(state.body.includes("<Stream"), `Expected <Stream> in: ${state.body}`);
});

test("twilioIncomingRoute: https public URL produces wss:// media-stream URL", async () => {
  const { app, handlers } = makeApp();
  const token = "test_tok_xyz";
  const url = "https://dental.example.com/voice/incoming";
  registerTwilioIncomingRoute(app, {
    twilioAuthToken: token,
    voicePublicBaseUrl: "https://dental.example.com",
  });

  const handler = handlers.get("/voice/incoming")!;
  const { reply, state } = makeReply();
  const sig = validSig(token, url);
  await handler(makeReq({ url, headers: { "x-twilio-signature": sig } }), reply);

  assert.ok(state.body.includes("wss://dental.example.com/voice/media-stream"));
});

test("twilioIncomingRoute: returns 503 when voicePublicBaseUrl missing", async () => {
  const { app, handlers } = makeApp();
  registerTwilioIncomingRoute(app, { twilioAuthToken: TEST_TOKEN });

  const handler = handlers.get("/voice/incoming")!;
  const { reply, state } = makeReply();
  await handler(makeReq(), reply);

  assert.equal(state.statusCode, 503);
});

test("twilioIncomingRoute: returns 503 when twilioAuthToken missing (fail-closed)", async () => {
  const { app, handlers } = makeApp();
  registerTwilioIncomingRoute(app, {
    voicePublicBaseUrl: "https://host.example.com",
    // no twilioAuthToken — section 5: fail-closed
  });

  const handler = handlers.get("/voice/incoming")!;
  const { reply, state } = makeReply();
  await handler(makeReq({ headers: { "x-twilio-signature": "anything" } }), reply);

  assert.equal(state.statusCode, 503, "503 when twilioAuthToken is absent (fail-closed)");
});

test("twilioIncomingRoute: returns 403 on bad Twilio signature when authToken configured", async () => {
  const { app, handlers } = makeApp();
  registerTwilioIncomingRoute(app, {
    twilioAuthToken: "auth_token_abc",
    voicePublicBaseUrl: "https://host.example.com",
  });

  const handler = handlers.get("/voice/incoming")!;
  const { reply, state } = makeReply();
  await handler(
    makeReq({ headers: { "x-twilio-signature": "bad_sig" } }),
    reply,
  );

  assert.equal(state.statusCode, 403);
});
