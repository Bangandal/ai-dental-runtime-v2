export interface VoiceCallContext {
  callSid: string;
  streamSid: string;
  callerPhone?: string;
  calledNumber?: string;
  conversationId?: string;
  startedAt: number;
}

export interface VoiceCallRegistration {
  callSid: string;
  streamSid: string;
  callerPhone?: string;
  calledNumber?: string;
}

/**
 * Ephemeral transport correlation only. Raw phone numbers never leave this in-memory
 * registry and are deleted when the call closes or the TTL expires.
 */
export class VoiceCallContextRegistry {
  private readonly byCallSid = new Map<string, VoiceCallContext>();
  private readonly callSidByConversationId = new Map<string, string>();

  constructor(private readonly ttlMs = 2 * 60 * 60 * 1000) {}

  register(input: VoiceCallRegistration, now = Date.now()): VoiceCallContext {
    this.prune(now);
    const existing = this.byCallSid.get(input.callSid);
    const context: VoiceCallContext = {
      callSid: input.callSid,
      streamSid: input.streamSid,
      ...(input.callerPhone ? { callerPhone: input.callerPhone } : {}),
      ...(input.calledNumber ? { calledNumber: input.calledNumber } : {}),
      ...(existing?.conversationId ? { conversationId: existing.conversationId } : {}),
      startedAt: existing?.startedAt ?? now,
    };
    this.byCallSid.set(input.callSid, context);
    return { ...context };
  }

  bindConversation(callSid: string, conversationId: string): VoiceCallContext | null {
    if (!callSid || !conversationId) return null;
    const context = this.byCallSid.get(callSid);
    if (!context) return null;
    const updated = { ...context, conversationId };
    this.byCallSid.set(callSid, updated);
    this.callSidByConversationId.set(conversationId, callSid);
    return { ...updated };
  }

  getByConversationId(conversationId: string, now = Date.now()): VoiceCallContext | null {
    this.prune(now);
    const callSid = this.callSidByConversationId.get(conversationId);
    if (!callSid) return null;
    const context = this.byCallSid.get(callSid);
    return context ? { ...context } : null;
  }

  getByCallSid(callSid: string, now = Date.now()): VoiceCallContext | null {
    this.prune(now);
    const context = this.byCallSid.get(callSid);
    return context ? { ...context } : null;
  }

  finishByCallSid(callSid: string): void {
    const context = this.byCallSid.get(callSid);
    if (context?.conversationId) this.callSidByConversationId.delete(context.conversationId);
    this.byCallSid.delete(callSid);
  }

  finishByConversationId(conversationId: string): void {
    const callSid = this.callSidByConversationId.get(conversationId);
    this.callSidByConversationId.delete(conversationId);
    if (callSid) this.byCallSid.delete(callSid);
  }

  private prune(now: number): void {
    for (const [callSid, context] of this.byCallSid) {
      if (now - context.startedAt <= this.ttlMs) continue;
      if (context.conversationId) this.callSidByConversationId.delete(context.conversationId);
      this.byCallSid.delete(callSid);
    }
  }
}
