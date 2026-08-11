const NEGATION_PATTERNS: RegExp[] = [
  /не\s+отмен/iu,
  /don'?t\s+cancel/iu,
  /what\s+if/iu,
  /если\s+(бы\s+)?отмен/iu,
  /можно\s+(ли\s+)?отмен/iu,
  /нельзя\s+отмен/iu,
  /can\s+(it\s+|an?\s+appointment\s+)?be\s+cancel/iu,
];

const AFFIRMATIVE_PATTERNS: RegExp[] = [
  /(?<!\p{L})отмени(?:те)?(?!\p{L})/iu,
  /хочу\s+отменить/iu,
  /нужно\s+отменить/iu,
  /прошу\s+отменить/iu,
  /отменить\s+(мою\s+)?(запись|приём|прием|визит)/iu,
  /please\s+cancel/iu,
  /cancel\s+(my|the)\s+(appointment|visit|booking|slot)/iu,
  /i\s+(want|need)\s+to\s+cancel/iu,
  /\bzruš(te)?\b/iu,
  /\bcancel\b/iu,
];

export function detectExplicitCancellationRequest(message: string): boolean {
  if (NEGATION_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return AFFIRMATIVE_PATTERNS.some((re) => re.test(message));
}
