import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export const GROK_CONNECTION_COOKIE = "arena_grok_connection";
export const CONNECTION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const WAKE_COOLDOWN_MS = 10_000;

const COOKIE_AAD = Buffer.from("arena-grok-connection-v1", "utf8");
const LOCAL_ONLY_SECRET =
  "arena-local-development-cookie-secret-do-not-use-in-production";

export const AUTH_MODES = [
  "bearer",
  "x-webhook-key",
  "x-api-key",
] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

export type GrokConnection = {
  version: 1;
  connectionId: string;
  botName: string;
  avatarUrl?: string;
  webhookUrl: string;
  webhookKey: string;
  authMode: AuthMode;
  connectedAt: string;
  lastWakeAt?: string;
};

export type ConnectionSummary = {
  botName: string;
  avatarUrl: string | null;
  host: string;
  authMode: AuthMode;
  connectedAt: string;
  lastWakeAt: string | null;
};

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export function newConnection(input: {
  botName: string;
  avatarUrl?: string;
  webhookUrl: string;
  webhookKey: string;
  authMode: AuthMode;
}): GrokConnection {
  return {
    version: 1,
    connectionId: randomUUID(),
    botName: cleanBotName(input.botName),
    avatarUrl: cleanAvatarUrl(input.avatarUrl),
    webhookUrl: validateWebhookUrl(input.webhookUrl),
    webhookKey: cleanWebhookKey(input.webhookKey),
    authMode: validateAuthMode(input.authMode),
    connectedAt: new Date().toISOString(),
  };
}

export function summarizeConnection(
  connection: GrokConnection,
): ConnectionSummary {
  return {
    botName: connection.botName,
    avatarUrl: connection.avatarUrl ?? null,
    host: new URL(connection.webhookUrl).hostname,
    authMode: connection.authMode,
    connectedAt: connection.connectedAt,
    lastWakeAt: connection.lastWakeAt ?? null,
  };
}

export function sealConnection(connection: GrokConnection): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cookieKey(), iv);
  cipher.setAAD(COOKIE_AAD);

  const plaintext = Buffer.from(JSON.stringify(connection), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function openConnection(value: string | undefined): GrokConnection | null {
  if (!value) return null;

  try {
    const [version, ivValue, tagValue, encryptedValue] = value.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
      return null;
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      cookieKey(),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(COOKIE_AAD);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<GrokConnection>;

    if (
      parsed.version !== 1 ||
      typeof parsed.connectionId !== "string" ||
      typeof parsed.botName !== "string" ||
      (parsed.avatarUrl !== undefined && typeof parsed.avatarUrl !== "string") ||
      typeof parsed.webhookUrl !== "string" ||
      typeof parsed.webhookKey !== "string" ||
      typeof parsed.connectedAt !== "string" ||
      !AUTH_MODES.includes(parsed.authMode as AuthMode)
    ) {
      return null;
    }

    const age = Date.now() - Date.parse(parsed.connectedAt);
    if (!Number.isFinite(age) || age > CONNECTION_TTL_SECONDS * 1000) {
      return null;
    }

    return parsed as GrokConnection;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAge = CONNECTION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new ConnectionError("This request must come from the Arena site.");
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ConnectionError("Invalid request origin.");
  }

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    .trim();
  const expectedHost = forwardedHost || new URL(request.url).host;

  if (originUrl.host !== expectedHost) {
    throw new ConnectionError("This request must come from the Arena site.");
  }
}

export async function assertPublicWebhookDestination(urlValue: string) {
  const url = new URL(validateWebhookUrl(urlValue));
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new ConnectionError("That webhook does not resolve to a public address.");
  }
}

export function webhookHeaders(
  mode: AuthMode,
  key: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Arena-Wake-Test/0.1",
  };

  if (mode === "bearer") headers.authorization = `Bearer ${key}`;
  if (mode === "x-webhook-key") headers["x-webhook-key"] = key;
  if (mode === "x-api-key") headers["x-api-key"] = key;

  return headers;
}

function cookieKey(): Buffer {
  const configured = process.env.ARENA_COOKIE_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("ARENA_COOKIE_SECRET is required in production.");
  }

  return createHash("sha256")
    .update(configured || LOCAL_ONLY_SECRET, "utf8")
    .digest();
}

function cleanBotName(value: string): string {
  const botName = value.trim().replace(/\s+/g, " ");
  if (botName.length < 1 || botName.length > 48) {
    throw new ConnectionError("Bot name must be between 1 and 48 characters.");
  }
  return botName;
}

function cleanAvatarUrl(value: string | undefined): string | undefined {
  const avatarUrl = value?.trim();
  if (!avatarUrl) return undefined;
  if (avatarUrl.length > 2048) {
    throw new ConnectionError("Profile image URL is too long.");
  }

  let url: URL;
  try {
    url = new URL(avatarUrl);
  } catch {
    throw new ConnectionError("Profile image URL must be valid.");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ConnectionError("Profile image URL must be a public HTTPS URL.");
  }
  return url.toString();
}

function cleanWebhookKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 1024) {
    throw new ConnectionError("Webhook key must be between 8 and 1,024 characters.");
  }
  return key;
}

function validateAuthMode(value: string): AuthMode {
  if (!AUTH_MODES.includes(value as AuthMode)) {
    throw new ConnectionError("Choose a supported key format.");
  }
  return value as AuthMode;
}

export function validateWebhookUrl(value: string): string {
  if (value.length > 2048) {
    throw new ConnectionError("Webhook URL is too long.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConnectionError("Enter a valid webhook URL.");
  }

  const host = normalizeHostname(url.hostname);
  const localDevelopmentUrl =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1");

  if (url.protocol !== "https:" && !localDevelopmentUrl) {
    throw new ConnectionError("Webhook URL must use HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    throw new ConnectionError("Webhook URL cannot include credentials or a fragment.");
  }
  if (url.port && url.port !== "443" && !localDevelopmentUrl) {
    throw new ConnectionError("Webhook URL must use the standard HTTPS port.");
  }
  if (!localDevelopmentUrl && isBlockedHostname(host)) {
    throw new ConnectionError("Webhook URL must use a public hostname.");
  }

  const allowedHosts = (process.env.GROK_WEBHOOK_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (
    allowedHosts.length > 0 &&
    !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  ) {
    throw new ConnectionError("That hostname is not an approved Grok webhook host.");
  }

  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isBlockedHostname(host: string): boolean {
  return (
    !host ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  );
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPublicIpv4(mappedIpv4) : true;
}
