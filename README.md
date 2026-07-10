# Heritage Philippines V3

Operations platform (admin dashboard + client portal) extending the Heritage Philippines V2 public site. See `CLAUDE.md` and `docs/` for project governance, blueprint, decisions log, and phased task board.

## Status

Phase 1 — Project Foundation. This is the initial workspace/tooling scaffold only; no business features, authentication, or database are implemented yet.

## Prerequisites

- Node.js 24.x (active LTS) — see `package.json` `engines`.
- pnpm 11.10.0, managed via Corepack: `corepack enable && corepack prepare pnpm@11.10.0 --activate`.

## Getting Started

```bash
pnpm install
pnpm dev          # run the web app in development
pnpm build        # production build
pnpm lint         # ESLint
pnpm typecheck    # TypeScript, no emit
pnpm format       # Prettier, write
pnpm format:check # Prettier, check only
```

The web application lives in `apps/web` (Next.js, TypeScript). A liveness check is available at `/api/health` once the app is running.

## Environment Configuration

No environment variables are required yet — `apps/web/.env.example` is a template only and is intentionally empty of variables at this stage. When you do need local values, copy it to `apps/web/.env.local` (gitignored) and fill them in there; never commit real secrets, connection strings, tokens, or domains.

The full local/staging/production isolation strategy, environment-variable naming convention, server-only vs. browser-exposed (`NEXT_PUBLIC_`) rules, secret generation/rotation/revocation/exposure handling, and the database/auth/email/storage configuration boundaries are documented in `docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md`. Read it before introducing any new environment variable or secret.
