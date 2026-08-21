from pathlib import Path

agent_path = Path("src/runtime/openaiRuntimeAgent.ts")
bridge_path = Path("src/runtime/modelPersonIntentBridge.ts")
workflow_path = Path(".github/workflows/runtime-tests.yml")
script_path = Path(__file__)

agent = agent_path.read_text()
old_block = '''    // ── BOOKING SUBJECTS ──────────────────────────────────────────────────────\n    "## BOOKING SUBJECTS",\n    "subject_1=sender/self, subject_2=first other person, subject_3/4=additional.",\n    "Include subject_intent in final_response on subject switch or new person (omit when action='none').",\n    `subject_intent: {action:"none"|"switch_subject"|"create_subjects"|"create_or_switch_subject", target:self|mentioned_person|active, subject_id:null|subject_N, display_name:null|str, count:null|1..4, labels:[], confidence:low|medium|high}`,\n    "When pending_typed_phone is set: ask whose phone it is, include phone_ownership_intent in final_response.",\n    `phone_ownership_intent: {action:assign_pending_phone|share_sender_contact|none, target_subject_id:null|subject_N, confidence:low|medium|high}`,\n'''
new_block = '''    // ── BOOKING PEOPLE ────────────────────────────────────────────────────────\n    "## BOOKING PEOPLE",\n    "Treat people by business meaning. Never use or emit internal subject identifiers.",\n    "runtime_context.booking_subjects.subjects exposes human label/name plus person_kind and is_active. Use those fields to identify the intended person.",\n    "Include subject_intent in final_response only when switching person or creating another person.",\n    `subject_intent: {action:"none"|"switch_subject"|"create_subjects", target:"self"|"active"|"other_person", person_ref:null|string, display_name:null|string, count:null|1..4, labels:[], confidence:"low"|"medium"|"high"}`,\n    "For other_person, set person_ref to the exact visible label or patient_name when more than one other person exists. If the person is ambiguous, ask which person and do not guess.",\n    "When pending_typed_phone is set, ask whose phone it is and include phone_ownership_intent in final_response.",\n    `phone_ownership_intent: {action:"assign_pending_phone"|"share_sender_contact"|"none", target:"self"|"active"|"other_person", person_ref:null|string, confidence:"low"|"medium"|"high"}`,\n    "Never emit subject_id, target_subject_id, subject_1, subject_2, subject_3, or subject_4.",\n'''
if old_block not in agent:
    raise SystemExit("R3g canonical prompt marker not found")
agent = agent.replace(old_block, new_block, 1)
agent_path.write_text(agent)

bridge = bridge_path.read_text()
const_start = bridge.index('const SEMANTIC_PERSON_PROTOCOL = [')
const_end_marker = '].join("\\n");\n\n'
const_end = bridge.index(const_end_marker, const_start) + len(const_end_marker)
bridge = bridge[:const_start] + bridge[const_end:]
old_projection = '''/**\n * Project the historical runtime instruction to the semantic model-facing people protocol.\n * The internal runtime may keep legacy subject_N terminology while the model never sees it.\n */\nexport function projectModelPersonInstruction(systemInstruction: string): string {\n  const startMarker = "## BOOKING SUBJECTS";\n  const endMarker = "## BOOKING FLOW";\n  const start = systemInstruction.indexOf(startMarker);\n  const end = systemInstruction.indexOf(endMarker, start >= 0 ? start : 0);\n  if (start < 0 || end < 0 || end <= start) {\n    return systemInstruction;\n  }\n  return `${systemInstruction.slice(0, start)}${SEMANTIC_PERSON_PROTOCOL}\\n\\n${systemInstruction.slice(end)}`;\n}\n'''
new_projection = '''/**\n * The runtime prompt is already canonical and business-semantic. Keep this boundary as\n * an identity function so the OpenAI caller remains decoupled from prompt ownership.\n */\nexport function projectModelPersonInstruction(systemInstruction: string): string {\n  return systemInstruction;\n}\n'''
if old_projection not in bridge:
    raise SystemExit("R3g projection marker not found")
bridge = bridge.replace(old_projection, new_projection, 1)
bridge_path.write_text(bridge)

workflow_path.write_text('''name: Runtime tests\n\non:\n  pull_request:\n  push:\n    branches:\n      - ai-dental-frontdesk-core\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: runtime-tests-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  test:\n    name: npm test\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n\n      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n\n      - name: Install dependencies\n        run: npm ci\n\n      - name: Run full test suite\n        shell: bash\n        run: |\n          set -o pipefail\n          npm test 2>&1 | tee test-output.txt\n\n      - name: Upload test output\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: runtime-test-output\n          path: test-output.txt\n          if-no-files-found: error\n''')

script_path.unlink()
print("R3g canonical people prompt applied; workflow restored; migration script removed")
