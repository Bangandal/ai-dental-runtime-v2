from pathlib import Path


def replace_last_test(path: str, marker: str, replacement: str) -> None:
    p = Path(path)
    s = p.read_text()
    if s.count(marker) != 1:
        raise SystemExit(f"{path}: marker count {s.count(marker)} for {marker}")
    start = s.index(marker)
    tail = s[start:]
    if not tail.rstrip().endswith("});"):
        raise SystemExit(f"{path}: structural test is not the final test")
    p.write_text(s[:start] + replacement.rstrip() + "\n")

replace_last_test(
    "tests/r3iBookingApplyExecutionPreparation.test.ts",
    'test("R3u structure: complete turn-batch owner delegates booking target plumbing to one preparation boundary"',
    r'''test("R3v structure: roundless orchestrator reaches booking preparation only through the complete batch owner", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const batchSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.match(loopSource, /from\s+["']\.\/runtimeTurnModelToolOrchestrator\.ts["']/);
  assert.equal(loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length, 1);
  assert.doesNotMatch(loopSource, /runtimeTurnToolBatch\.ts/);
  assert.doesNotMatch(loopSource, /prepareBookingApplyExecution\(/);

  assert.match(orchestratorSource, /from\s+["']\.\/runtimeTurnToolBatch\.ts["']/);
  assert.equal(
    orchestratorSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length,
    1,
    "roundless orchestrator must enter the complete batch owner through one callback path",
  );
  assert.doesNotMatch(orchestratorSource, /prepareBookingApplyExecution\(/);

  assert.match(batchSource, /from\s+["']\.\/bookingApplyExecutionPreparation\.ts["']/);
  assert.equal(
    batchSource.match(/prepareBookingApplyExecution\(\{/g)?.length,
    1,
    "complete batch owner must prepare the booking target through one deterministic boundary",
  );
  assert.doesNotMatch(loopSource, /from\s+["']\.\/bookingSubjectExecutionResolver\.ts["']/);
  assert.doesNotMatch(loopSource, /bootstrapRegistryFromBookingApplyArgs/);
  assert.doesNotMatch(loopSource, /parseSubjectTarget/);
  assert.doesNotMatch(loopSource, /resolveBookingExecutionSubject/);
});'''
)

replace_last_test(
    "tests/r3lRuntimeToolRequestExecution.test.ts",
    'test("R3u structure: complete turn-batch owner contains policy-backed write execution plumbing"',
    r'''test("R3v structure: roundless orchestration reaches canonical write execution only through the complete batch owner", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const batchSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.equal(loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length, 1);
  assert.doesNotMatch(loopSource, /executeRuntimeTurnToolBatch\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeToolRequest\(/);
  assert.equal(orchestratorSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length, 1);
  assert.doesNotMatch(orchestratorSource, /executeRuntimeToolRequest\(/);
  assert.match(batchSource, /from ["']\.\/runtimeToolRequestExecution\.ts["']/);
  assert.equal(
    batchSource.match(/executeRuntimeToolRequest\(\{/g)?.length,
    1,
    "complete batch owner must use the canonical request execution pipeline for booking writes",
  );
  assert.match(loopSource, /export \{ buildSubjectAwarePhoneFields, hasSubjectOrContactPhone \} from ["']\.\/runtimeToolRequestExecution\.ts["']/);
  assert.doesNotMatch(loopSource, /applyToolPolicy\(/);
  assert.doesNotMatch(loopSource, /executeAllowedTools\(/);
  assert.doesNotMatch(loopSource, /buildTruthSnapshot\(/);
  assert.doesNotMatch(loopSource, /buildPlannerFromAgentToolRequest\(/);
  assert.doesNotMatch(loopSource, /resolveTruthSnapshot\(/);
  assert.doesNotMatch(loopSource, /buildExecutionContext\(/);
  assert.doesNotMatch(loopSource, /convertToolExecutionResult\(/);
});'''
)

