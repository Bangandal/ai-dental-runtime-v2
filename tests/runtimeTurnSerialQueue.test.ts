import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeTurnSerialKey,
  createRuntimeTurnSerialQueue,
} from "../src/runtime/runtimeTurnSerialQueue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("PF-008: turns for the same contact execute FIFO", async () => {
  const queue = createRuntimeTurnSerialQueue();
  const firstStarted = deferred();
  const firstGate = deferred();
  const events: string[] = [];

  const first = queue.run("clinic:telegram:patient", async () => {
    events.push("first:start");
    firstStarted.resolve();
    await firstGate.promise;
    events.push("first:end");
    return 1;
  });
  const second = queue.run("clinic:telegram:patient", async () => {
    events.push("second:start");
    events.push("second:end");
    return 2;
  });

  try {
    await firstStarted.promise;
    await Promise.resolve();
    assert.deepEqual(events, ["first:start"]);
  } finally {
    firstGate.resolve();
  }

  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("PF-008: different contacts remain parallel", async () => {
  const queue = createRuntimeTurnSerialQueue();
  const startedA = deferred();
  const startedB = deferred();
  const gateA = deferred();
  const gateB = deferred();
  const events: string[] = [];

  const a = queue.run("clinic:telegram:a", async () => {
    events.push("a:start");
    startedA.resolve();
    await gateA.promise;
    events.push("a:end");
  });
  const b = queue.run("clinic:telegram:b", async () => {
    events.push("b:start");
    startedB.resolve();
    await gateB.promise;
    events.push("b:end");
  });

  try {
    await Promise.all([startedA.promise, startedB.promise]);
    assert.equal(events.includes("a:start"), true);
    assert.equal(events.includes("b:start"), true);
  } finally {
    gateA.resolve();
    gateB.resolve();
  }

  await Promise.all([a, b]);
});

test("PF-008: a failed turn releases the contact queue", async () => {
  const queue = createRuntimeTurnSerialQueue();
  const events: string[] = [];

  const first = queue.run("clinic:whatsapp:patient", async () => {
    events.push("first");
    throw new Error("boom");
  });
  const second = queue.run("clinic:whatsapp:patient", async () => {
    events.push("second");
    return "ok";
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  assert.deepEqual(events, ["first", "second"]);
});

test("PF-008: serialization key is scoped by clinic, channel, and contact", () => {
  const base = buildRuntimeTurnSerialKey({
    clinic_code: "clinic_1",
    channel: "telegram",
    external_user_id: "42",
    chat_id: "99",
  });
  assert.equal(base, JSON.stringify(["clinic_1", "telegram", "42"]));

  assert.notEqual(base, buildRuntimeTurnSerialKey({
    clinic_code: "clinic_2",
    channel: "telegram",
    external_user_id: "42",
  }));
  assert.notEqual(base, buildRuntimeTurnSerialKey({
    clinic_code: "clinic_1",
    channel: "whatsapp",
    external_user_id: "42",
  }));
});
