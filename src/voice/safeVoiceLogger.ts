export interface SafeVoiceLogFields {
  event: string;
  conversation_id?: string;
  call_sid?: string;
  stream_sid?: string;
  request_id?: string;
  turn_number?: number;
  stage?: string;
  latency_ms?: number;
  error_code?: string;
  connection_state?: string;
}

export function safeVoiceLog(fields: SafeVoiceLogFields): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString() };
  if (fields.event !== undefined) entry.event = fields.event;
  if (fields.conversation_id !== undefined) entry.conversation_id = fields.conversation_id;
  if (fields.call_sid !== undefined) entry.call_sid = fields.call_sid;
  if (fields.stream_sid !== undefined) entry.stream_sid = fields.stream_sid;
  if (fields.request_id !== undefined) entry.request_id = fields.request_id;
  if (fields.turn_number !== undefined) entry.turn_number = fields.turn_number;
  if (fields.stage !== undefined) entry.stage = fields.stage;
  if (fields.latency_ms !== undefined) entry.latency_ms = fields.latency_ms;
  if (fields.error_code !== undefined) entry.error_code = fields.error_code;
  if (fields.connection_state !== undefined) entry.connection_state = fields.connection_state;
  process.stderr.write(JSON.stringify(entry) + "\n");
}
