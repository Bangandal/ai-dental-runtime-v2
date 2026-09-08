import type { AdminNotificationResult } from "../integrations/adminNotify/adminNotifyTypes.ts";
import type { RuntimeResult } from "./runtimeRepositories.ts";

/** A model proposal, never evidence of delivery or a clinical finding. */
export interface StaffRequest {
  kind: "callback" | "document_update";
  patient_target: "self" | "other_person";
  person_ref: string;
  summary: string;
  preferred_contact_window: string | null;
  reply_language: "uk" | "ru" | "cs" | "en";
  /** Answers to other questions in the same message, excluding any staff-action claim. */
  additional_reply?: string;
}

export interface StaffRequestRecord {
  request_id: string;
  created: boolean;
  delivery_status: AdminNotificationResult["status"] | "pending";
}

export interface StaffRequestRepository {
  create(input: {
    clinic_id: string;
    contact_id: string;
    trace_id: string;
    request: StaffRequest;
    source_message: string;
  }): Promise<RuntimeResult<StaffRequestRecord>>;
  recordDelivery(input: {
    clinic_id: string;
    contact_id: string;
    request_id: string;
    delivery: AdminNotificationResult;
  }): Promise<RuntimeResult<{ ok: true }>>;
}

export interface StaffRequestProof {
  type: "staff_request";
  request_id: string | null;
  request_saved: boolean;
  delivery_status: AdminNotificationResult["status"] | "pending";
  delivery_recorded: boolean;
  may_claim_notified: boolean;
}

declare module "./openaiRuntimeAgent.ts" {
  interface RuntimeAgentFinalResponse {
    staff_request?: StaffRequest | null;
    /** A staff side-effect was proposed but failed deterministic schema validation. */
    staff_request_invalid?: boolean;
  }
  interface RuntimeAgentTurnResult {
    staff_request?: StaffRequest | null;
    staff_request_invalid?: boolean;
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= max ? result : null;
}

export function parseStaffRequest(raw: unknown): StaffRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== "callback" && value.kind !== "document_update") return null;
  if (value.patient_target !== "self" && value.patient_target !== "other_person") return null;
  if (!["uk", "ru", "cs", "en"].includes(String(value.reply_language))) return null;
  const summary = text(value.summary, 1000);
  const personRef = text(value.person_ref, 200);
  if (!summary || !personRef) return null;
  const window = value.preferred_contact_window == null
    ? null : text(value.preferred_contact_window, 200);
  if (value.preferred_contact_window != null && !window) return null;
  const additionalReply = value.additional_reply == null ? null : text(value.additional_reply, 1500);
  if (value.additional_reply != null && !additionalReply) return null;
  return {
    kind: value.kind,
    patient_target: value.patient_target,
    person_ref: personRef,
    summary,
    preferred_contact_window: window,
    reply_language: value.reply_language as StaffRequest["reply_language"],
    ...(additionalReply ? { additional_reply: additionalReply } : {}),
  };
}

/**
 * additional_reply is model-controlled prose and therefore never carries side-effect
 * authority. Keep useful independent answers, but drop text that could assert staff or
 * doctor execution. The deterministic receipt remains the sole source of such claims.
 */
const STAFF_ACTION_CLAIM_PATTERN = /(уведом|повідом|передал|передала|передано|передан|передам|администратор|сотрудник|співробітник|personál|administrátor|staff|doctor|врач|лікар|lékař|received|reviewed|notified|informed|forwarded|отримав|отримано|получил|получено|переглян|переглянуто|просмотр|позвон|зателефон|callback)/i;

export function sanitizeStaffAdditionalReply(value: string | undefined): string | null {
  const normalized = text(value, 1500);
  if (!normalized) return null;
  return STAFF_ACTION_CLAIM_PATTERN.test(normalized) ? null : normalized;
}

