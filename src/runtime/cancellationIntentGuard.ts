const FAIL_CLOSED_PATTERNS: RegExp[] = [
  // ── Uncertainty / indecision (must precede affirmative patterns) ──────────
  // English uncertainty
  /i'?m\s+not\s+sure/iu,
  /i\s+am\s+not\s+sure/iu,
  /not\s+sure\s+(?:if|whether)/iu,
  /i'?m\s+unsure/iu,
  /i\s+am\s+unsure/iu,
  /unsure\s+(?:if|whether)/iu,
  /don'?t\s+know\s+(?:if|whether)/iu,
  /do\s+not\s+know\s+(?:if|whether)/iu,
  /haven'?t\s+decided/iu,
  /have\s+not\s+decided/iu,
  /not\s+decided/iu,
  // Russian uncertainty
  /не\s+уверен/iu,
  /не\s+знаю/iu,
  /не\s+решил/iu,
  /ещё\s+не\s+решил/iu,
  /отменять\s+или\s+нет/iu,
  /отменить\s+или\s+нет/iu,
  // Czech uncertainty
  /nejsem\s+si\s+(?:jist[ýá]|jist)\b/iu,
  /nevím,?\s+(?:jestli|zda)/iu,
  /nerozhodl/iu,

  // ── Russian negation ──────────────────────────────────────────────────────
  /не\s+отмен/iu,
  /не\s+надо\s+отмен/iu,
  // Russian deliberative / hypothetical / informational
  /стоит\s+ли\s+отмен/iu,
  /нужно\s+ли\s+отмен/iu,
  /следует\s+ли\s+отмен/iu,
  /думаю\s+(?:об?\s+|насчёт\s+)?отмен/iu,
  /может\s+(?:быть\s+)?отмен/iu,
  /если\s+(?:я\s+|бы\s+)?отмен/iu,
  /можно\s+(?:ли\s+)?отмен/iu,
  /нельзя\s+отмен/iu,
  /рассматриваю/iu,
  /взвешиваю/iu,
  // English negation
  /don'?t\s+cancel/iu,
  /do\s+not\s+cancel/iu,
  // English deliberative / hypothetical / informational
  /should\s+i\s+cancel/iu,
  /can\s+i\s+cancel/iu,
  /could\s+i\s+cancel/iu,
  /am\s+i\s+able\s+to\s+cancel/iu,
  /is\s+it\s+possible\s+to\s+cancel/iu,
  /would\s+it\s+be\b/iu,
  /i\s+might\s+cancel/iu,
  /thinking\s+about\s+cancell?/iu,
  /consider(?:ing)?\s+cancell?/iu,
  /what\s+if/iu,
  /if\s+i\s+cancel/iu,
  /can\s+(?:it\s+|an?\s+appointment\s+)?be\s+cancel/iu,
  // Czech negation
  /nezrušuj/iu,
  /nechci\s+rušit/iu,
  // Czech deliberative
  /mám\s+zrušit/iu,
  /mohu\s+zrušit/iu,
  /přemýšlím\s+o\s+zrušení/iu,
  /uvažuji\s+o\s+zrušení/iu,
  /mohl\s+bych\s+zrušit/iu,
];

const AFFIRMATIVE_PATTERNS: RegExp[] = [
  // Russian imperatives / explicit desire
  /(?<!\p{L})отмени(?:те)?(?!\p{L})/iu,
  /хочу\s+отменить/iu,
  /нужно\s+отменить/iu,
  /прошу\s+отменить/iu,
  /пожалуйста\s+отмен/iu,
  /отказываюсь\s+от\s+записи/iu,
  /снимите\s+запись/iu,
  /уберите\s+запись/iu,
  // English imperative / explicit desire (narrow — no bare \bcancel\b)
  /please\s+cancel/iu,
  /cancel\s+(?:my|the)\s+(?:appointment|visit|booking|slot)/iu,
  /i\s+(?:want|need)\s+to\s+cancel/iu,
  /cancel\s+it\b/iu,
  // Czech imperatives / explicit desire
  /zrušte\b/iu,
  /chci\s+zrušit/iu,
  /prosím\s+zruš/iu,
];

export function detectExplicitCancellationRequest(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;

  if (FAIL_CLOSED_PATTERNS.some((re) => re.test(normalized))) {
    return false;
  }

  if (AFFIRMATIVE_PATTERNS.some((re) => re.test(normalized))) {
    return true;
  }

  // Short standalone imperative (≤ 3 words): "cancel", "Cancel!", etc.
  if (normalized.split(/\s+/).length <= 3 && /^\s*cancel\s*[.!?]?\s*$/iu.test(normalized)) {
    return true;
  }

  return false;
}
