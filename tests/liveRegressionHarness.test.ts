import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`live regression runner exited ${code}: ${stderr}`));
    });
  });
}

test("live regression replays source turns with stable message ids and appends booking write probe", async () => {
  const requests: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, any>);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        trace_id: `trace_${requests.length}`,
        final_patient_reply: "ok",
        tool_results: [],
        side_effects: [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const dir = await mkdtemp(join(tmpdir(), "dental-live-regression-"));
    const source = join(dir, "source.jsonl");
    const output = join(dir, "output.jsonl");
    await writeFile(source, `${JSON.stringify({
      id: "S01",
      turns: [{ user: "Добрий день, хочу записатися" }],
    })}\n`, "utf8");

    await runProcess(
      ["--import", "tsx/esm", "scripts/run-dental-live-regression.ts"],
      {
        ...process.env,
        SCENARIOS_FILE: source,
        OUTPUT_FILE: output,
        BASE_URL: `http://127.0.0.1:${address.port}`,
        CLINIC_CODE: "clinic_test",
        RUN_WRITE_TESTS: "1",
        RUN_ID: "test_run",
      },
    );

    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.text, "Добрий день, хочу записатися");
    assert.match(String(requests[1]?.text), /консультац/i);
    assert.match(String(requests[2]?.text), /Перший запропонований час/i);

    const messageIds = requests.map((request) => request.meta?.message_id);
    assert.deepEqual(messageIds, [
      "test_run:S01:1",
      "test_run:S01:2",
      "test_run:S01:3",
    ]);
    assert.equal(new Set(messageIds).size, 3);

    const outputRows = (await readFile(output, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(outputRows.length, 1);
    assert.equal(outputRows[0].booking_probe.enabled, true);
    assert.equal(outputRows[0].booking_probe.write_enabled, true);
    assert.equal(outputRows[0].booking_probe.stable_message_ids, true);
    assert.equal(outputRows[0].turns.at(-1).phase, "booking_probe");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live regression skips booking tail for blocked race/fault cases", async () => {
  const requests: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, any>);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ trace_id: "trace_r02", final_patient_reply: "ok", side_effects: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const dir = await mkdtemp(join(tmpdir(), "dental-live-regression-skip-"));
    const source = join(dir, "source.jsonl");
    const output = join(dir, "output.jsonl");
    await writeFile(source, `${JSON.stringify({ id: "R02", turns: [{ user: "race probe" }] })}\n`, "utf8");

    await runProcess(
      ["--import", "tsx/esm", "scripts/run-dental-live-regression.ts"],
      {
        ...process.env,
        SCENARIOS_FILE: source,
        OUTPUT_FILE: output,
        BASE_URL: `http://127.0.0.1:${address.port}`,
        RUN_WRITE_TESTS: "1",
        RUN_ID: "test_run_skip",
      },
    );

    assert.equal(requests.length, 1);
    const outputRow = JSON.parse((await readFile(output, "utf8")).trim());
    assert.equal(outputRow.booking_probe.enabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
