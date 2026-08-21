import assert from "node:assert/strict";
import test from "node:test";

import { classifyClinicCardFailure } from "../src/integrations/cliniccard/clinicCardFailurePolicy.ts";

test("PF-012: transient read timeout is safe to retry", () => {
  assert.deepEqual(
    classifyClinicCardFailure({ code: "cliniccard_timeout", message: "timeout" }, "read"),
    { transient: true, safe_to_retry: true, outcome: "known_failed" },
  );
});

test("PF-012: write timeout is outcome-unknown and not safe to retry blindly", () => {
  assert.deepEqual(
    classifyClinicCardFailure({ code: "cliniccard_timeout", message: "timeout" }, "write"),
    { transient: true, safe_to_retry: false, outcome: "unknown" },
  );
});

test("PF-012: HTTP 503 write is outcome-unknown", () => {
  assert.deepEqual(
    classifyClinicCardFailure({ code: "cliniccard_http_error", message: "HTTP 503: upstream unavailable" }, "write"),
    { transient: true, safe_to_retry: false, outcome: "unknown" },
  );
});

test("PF-012: HTTP 400 write is a definite non-retryable failure", () => {
  assert.deepEqual(
    classifyClinicCardFailure({ code: "cliniccard_http_error", message: "HTTP 400: invalid request" }, "write"),
    { transient: false, safe_to_retry: false, outcome: "known_failed" },
  );
});
