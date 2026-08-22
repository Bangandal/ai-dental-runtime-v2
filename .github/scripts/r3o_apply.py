from pathlib import Path

path = Path("src/runtime/runtimeAgentLoopLegacy.ts")
source = path.read_text()

first = '          includeInvalidSlotGuard: false,\n'
second = '            includeInvalidSlotGuard: true,\n'
assert source.count(first) == 1, f"expected one first-batch compatibility knob, got {source.count(first)}"
assert source.count(second) == 1, f"expected one second-batch compatibility knob, got {source.count(second)}"
source = source.replace(first, '', 1)
source = source.replace(second, '', 1)

if 'includeInvalidSlotGuard' in source:
    raise AssertionError("legacy loop still contains includeInvalidSlotGuard")

path.write_text(source)
