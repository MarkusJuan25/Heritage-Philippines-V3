# Validation and Deployment Rules

## Current State

No application tooling (package manager, test runner, linter, build system) exists in this repository yet. Do not invent or claim specific commands (e.g., `npm test`, `npm run build`) until the technology stack is chosen and those scripts actually exist. Once established, this file should be updated with the real commands.

## Validation Appropriate to Changed Files

- Run only the validation relevant to what changed (e.g., don't run a full test suite for a docs-only change; do run type-checking and relevant tests for a service-layer change).
- When formatting, linting, type-checking, tests, production builds, or security-scanning tools exist, run them before declaring a task complete.
- Never state that a check "passed" unless the corresponding command was actually executed and actually succeeded in this session. If a tool doesn't exist yet, say so explicitly instead of assuming a result.

## Manual Verification

- For any user-facing change, once the app exists, exercise the actual feature in a running instance (or explicitly state that this wasn't possible and why) rather than relying on types/tests alone.

## Diff and Scope Review

- Review the full diff of changed files before reporting completion.
- Flag and remove any unintended or unrelated changes before finishing.

## Environment Variables

- Document every new environment variable's purpose, and whether it's required in local, staging, and production, in the appropriate environment documentation as it's introduced — never hardcode environment-specific values.

## Migration Review

- Review every database migration against current production data shape before it is applied to staging or production; confirm it does not silently break an existing feature.

## Rollback and Backup

- Confirm a rollback path (previous deployable version, reversible migration, or restore point) exists before a production deployment.
- Confirm backups exist and are recent before any destructive or migration-involving production change.

## Staging Before Production

- Every feature is verified in staging before it reaches production; staging should mirror production configuration closely enough that a staging pass is meaningful.

## Post-Deployment Smoke Testing

- After a production deployment, verify the core paths relevant to the release (e.g., login, the specific feature shipped, and any adjacent flow it could affect) before considering the deployment complete.

## Phase Completion Criteria and Evidence

- A phase is not complete until its blueprint/task-board completion gate is met with actual evidence (test results, manual verification notes, staging confirmation) — not asserted from memory. Use the `phase-checkpoint` skill to evaluate this.

## Delivery Targets

- **September 30, 2026** — internal MVP / beta on staging, usable by staff and selected clients.
- **October 31, 2026** — production-ready launch.

Validation rigor should scale up as these dates approach: earlier phases can rely more on manual verification; Phase 6 (Security and Production Hardening) and Phase 7 (UAT and Launch) require full validation evidence before sign-off.
