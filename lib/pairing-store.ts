import { createHash, randomBytes } from "node:crypto";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { openConnection } from "@/lib/grok-connection";

const PAIRING_TTL_MINUTES = 15;

type PairingRow = {
  status: "waiting" | "connected" | "consumed";
  encrypted_connection: string | null;
  expires_at: string;
};

type PairingStatusRow = {
  status: "waiting" | "connected" | "consumed";
  expires_at: string;
};

type ConnectedPairingRow = {
  token_hash: string;
  encrypted_connection: string;
  last_seen_at: string | null;
};

let sqlClient: NeonQueryFunction<false, false> | null = null;

export type NewPairing = {
  pairingToken: string;
  claimSecret: string;
  expiresAt: string;
};

export type PairingClaim =
  | { status: "waiting" }
  | { status: "connected"; encryptedConnection: string }
  | { status: "expired" | "missing" };

export type StoredConnection = {
  pairingId: string;
  encryptedConnection: string;
  lastSeenAt: string | null;
};

export type PairingTokenStatus =
  | "waiting"
  | "connected"
  | "expired"
  | "missing";

export async function createPairing(): Promise<NewPairing> {
  const pairingToken = randomBytes(32).toString("base64url");
  const claimSecret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + PAIRING_TTL_MINUTES * 60_000,
  ).toISOString();
  const sql = getSql();

  await sql`
    INSERT INTO arena_pairings (
      token_hash,
      claim_hash,
      status,
      expires_at
    ) VALUES (
      ${hashSecret(pairingToken)},
      ${hashSecret(claimSecret)},
      'waiting',
      ${expiresAt}
    )
  `;

  return { pairingToken, claimSecret, expiresAt };
}

export async function getPairingTokenStatus(
  pairingToken: string,
): Promise<PairingTokenStatus> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(pairingToken)) return "missing";

  const sql = getSql();
  const rows = (await sql`
    SELECT status, expires_at
    FROM arena_pairings
    WHERE token_hash = ${hashSecret(pairingToken)}
    LIMIT 1
  `) as PairingStatusRow[];
  const row = rows[0];

  if (!row) return "missing";
  if (row.status === "connected") return "connected";
  if (row.status === "consumed" || Date.parse(row.expires_at) <= Date.now()) {
    return "expired";
  }
  return "waiting";
}

export async function completePairing(
  pairingToken: string,
  encryptedConnection: string,
): Promise<boolean> {
  const sql = getSql();
  const pairingId = hashSecret(pairingToken);
  const rows = await sql`
    UPDATE arena_pairings
    SET
      status = 'connected',
      encrypted_connection = ${encryptedConnection},
      connected_at = now(),
      last_seen_at = now()
    WHERE token_hash = ${pairingId}
      AND status = 'waiting'
      AND expires_at > now()
    RETURNING token_hash
  `;

  if (rows.length !== 1) return false;

  const newConnection = openConnection(encryptedConnection);
  if (newConnection) {
    const existingRows = (await sql`
      SELECT token_hash, encrypted_connection, last_seen_at
      FROM arena_pairings
      WHERE token_hash <> ${pairingId}
        AND status = 'connected'
        AND encrypted_connection IS NOT NULL
    `) as ConnectedPairingRow[];

    for (const existingRow of existingRows) {
      const existingConnection = openConnection(
        existingRow.encrypted_connection,
        existingRow.last_seen_at,
      );
      if (existingConnection?.webhookUrl !== newConnection.webhookUrl) continue;

      await sql`
        UPDATE arena_pairings
        SET status = 'consumed', consumed_at = COALESCE(consumed_at, now())
        WHERE token_hash = ${existingRow.token_hash}
          AND status = 'connected'
      `;
    }
  }

  return true;
}

export async function claimPairing(claimSecret: string): Promise<PairingClaim> {
  const sql = getSql();
  const rows = (await sql`
    SELECT status, encrypted_connection, expires_at
    FROM arena_pairings
    WHERE claim_hash = ${hashSecret(claimSecret)}
    LIMIT 1
  `) as PairingRow[];
  const row = rows[0];

  if (!row) return { status: "missing" };
  if (Date.parse(row.expires_at) <= Date.now()) return { status: "expired" };
  if (row.status === "consumed") return { status: "expired" };
  if (row.status !== "connected" || !row.encrypted_connection) {
    return { status: "waiting" };
  }

  await sql`
    UPDATE arena_pairings
    SET consumed_at = COALESCE(consumed_at, now())
    WHERE claim_hash = ${hashSecret(claimSecret)}
  `;

  return {
    status: "connected",
    encryptedConnection: row.encrypted_connection,
  };
}

export async function listConnectedPairings(): Promise<StoredConnection[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT token_hash, encrypted_connection, last_seen_at
    FROM arena_pairings
    WHERE status = 'connected'
      AND encrypted_connection IS NOT NULL
    ORDER BY connected_at ASC
    LIMIT 20
  `) as ConnectedPairingRow[];

  return rows.map((row) => ({
    pairingId: row.token_hash,
    encryptedConnection: row.encrypted_connection,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function updateConnectedPairing(
  pairingId: string,
  encryptedConnection: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE arena_pairings
    SET encrypted_connection = ${encryptedConnection}
    WHERE token_hash = ${pairingId}
      AND status = 'connected'
  `;
}

function getSql(): NeonQueryFunction<false, false> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Grok pairing.");
  }

  if (!sqlClient) sqlClient = neon(databaseUrl);
  return sqlClient;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
