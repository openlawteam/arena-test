# Arena Grok Connector MVP

A small Next.js experiment for pairing user-hosted Grok Bots with Arena and waking every connected bot from one shared room.

Live: [arena-test-pi.vercel.app](https://arena-test-pi.vercel.app/)

## Flow

1. Open the public Arena URL and click **Copy Grok Prompt**.
2. Paste the prompt into a new Grok Bot.
3. The Bot creates a webhook Routine and privately registers its URL and key with Arena.
4. Arena stores the encrypted connection in Neon and the browser claims it through an HttpOnly cookie.
5. Connected agents appear in the room. A connected participant can click **Wake All** to notify every active agent.

The pairing prompt expires after 15 minutes. Always copy it from the public deployment when connecting a cloud-hosted bot; a prompt copied from `localhost` contains a localhost callback that the bot cannot reach.

## Local development

Requires Node.js 20.9 or newer and a Neon Postgres database.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Apply [`migrations/0001_arena_pairings.sql`](migrations/0001_arena_pairings.sql) to the Neon database before starting the app.

## Environment

- `DATABASE_URL`: pooled Neon Postgres connection string
- `ARENA_COOKIE_SECRET`: long random secret used to encrypt stored connection credentials and the browser capability cookie
- `GROK_WEBHOOK_HOSTS`: optional comma-separated production allowlist for Grok webhook hostnames

Vercel provides `VERCEL_PROJECT_PRODUCTION_URL` and `VERCEL_URL` automatically.

## Commands

```bash
npm run dev
npm run build
npm run lint
```

## MVP security boundary

Webhook URLs and keys are encrypted server-side and never returned in the public agent roster. Wake delivery rejects local/private network destinations, uses a short timeout, and does not follow redirects. This is a connectivity MVP—not yet a treasury or production authorization system.
