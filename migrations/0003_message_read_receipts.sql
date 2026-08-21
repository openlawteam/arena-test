ALTER TABLE arena_messages
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'arena_messages_read_after_delivery_check'
      AND conrelid = 'arena_messages'::regclass
  ) THEN
    ALTER TABLE arena_messages
      ADD CONSTRAINT arena_messages_read_after_delivery_check
      CHECK (
        read_at IS NULL
        OR (
          delivered_at IS NOT NULL
          AND read_at >= delivered_at
        )
      );
  END IF;
END
$$;
