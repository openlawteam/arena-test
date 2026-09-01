BEGIN;

CREATE TABLE IF NOT EXISTS arena_conversations (
  id text PRIMARY KEY,
  kind text NOT NULL
    CHECK (kind IN ('global', 'direct', 'group')),
  title text
    CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 100),
  created_by_token_hash text
    REFERENCES arena_pairings (token_hash) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE arena_messages
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS thread_root_id text,
  ADD COLUMN IF NOT EXISTS audience_type text;

ALTER TABLE arena_messages
  ALTER COLUMN recipient_token_hash DROP NOT NULL,
  ALTER COLUMN recipient_connection_id DROP NOT NULL,
  ALTER COLUMN recipient_bot_name DROP NOT NULL;

DROP INDEX IF EXISTS arena_messages_one_reply_idx;

WITH RECURSIVE message_roots AS (
  SELECT id, id AS root_id
  FROM arena_messages
  WHERE reply_to_id IS NULL

  UNION ALL

  SELECT child.id, parent.root_id
  FROM arena_messages AS child
  JOIN message_roots AS parent ON child.reply_to_id = parent.id
)
UPDATE arena_messages AS message
SET
  conversation_id = message_roots.root_id,
  thread_root_id = message_roots.root_id,
  audience_type = CASE
    WHEN message.reply_to_id IS NULL THEN 'direct'
    ELSE 'thread'
  END
FROM message_roots
WHERE message.id = message_roots.id
  AND (
    message.conversation_id IS NULL
    OR message.thread_root_id IS NULL
    OR message.audience_type IS NULL
  );

INSERT INTO arena_conversations (
  id,
  kind,
  created_by_token_hash,
  created_at
)
SELECT
  root.id,
  'direct',
  root.sender_token_hash,
  root.created_at
FROM arena_messages AS root
WHERE root.reply_to_id IS NULL
ON CONFLICT (id) DO NOTHING;

ALTER TABLE arena_messages
  ALTER COLUMN conversation_id SET NOT NULL,
  ALTER COLUMN thread_root_id SET NOT NULL,
  ALTER COLUMN audience_type SET DEFAULT 'direct',
  ALTER COLUMN audience_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'arena_messages_conversation_fk'
      AND conrelid = 'arena_messages'::regclass
  ) THEN
    ALTER TABLE arena_messages
      ADD CONSTRAINT arena_messages_conversation_fk
      FOREIGN KEY (conversation_id)
      REFERENCES arena_conversations (id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'arena_messages_audience_type_check'
      AND conrelid = 'arena_messages'::regclass
  ) THEN
    ALTER TABLE arena_messages
      ADD CONSTRAINT arena_messages_audience_type_check
      CHECK (audience_type IN ('all', 'direct', 'group', 'thread'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS arena_conversation_participants (
  conversation_id text NOT NULL
    REFERENCES arena_conversations (id) ON DELETE CASCADE,
  agent_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  agent_connection_id text NOT NULL,
  agent_bot_name text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_token_hash)
);

CREATE TABLE IF NOT EXISTS arena_thread_participants (
  thread_root_id text NOT NULL,
  agent_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  agent_connection_id text NOT NULL,
  agent_bot_name text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_root_id, agent_token_hash)
);

CREATE TABLE IF NOT EXISTS arena_message_recipients (
  message_id text NOT NULL
    REFERENCES arena_messages (id) ON DELETE CASCADE,
  recipient_token_hash text NOT NULL
    REFERENCES arena_pairings (token_hash) ON DELETE CASCADE,
  recipient_connection_id text NOT NULL,
  recipient_bot_name text NOT NULL,
  delivered_at timestamptz,
  read_at timestamptz,
  wake_status text NOT NULL DEFAULT 'pending'
    CHECK (wake_status IN ('pending', 'notified', 'failed')),
  wake_attempted_at timestamptz,
  wake_upstream_status smallint
    CHECK (
      wake_upstream_status IS NULL
      OR wake_upstream_status BETWEEN 100 AND 599
    ),
  PRIMARY KEY (message_id, recipient_token_hash),
  CHECK (
    read_at IS NULL
    OR (
      delivered_at IS NOT NULL
      AND read_at >= delivered_at
    )
  )
);

INSERT INTO arena_conversation_participants (
  conversation_id,
  agent_token_hash,
  agent_connection_id,
  agent_bot_name,
  joined_at
)
SELECT DISTINCT ON (conversation_id, agent_token_hash)
  conversation_id,
  agent_token_hash,
  agent_connection_id,
  agent_bot_name,
  joined_at
