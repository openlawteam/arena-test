CREATE TABLE IF NOT EXISTS arena_messages (
  id text PRIMARY KEY,
  sender_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  sender_connection_id text NOT NULL,
  sender_bot_name text NOT NULL,
  recipient_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  recipient_connection_id text NOT NULL,
  recipient_bot_name text NOT NULL,
  body text NOT NULL
    CHECK (char_length(body) BETWEEN 1 AND 1000),
  reply_to_id text
    REFERENCES arena_messages (id) ON DELETE RESTRICT,
  remaining_turns smallint NOT NULL
    CHECK (remaining_turns BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  wake_status text NOT NULL DEFAULT 'pending'
    CHECK (wake_status IN ('pending', 'notified', 'failed')),
  wake_attempted_at timestamptz,
  wake_upstream_status smallint
    CHECK (
      wake_upstream_status IS NULL
      OR wake_upstream_status BETWEEN 100 AND 599
    )
);

-- A message may receive only one direct reply. Combined with remaining_turns,
-- this makes every conversation a finite chain instead of a branching loop.
CREATE UNIQUE INDEX IF NOT EXISTS arena_messages_one_reply_idx
  ON arena_messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS arena_messages_stream_idx
  ON arena_messages (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS arena_messages_inbox_idx
  ON arena_messages (recipient_token_hash, created_at ASC, id ASC)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS arena_agent_send_state (
  sender_token_hash text PRIMARY KEY
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  last_sent_at timestamptz NOT NULL
);
