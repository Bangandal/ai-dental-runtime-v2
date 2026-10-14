export interface ExtractedAnamnesis {
  visit_reason: string | null;
  allergies: string | null;
  chronic_conditions: string | null;
  pregnancy_status: string | null;
  current_medications: string | null;
  collected_at: string;
  refused: boolean;
}

export function extractAnamnesisFromFinalResponse(
  finalResponse: Record<string, unknown> | undefined
): ExtractedAnamnesis | null {
  if (!finalResponse) return null;
  const a = finalResponse.anamnesis_data as Record<string, unknown> | undefined;
  if (!a || (!a.completed && !a.refused)) return null;
  return {
    visit_reason: typeof a.visit_reason === "string" ? a.visit_reason : null,
    allergies: typeof a.allergies === "string" ? a.allergies : null,
    chronic_conditions: typeof a.chronic_conditions === "string" ? a.chronic_conditions : null,
    pregnancy_status: typeof a.pregnancy_status === "string" ? a.pregnancy_status : null,
    current_medications: typeof a.current_medications === "string" ? a.current_medications : null,
    collected_at: new Date().toISOString(),
    refused: a.refused === true,
  };
}