export function staffRequestFailureReceipt(locale?: string | null): string {
  const normalized = (locale ?? "").trim().toLowerCase();
  if (normalized.startsWith("uk")) {
    return "Не вдалося обробити запит для співробітника. Будь ласка, зв’яжіться з клінікою напряму або спробуйте ще раз.";
  }
  if (normalized.startsWith("cs")) {
    return "Požadavek pro personál se nepodařilo zpracovat. Kontaktujte prosím kliniku přímo nebo to zkuste znovu.";
  }
  if (normalized.startsWith("en")) {
    return "I couldn’t process your request for staff. Please contact the clinic directly or try again.";
  }
  return "Не удалось обработать запрос для сотрудника. Пожалуйста, свяжитесь с клиникой напрямую или попробуйте ещё раз.";
}

/** This reply is an execution receipt. It never promises a doctor's action or timing. */
export function staffRequestReceipt(request: StaffRequest, proof: StaffRequestProof): string {
  const replies = {
    uk: {
      failed: "Не вдалося зберегти запит для співробітника. Будь ласка, зв’яжіться з клінікою напряму або спробуйте ще раз.",
      saved: "Запит збережено, але доставку повідомлення співробітнику не підтверджено. Будь ласка, зв’яжіться з клінікою напряму, якщо відповідь потрібна зараз.",
      callback: "Запит на зворотний дзвінок передано співробітнику. Бажаний час зазначено в запиті; лікар його ще не підтвердив.",
      document_update: "Дякую за оновлення. Ваше повідомлення про знімок або документ передано співробітнику. Отримання та перегляд лікарем ще не підтверджено.",
    },
    ru: {
      failed: "Не удалось сохранить запрос для сотрудника. Пожалуйста, свяжитесь с клиникой напрямую или попробуйте ещё раз.",
      saved: "Запрос сохранён, но доставка сообщения сотруднику не подтверждена. Пожалуйста, свяжитесь с клиникой напрямую, если ответ нужен сейчас.",
      callback: "Запрос на обратный звонок передан сотруднику. Желаемое время указано в запросе; врач его ещё не подтвердил.",
      document_update: "Спасибо за обновление. Ваше сообщение о снимке или документе передано сотруднику. Получение и просмотр врачом ещё не подтверждены.",
    },
    cs: {
      failed: "Požadavek pro personál se nepodařilo uložit. Kontaktujte prosím kliniku přímo nebo to zkuste znovu.",
      saved: "Požadavek je uložen, ale doručení zprávy personálu není potvrzeno. Pokud potřebujete odpověď hned, kontaktujte prosím kliniku přímo.",
      callback: "Požadavek na zpětné zavolání byl předán personálu. Preferovaný čas je uveden v požadavku; lékař jej zatím nepotvrdil.",
      document_update: "Děkujeme za aktualizaci. Vaše zpráva o snímku nebo dokumentu byla předána personálu. Přijetí a kontrola lékařem zatím nejsou potvrzeny.",
    },
    en: {
      failed: "I couldn’t save your request for staff. Please contact the clinic directly or try again.",
      saved: "Your request is saved, but delivery to staff has not been confirmed. Please contact the clinic directly if you need an answer now.",
      callback: "Your callback request has been passed to staff. Your preferred time is included in the request; the doctor has not confirmed it yet.",
      document_update: "Thank you for the update. Your report about the image or document has been passed to staff. Receipt and review by the doctor have not yet been confirmed.",
    },
  }[request.reply_language];
  if (!proof.request_saved) return replies.failed;
  if (!proof.may_claim_notified) return replies.saved;
  if (request.kind === "callback" && !request.preferred_contact_window) {
    return {
      uk: "Запит на зворотний дзвінок передано співробітнику. Час дзвінка ще не підтверджено.",
      ru: "Запрос на обратный звонок передан сотруднику. Время звонка ещё не подтверждено.",
      cs: "Požadavek na zpětné zavolání byl předán personálu. Čas hovoru zatím není potvrzen.",
      en: "Your callback request has been passed to staff. The call time has not yet been confirmed.",
    }[request.reply_language];
  }
  return replies[request.kind];
}
