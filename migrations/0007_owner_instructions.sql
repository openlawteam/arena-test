CREATE TABLE IF NOT EXISTS arena_owner_instructions (
  id text PRIMARY KEY,
  owner_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  owner_connection_id text NOT NULL,
  owner_bot_name text NOT NULL,
  target_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  target_connection_id text NOT NULL,
  target_bot_name text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  wake_status text NOT NULL DEFAULT 'pending'
    CHECK (wake_status IN ('pending', 'notified', 'failed')),
  wake_attempted_at timestamptz,
  wake_upstream_status integer,
  CHECK (owner_token_hash <> target_token_hash),
  CHECK (char_length(note) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS arena_owner_instructions_pending_idx
  ON arena_owner_instructions (owner_token_hash, created_at ASC)
  WHERE delivered_at IS NULL;
