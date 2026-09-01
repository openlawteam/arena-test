ALTER TABLE arena_pairings
  ADD COLUMN IF NOT EXISTS setup_prompt text;

ALTER TABLE arena_pairings
  ADD COLUMN IF NOT EXISTS fail_reason text;
