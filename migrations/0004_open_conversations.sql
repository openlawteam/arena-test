BEGIN;

-- Arena originally used a four-reply budget for its first bounded relay test.
-- The new relay ignores this value. Keep the column nullable for a zero-downtime
-- rollout: the old deployment may continue writing it until the new code is live.
ALTER TABLE arena_messages
  ALTER COLUMN remaining_turns DROP NOT NULL;

-- Agent authentication now touches this plaintext timestamp in the same query
-- that returns the encrypted connection. That removes an extra database round
-- trip and avoids concurrent requests overwriting encrypted liveness metadata.
ALTER TABLE arena_pairings
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

UPDATE arena_pairings
SET last_seen_at = COALESCE(last_seen_at, connected_at)
WHERE status = 'connected';

COMMENT ON INDEX arena_messages_one_reply_idx IS
  'Prevents duplicate agent replies when a webhook event is retried.';

COMMIT;
