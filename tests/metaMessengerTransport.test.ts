import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  normalizeMetaMessengerPayload,
  verifyMetaWebhookSignature,
} from "../src/runtime/metaMessengerWebhookAdapter.ts";
import {
  sendMetaMessengerMessage,
} from "../src/runtime/metaMessengerSender.ts";
import {
  readMetaMessengerConfigResult,
} from "../src/runtime/metaMessengerConfig.ts";
import {
  registerMetaMessengerWebhookRoute,
  type MetaMessengerGetRequest,
  type MetaMessengerPostRequest,
  type MetaMessengerRouteApp,
  type MetaMessengerWebhookReply,
} from "../src/runtime/metaMessengerWebhookRoute.ts";

const VERIFY_TOKEN = "meta-verify-test";
const APP_SECRET = "meta-app-secret-test";
const PAGE_ID = "123456789";
const ACCESS_TOKEN = "EAATEST";
const GRAPH_VERSION = "v25.0";
const CLINIC_CODE = "clinic_1";

function makePayload(opts: {
  senderId?: string;
  messageId?: string;
  text?: string;
  isEcho?: boolean;
  pageId?: string;
} = {}): unknown {
  return {
    object: "page",
    entry: [
      {
        id: opts.pageId ?? PAGE_ID,
        time: 1700000000000,
        messaging: [
          {
            sender: { id: opts.senderId ?? "PSID_1" },
            recipient: { id: opts.pageId ?? PAGE_ID },
            timestamp: 1700000000001,
            message: {
              mid: opts.messageId ?? "m_test_1",
              text: opts.text ?? "Hello clinic",
              is_echo: opts.isEcho ?? false,
            },
          },
        ],
      },
    ],
  };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

type GetHandler = (
  request: MetaMessengerGetRequest,
  reply: MetaMessengerWebhookReply,
) => Promise<void>;
type PostHandler = (
  request: MetaMessengerPostRequest,
  reply: MetaMessengerWebhookReply,
) => Promise<void>;

function makeRouteApp(): {
  app: MetaMessengerRouteApp;
  getHandlers: Map<string, GetHandler>;
  postHandlers: Map<string, PostHandler>;
} {
  const getHandlers = new Map<string, GetHandler>();
  const postHandlers = new Map<string, PostHandler>();
  return {
    app: {
      get(path, handler) {
        getHandlers.set(path, handler);
      },
      post(path, handler) {
        postHandlers.set(path, handler);
      },
    },
    getHandlers,
    postHandlers,
  };
}

function makeReplyCapture(): {
  reply: MetaMessengerWebhookReply;
  state: { statusCode: number; body: unknown };
} {
  const state = { statusCode: 200, body: undefined as unknown };
  const reply: MetaMessengerWebhookReply = {
    code(statusCode) {
      state.statusCode = statusCode;
      return reply;
    },
    send(payload) {
      state.body = payload;
    },
  };
  return { reply, state };
}

function minimalRouteDeps(appSecret: string | null = null) {
  return {
    pageAccessToken: ACCESS_TOKEN,
    pageId: PAGE_ID,
    verifyToken: VERIFY_TOKEN,
    appSecret,
    graphApiVersion: GRAPH_VERSION,
    clinicCode: CLINIC_CODE,
  } as unknown as import("../src/runtime/metaMessengerWebhookRoute.ts").MetaMessengerWebhookRouteDeps;
}

test("META-1: normalizes inbound Messenger text to canonical Runtime input", () => {
  const result = normalizeMetaMessengerPayload(makePayload(), CLINIC_CODE, PAGE_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0], {
    senderId: "PSID_1",
    messageId: "m_test_1",
    runtimeBody: {
      clinic_code: CLINIC_CODE,
      channel: "messenger",
      external_user_id: "PSID_1",
      chat_id: "PSID_1",
      text: "Hello clinic",
      meta: {
        message_id: "m_test_1",
        page_id: PAGE_ID,
        recipient_id: PAGE_ID,
        timestamp: "1700000000001",
        source: "meta_messenger",
      },
    },
  });
});

test("META-2: ignores Page echo events to prevent response loops", () => {
  const result = normalizeMetaMessengerPayload(
    makePayload({ isEcho: true }),
    CLINIC_CODE,
    PAGE_ID,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.turns, []);
});

test("META-3: ignores events delivered for a different Page binding", () => {
  const result = normalizeMetaMessengerPayload(
    makePayload({ pageId: "OTHER_PAGE" }),
    CLINIC_CODE,
    PAGE_ID,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.turns, []);
});

