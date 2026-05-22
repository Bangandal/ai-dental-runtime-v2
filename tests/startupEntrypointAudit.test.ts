import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);

test("startup audit: package.json defines start and preserves test command", async () => {
  const packageJsonRaw = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.test, "node --test tests/*.test.ts");
  assert.equal(packageJson.scripts?.start, "node src/main.ts");
});

test("startup audit: repo has Dockerfile", async () => {
  const root = new URL("../", import.meta.url);
  const names = await fs.readdir(root);
  const dockerfiles = names.filter((name) => /^(Dockerfile(\..+)?)$/i.test(name));
  assert.equal(dockerfiles.includes("Dockerfile"), true);
});
