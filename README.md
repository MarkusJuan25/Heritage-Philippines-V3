# Heritage Philippines V3

Operations platform (admin dashboard + client portal) extending the Heritage Philippines V2 public site. See `CLAUDE.md` and `docs/` for project governance, blueprint, decisions log, and phased task board.

## Status

Phase 2 — Admin Dashboard Core is active. Phase 1 — Project Foundation is complete. Authentication, the PostgreSQL schema and migration history, staff account/role/assignment management, tested Booking backend capabilities, and the fail-closed deployment-pipeline skeleton are implemented. Lead, Client, Proposal / ROS, and real admin-dashboard workflows remain in progress. See `docs/HERITAGE_V3_TASK_BOARD.md` for current status.

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

The application now requires `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` (see `apps/web/.env.example`). Copy that file to `apps/web/.env.local` (gitignored) and fill in real local values there; never commit real secrets, connection strings, tokens, or domains. Staging and production will eventually hold their own values for these same variables outside source control, on their respective deployment targets — never shared with each other or with local.

The full local/staging/production isolation strategy, environment-variable naming convention, server-only vs. browser-exposed (`NEXT_PUBLIC_`) rules, secret generation/rotation/revocation/exposure handling, and the database/auth/email/storage configuration boundaries are documented in `docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md`. Read it before introducing any new environment variable or secret.
