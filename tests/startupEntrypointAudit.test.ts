import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);

test("startup audit: package.json defines the executable command in this repo", async () => {
  const packageJsonRaw = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.test, "node --test tests/*.test.ts");
  assert.equal(Object.prototype.hasOwnProperty.call(packageJson.scripts ?? {}, "start"), false);
});

test("startup audit: repo has no Docker/compose startup file", async () => {
  const root = new URL("../", import.meta.url);
  const names = await fs.readdir(root);
  const dockerish = names.filter((name) => /^(Dockerfile(\..+)?)$|docker-compose.*\.(yml|yaml)$|compose.*\.(yml|yaml)$/i.test(name));
  assert.deepEqual(dockerish, []);
});
