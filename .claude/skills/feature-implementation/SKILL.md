---
name: feature-implementation
description: Implement a single scoped Heritage Philippines V3 feature end to end as the smallest complete vertical slice, with blueprint and active-phase scope checks, explicit acceptance criteria, and validation appropriate to the files changed. Use when asked to build, add, or wire up a specific feature inside an active, approved phase.
---

# Feature Implementation Skill

## Purpose

Implement a single, scoped feature end-to-end as the smallest complete vertical slice, consistent with the active phase and the project blueprint.

## When to Use It

When asked to build, add, or wire up a specific feature or capability inside Heritage Philippines V3 (admin dashboard, client portal, or backend) once application scaffolding exists and the work falls inside an active, approved phase.

## Required Inputs

- The specific feature or task requested.
- The relevant section(s) of `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md`.
- The active phase and its scope in `docs/HERITAGE_V3_TASK_BOARD.md`.
- The relevant file(s) under `.claude/rules/` for the area being touched (e.g., `backend.md` + `admin-dashboard.md` for an admin API endpoint).

## Step-by-Step Workflow

1. **Read context first.** Read the relevant blueprint section(s), the active task-board phase entry, and the applicable `.claude/rules/` files. Confirm the task is in scope for the active phase.
2. **Define acceptance criteria.** Write down, in concrete and testable terms, what "done" means for this specific feature (e.g., "a Travel Consultant can create a proposal draft; a client cannot edit it; version 2 supersedes version 1 in the client view").
3. **Inspect existing code before editing.** Find and read the code this feature will touch or extend; identify existing patterns, shared contracts, and any related logic already in place. Do not duplicate what exists.
4. **Implement the smallest complete vertical slice.** Build only what's needed to satisfy the acceptance criteria end-to-end (e.g., validation → service logic → data access → API response → UI), not a partial layer or a broader abstraction than required.
5. **Handle all applicable states.** Where relevant: authorization (role/assignment/ownership checks), input validation, loading, empty, error, and success states.
6. **Run only relevant validation.** Execute the formatting, linting, type-checking, and test commands applicable to the files changed, per `.claude/rules/validation-deployment.md`. If no such tooling exists yet, state that explicitly.
7. **Review the final diff.** Check for unrelated changes, leftover debug code, or scope creep before reporting.

## Validation Expectations

- Only report a check as passing if the corresponding command was actually run and actually succeeded.
- If manual verification (e.g., exercising the feature in a running app) is possible, perform it; if not, say so explicitly.

## Completion Criteria

- Acceptance criteria from Step 2 are all met.
- Relevant validation (Step 6) has been run, or its absence has been explicitly stated.
- The diff contains only changes relevant to this feature.

## Expected Final Report Format

- **Completed work** — what was implemented, in plain terms.
- **Validation evidence** — commands run and their results, or an explicit note that no tooling exists yet.
- **Remaining risks** — anything not covered, deferred, or uncertain.
- **Recommended next step** — what should logically follow.