replace_last_test(
    "tests/r3qBoundedToolBatchLoop.test.ts",
    'test("R3u structure: bounded continuation is fed by the complete turn-batch handler"',
    r'''test("R3v structure: bounded continuation flows through roundless orchestrator and complete batch owner", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const handlerSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");
  const kernelSource = await readFile(resolve(thisDir, "../src/runtime/runtimeToolBatchKernel.ts"), "utf8");

  assert.match(loopSource, /import \{ runRuntimeTurnModelToolOrchestration \} from ["']\.\/runtimeTurnModelToolOrchestrator\.ts["']/);
  assert.equal(loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length, 1);
  assert.doesNotMatch(loopSource, /executeRuntimeTurnToolBatch\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeToolBatchKernel/);
  assert.doesNotMatch(loopSource, /executeRuntimeNonWriteToolBatch/);

  assert.match(orchestratorSource, /runRuntimeBoundedModelToolLoop\(\{/);
  assert.equal(orchestratorSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length, 1);
  assert.equal(handlerSource.match(/executeRuntimeToolBatchKernel\(\{/g)?.length, 1);
  assert.match(kernelSource, /import \{ executeRuntimeNonWriteToolBatch \} from ["']\.\/runtimeNonWriteToolBatch\.ts["']/);
  assert.equal(kernelSource.match(/executeRuntimeNonWriteToolBatch\(\{/g)?.length, 1);
  assert.match(orchestratorSource, /tool_results: batch\.tool_results/);
});'''
)

replace_last_test(
    "tests/r3rSecondBatchKernelOwnership.test.ts",
    'test("R3u structure: both model tool phases delegate to one complete turn-batch handler"',
    r'''test("R3v structure: all executable model tool batches share one roundless complete-batch path", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const orchestratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnModelToolOrchestrator.ts"), "utf8");
  const handlerSource = await readFile(resolve(thisDir, "../src/runtime/runtimeTurnToolBatch.ts"), "utf8");

  assert.equal(
    loopSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length,
    1,
    "legacy shell must expose one roundless model/tool orchestration entry",
  );
  assert.doesNotMatch(loopSource, /executeRuntimeTurnToolBatch\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeToolBatchKernel\(/);
  assert.doesNotMatch(loopSource, /executeRuntimeNonWriteToolBatch/);
  assert.equal(
    orchestratorSource.match(/executeRuntimeTurnToolBatch\(\{/g)?.length,
    1,
    "every executable iterator batch must enter the same complete batch callback",
  );
  assert.equal(
    handlerSource.match(/executeRuntimeToolBatchKernel\(\{/g)?.length,
    1,
    "complete handler must retain one deterministic state-kernel owner",
  );
});'''
)

replace_last_test(
    "tests/r3tRuntimeModelIteration.test.ts",
    'test("R3t structure: the main runTurn shell uses one bounded iteration transport state"',
    r'''test("R3v structure: the main runTurn shell delegates one bounded iteration transport state to the iterator", async () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const loopSource = await readFile(resolve(thisDir, "../src/runtime/runtimeAgentLoopLegacy.ts"), "utf8");
  const iteratorSource = await readFile(resolve(thisDir, "../src/runtime/runtimeBoundedModelToolLoop.ts"), "utf8");
  const helperBoundary = loopSource.indexOf("// ── Multiple-blocked booking.apply helper");
  assert.ok(helperBoundary > 0);
  const runTurnSource = loopSource.slice(0, helperBoundary);

  assert.match(runTurnSource, /createRuntimeModelIterationState\(conversationId\)/);
  assert.equal(runTurnSource.match(/runRuntimeTurnModelToolOrchestration\(\{/g)?.length, 1);
  assert.equal(
    runTurnSource.match(/invokeRuntimeModelIteration\(\{/g)?.length ?? 0,
    0,
    "legacy shell must not own numbered model steps anymore",
  );
  assert.equal(
    iteratorSource.match(/invokeRuntimeModelIteration\(\{/g)?.length,
    1,
    "generic iterator must be the single owner of bounded model-call progression",
  );
  assert.doesNotMatch(
    runTurnSource,
    /invokeRuntimeModelCall\(\{/,
    "main runTurn path must not bypass bounded iteration transport",
  );
});'''
)
