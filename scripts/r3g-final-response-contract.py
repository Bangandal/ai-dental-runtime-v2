from pathlib import Path

agent_path = Path("src/runtime/openaiRuntimeAgent.ts")
workflow_path = Path(".github/workflows/runtime-tests.yml")
script_path = Path(__file__)

agent = agent_path.read_text()
old = '    `On switch/create: subject_intent:{action:"none"|"switch_subject"|"create_subjects",target:"self"|"active"|"other_person",person_ref:null|string,display_name:null|string,count:null|1..4,labels:[],confidence:"low"|"medium"|"high"}.`,\n'
new = '    `On switch/create, include subject_intent in final_response: {action:"none"|"switch_subject"|"create_subjects",target:"self"|"active"|"other_person",person_ref:null|string,display_name:null|string,count:null|1..4,labels:[],confidence:"low"|"medium"|"high"}.`,\n'
if old not in agent:
    raise SystemExit("R3g subject_intent line not found")
agent = agent.replace(old, new, 1)
old_phone = '    `pending_typed_phone: ask owner; return phone_ownership_intent:{action:"assign_pending_phone"|"share_sender_contact"|"none",target:"self"|"active"|"other_person",person_ref:null|string,confidence:"low"|"medium"|"high"}.`,\n'
new_phone = '    `pending_typed_phone: ask owner; include phone_ownership_intent in final_response: {action:"assign_pending_phone"|"share_sender_contact"|"none",target:"self"|"active"|"other_person",person_ref:null|string,confidence:"low"|"medium"|"high"}.`,\n'
if old_phone not in agent:
    raise SystemExit("R3g phone_ownership_intent line not found")
agent_path.write_text(agent.replace(old_phone, new_phone, 1))

workflow_path.write_text('''name: Runtime tests\n\non:\n  pull_request:\n  push:\n    branches:\n      - ai-dental-frontdesk-core\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: runtime-tests-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  test:\n    name: npm test\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n\n      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n\n      - name: Install dependencies\n        run: npm ci\n\n      - name: Run full test suite\n        shell: bash\n        run: |\n          set -o pipefail\n          npm test 2>&1 | tee test-output.txt\n\n      - name: Upload test output\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: runtime-test-output\n          path: test-output.txt\n          if-no-files-found: error\n''')
script_path.unlink()
print("R3g final_response contract fixed; workflow restored; script removed")
