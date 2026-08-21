CREATE TABLE IF NOT EXISTS arena_pairings (
  token_hash text PRIMARY KEY,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'connected', 'consumed')),
  encrypted_connection text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  connected_at timestamptz,
  consumed_at timestamptz,
  claim_hash text
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_pairings_claim_hash_idx
  ON arena_pairings (claim_hash);

CREATE INDEX IF NOT EXISTS arena_pairings_expiry_idx
  ON arena_pairings (expires_at);
