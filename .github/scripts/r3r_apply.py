from pathlib import Path

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

start_marker = '''      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n          return {\n            final_patient_reply: boundedOutput.final_response.final_patient_reply,'''
end_marker = '''      await saveConversationMemory(deps.conversationMemoryRepository, input, conversationId, debug);\n      return {\n        final_patient_reply: secondOutput.final_response.final_patient_reply,'''

start_count = source.count(start_marker)
end_count = source.count(end_marker)
if start_count != 1:
    raise SystemExit(f"expected one stale-tail start marker, found {start_count}")
if end_count != 1:
    raise SystemExit(f"expected one normal-final-response marker, found {end_count}")

start = source.index(start_marker)
end = source.index(end_marker, start)
if end <= start:
    raise SystemExit("invalid stale-tail marker order")

source = source[:start] + source[end:]
path.write_text(source)
print("R3r stale legacy second-batch tail removed")
