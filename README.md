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
