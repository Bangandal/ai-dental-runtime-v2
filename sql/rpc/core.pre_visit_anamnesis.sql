-- Pre-visit anamnesis table
-- Run manually via Supabase SQL editor or psql when ready to activate ANAMNESIS_ENABLED=true
-- DO NOT run automatically — requires explicit approval from owner

CREATE TABLE IF NOT EXISTS core.pre_visit_anamnesis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id text NOT NULL,
  contact_id uuid REFERENCES core.channel_contacts(id),
  cliniccard_visit_id text,
  visit_reason text,
  allergies text,
  chronic_conditions text,
  pregnancy_status text,
  current_medications text,
  refused boolean DEFAULT false,
  collected_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pre_visit_anamnesis_clinic_id_idx ON core.pre_visit_anamnesis (clinic_id);
CREATE INDEX IF NOT EXISTS pre_visit_anamnesis_contact_id_idx ON core.pre_visit_anamnesis (contact_id);
CREATE INDEX IF NOT EXISTS pre_visit_anamnesis_cliniccard_visit_id_idx ON core.pre_visit_anamnesis (cliniccard_visit_id);
