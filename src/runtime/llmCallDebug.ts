export interface RuntimeLlmCallDebug {
  runtime_gate_called: boolean;
  turn_understanding_called: boolean;
  legacy_case_router_called: boolean;
  main_agent_called: boolean;
  total_llm_calls: number;
}

export type RuntimeLlmCallDebugFlags = Partial<Omit<RuntimeLlmCallDebug, "total_llm_calls">>;

export function buildRuntimeLlmCallDebug(flags: RuntimeLlmCallDebugFlags = {}): RuntimeLlmCallDebug {
  const debug = {
    runtime_gate_called: flags.runtime_gate_called ?? false,
    turn_understanding_called: flags.turn_understanding_called ?? false,
    legacy_case_router_called: flags.legacy_case_router_called ?? false,
    main_agent_called: flags.main_agent_called ?? false,
  };

  return {
    ...debug,
    total_llm_calls: countRuntimeLlmCallFlags(debug),
  };
}

export function mergeRuntimeLlmCallDebug(
  first?: unknown,
  second?: unknown,
): RuntimeLlmCallDebug {
  const firstFlags = readRuntimeLlmCallDebugFlags(first);
  const secondFlags = readRuntimeLlmCallDebugFlags(second);
  return buildRuntimeLlmCallDebug({
    runtime_gate_called: firstFlags.runtime_gate_called || secondFlags.runtime_gate_called,
    turn_understanding_called: firstFlags.turn_understanding_called || secondFlags.turn_understanding_called,
    legacy_case_router_called: firstFlags.legacy_case_router_called || secondFlags.legacy_case_router_called,
    main_agent_called: firstFlags.main_agent_called || secondFlags.main_agent_called,
  });
}

export function readRuntimeLlmCallDebugFlags(raw: unknown): RuntimeLlmCallDebugFlags {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    runtime_gate_called: record.runtime_gate_called === true,
    turn_understanding_called: record.turn_understanding_called === true,
    legacy_case_router_called: record.legacy_case_router_called === true,
    main_agent_called: record.main_agent_called === true,
  };
}

function countRuntimeLlmCallFlags(flags: Omit<RuntimeLlmCallDebug, "total_llm_calls">): number {
  return [
    flags.runtime_gate_called,
    flags.turn_understanding_called,
    flags.legacy_case_router_called,
    flags.main_agent_called,
  ].filter(Boolean).length;
}