test("META-4: rejects non-Page webhook objects", () => {
  const result = normalizeMetaMessengerPayload(
    { object: "instagram", entry: [] },
    CLINIC_CODE,
    PAGE_ID,
  );
  assert.deepEqual(result, { ok: false, reason: "not_page_object" });
});

test("META-5: verifies X-Hub-Signature-256 against exact raw bytes", () => {
  const rawBody = Buffer.from(JSON.stringify(makePayload()), "utf8");
  assert.deepEqual(
    verifyMetaWebhookSignature({
      rawBody,
      signatureHeader: sign(rawBody.toString("utf8")),
      appSecret: APP_SECRET,
    }),
    { ok: true },
  );

  assert.deepEqual(
    verifyMetaWebhookSignature({
      rawBody,
      signatureHeader: "sha256=00",
      appSecret: APP_SECRET,
    }),
    { ok: false, reason: "invalid_signature" },
  );
});

test("META-6: sender targets Page Send API and never puts token in URL/body", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const result = await sendMetaMessengerMessage({
    pageAccessToken: ACCESS_TOKEN,
    pageId: PAGE_ID,
    graphApiVersion: GRAPH_VERSION,
    recipientId: "PSID_1",
    text: "Reply text",
    fetch: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ recipient_id: "PSID_1", message_id: "m_reply_1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, "m_reply_1");
  assert.equal(
    capturedUrl,
    `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/messages`,
  );
  assert.equal(capturedUrl.includes(ACCESS_TOKEN), false);

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    recipient: { id: "PSID_1" },
    messaging_type: "RESPONSE",
    message: { text: "Reply text" },
  });
  assert.equal(String(capturedInit?.body).includes(ACCESS_TOKEN), false);
});

test("META-7: config is disabled when no Meta transport env is present", () => {
  assert.deepEqual(
    readMetaMessengerConfigResult({}, true),
    { ok: false, reason: "disabled" },
  );
});

test("META-8: production config requires App Secret for webhook signature verification", () => {
  const result = readMetaMessengerConfigResult(
    {
      META_MESSENGER_PAGE_ACCESS_TOKEN: ACCESS_TOKEN,
      META_MESSENGER_PAGE_ID: PAGE_ID,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      META_GRAPH_API_VERSION: GRAPH_VERSION,
      META_DEFAULT_CLINIC_CODE: CLINIC_CODE,
    },
    true,
  );

  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "partial_config") return;
  assert.deepEqual(result.missing, ["META_APP_SECRET"]);
});

test("META-9: webhook verification returns challenge only for configured token", async () => {
  const { app, getHandlers } = makeRouteApp();
  registerMetaMessengerWebhookRoute(app, minimalRouteDeps());

  const handler = getHandlers.get("/webhooks/meta");
  assert.ok(handler);

  const okReply = makeReplyCapture();
  await handler(
    {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "challenge-123",
      },
    },
    okReply.reply,
  );
  assert.equal(okReply.state.statusCode, 200);
  assert.equal(okReply.state.body, "challenge-123");

  const badReply = makeReplyCapture();
  await handler(
    {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge-123",
      },
    },
    badReply.reply,
  );
  assert.equal(badReply.state.statusCode, 403);
});

test("META-10: webhook POST fails closed on bad Meta signature", async () => {
  const { app, postHandlers } = makeRouteApp();
  registerMetaMessengerWebhookRoute(app, minimalRouteDeps(APP_SECRET));

  const handler = postHandlers.get("/webhooks/meta");
  assert.ok(handler);

  const rawBody = Buffer.from(JSON.stringify(makePayload()), "utf8");
  const capture = makeReplyCapture();
  await handler(
    {
      body: makePayload(),
      rawBody,
      headers: { "x-hub-signature-256": "sha256=bad" },
    },
    capture.reply,
  );

  assert.equal(capture.state.statusCode, 401);
  assert.deepEqual(capture.state.body, { error: "Unauthorized" });
});

test("META-11: signed Page echo is acknowledged without invoking Runtime", async () => {
  const { app, postHandlers } = makeRouteApp();
  registerMetaMessengerWebhookRoute(app, minimalRouteDeps(APP_SECRET));

  const handler = postHandlers.get("/webhooks/meta");
  assert.ok(handler);

  const payload = makePayload({ isEcho: true });
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const capture = makeReplyCapture();
  await handler(
    {
      body: payload,
      rawBody,
      headers: { "x-hub-signature-256": sign(rawBody.toString("utf8")) },
    },
    capture.reply,
  );

  assert.equal(capture.state.statusCode, 200);
  assert.deepEqual(capture.state.body, { ok: true });
});