FROM (
  SELECT
    conversation_id,
    sender_token_hash AS agent_token_hash,
    sender_connection_id AS agent_connection_id,
    sender_bot_name AS agent_bot_name,
    created_at AS joined_at
  FROM arena_messages

  UNION ALL

  SELECT
    conversation_id,
    recipient_token_hash,
    recipient_connection_id,
    recipient_bot_name,
    created_at
  FROM arena_messages
  WHERE recipient_token_hash IS NOT NULL
) AS legacy_participants
ORDER BY conversation_id, agent_token_hash, joined_at ASC
ON CONFLICT (conversation_id, agent_token_hash) DO NOTHING;

INSERT INTO arena_thread_participants (
  thread_root_id,
  agent_token_hash,
  agent_connection_id,
  agent_bot_name,
  joined_at
)
SELECT DISTINCT ON (thread_root_id, agent_token_hash)
  thread_root_id,
  agent_token_hash,
  agent_connection_id,
  agent_bot_name,
  joined_at
FROM (
  SELECT
    thread_root_id,
    sender_token_hash AS agent_token_hash,
    sender_connection_id AS agent_connection_id,
    sender_bot_name AS agent_bot_name,
    created_at AS joined_at
  FROM arena_messages

  UNION ALL

  SELECT
    thread_root_id,
    recipient_token_hash,
    recipient_connection_id,
    recipient_bot_name,
    created_at
  FROM arena_messages
  WHERE recipient_token_hash IS NOT NULL
) AS legacy_thread_participants
ORDER BY thread_root_id, agent_token_hash, joined_at ASC
ON CONFLICT (thread_root_id, agent_token_hash) DO NOTHING;

INSERT INTO arena_message_recipients (
  message_id,
  recipient_token_hash,
  recipient_connection_id,
  recipient_bot_name,
  delivered_at,
  read_at,
  wake_status,
  wake_attempted_at,
  wake_upstream_status
)
SELECT
  id,
  recipient_token_hash,
  recipient_connection_id,
  recipient_bot_name,
  delivered_at,
  read_at,
  wake_status,
  wake_attempted_at,
  wake_upstream_status
FROM arena_messages
WHERE recipient_token_hash IS NOT NULL
ON CONFLICT (message_id, recipient_token_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION arena_sync_legacy_message_recipient()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.recipient_token_hash IS NOT NULL THEN
    INSERT INTO arena_message_recipients (
      message_id,
      recipient_token_hash,
      recipient_connection_id,
      recipient_bot_name,
      delivered_at,
      read_at,
      wake_status,
      wake_attempted_at,
      wake_upstream_status
    )
    VALUES (
      NEW.id,
      NEW.recipient_token_hash,
      NEW.recipient_connection_id,
      NEW.recipient_bot_name,
      NEW.delivered_at,
      NEW.read_at,
      NEW.wake_status,
      NEW.wake_attempted_at,
      NEW.wake_upstream_status
    )
    ON CONFLICT (message_id, recipient_token_hash) DO UPDATE
    SET
      delivered_at = COALESCE(EXCLUDED.delivered_at, arena_message_recipients.delivered_at),
      read_at = COALESCE(EXCLUDED.read_at, arena_message_recipients.read_at),
      wake_status = CASE
        WHEN EXCLUDED.wake_attempted_at IS NOT NULL THEN EXCLUDED.wake_status
        ELSE arena_message_recipients.wake_status
      END,
      wake_attempted_at = COALESCE(
        EXCLUDED.wake_attempted_at,
        arena_message_recipients.wake_attempted_at
      ),
      wake_upstream_status = COALESCE(
        EXCLUDED.wake_upstream_status,
        arena_message_recipients.wake_upstream_status
      );
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS arena_sync_legacy_message_recipient_trigger
  ON arena_messages;

CREATE TRIGGER arena_sync_legacy_message_recipient_trigger
AFTER INSERT OR UPDATE OF
  delivered_at,
  read_at,
  wake_status,
  wake_attempted_at,
  wake_upstream_status
ON arena_messages
FOR EACH ROW
EXECUTE FUNCTION arena_sync_legacy_message_recipient();

CREATE INDEX IF NOT EXISTS arena_messages_conversation_idx
  ON arena_messages (conversation_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS arena_messages_thread_idx
  ON arena_messages (thread_root_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS arena_message_recipients_inbox_idx
  ON arena_message_recipients (
    recipient_token_hash,
    delivered_at,
    message_id
  );

CREATE INDEX IF NOT EXISTS arena_message_recipients_delivery_idx
  ON arena_message_recipients (message_id, wake_status);

COMMIT;
