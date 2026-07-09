---
name: phase-checkpoint
description: Evaluate whether the active phase in docs/HERITAGE_V3_TASK_BOARD.md has met its completion gate and produce an evidence-backed PASS / CONDITIONAL PASS / FAIL recommendation. Use when asked to check phase readiness or before proposing to advance a phase; it never marks a phase complete — only the user can approve that.
---

# Phase Checkpoint Skill

## Purpose

Evaluate whether the active phase in `docs/HERITAGE_V3_TASK_BOARD.md` has actually met its completion gate, and produce a clear go/no-go recommendation — without advancing the phase or the task board without the user's explicit approval.

## When to Use It

When asked to check phase readiness, before proposing to move to the next phase, or at a natural phase boundary (e.g., approaching a target date in the task board).

## Required Inputs

- The active phase's scope and completion gate from `docs/HERITAGE_V3_TASK_BOARD.md`.
- The relevant blueprint section(s) that define what "correct" looks like for that phase's features.
- Available validation evidence (test results, manual verification notes, staging status) for the work claimed to be done in this phase.

## Step-by-Step Workflow

1. **Read the phase scope and completion gate** exactly as written in the task board; do not substitute your own idea of what the phase should include.
2. **Map completed work against every requirement** in that phase's task list and completion gate, item by item.
3. **Collect validation evidence** for each mapped item — what was actually run or verified, per `.claude/rules/validation-deployment.md`. Treat unverified claims as unresolved.
4. **Identify unresolved blockers, risks, deferred work, and documentation gaps** — including any open decisions from blueprint Section 16 that this phase depended on.
5. **Determine the recommendation:**
   - **PASS** — every requirement is met with evidence, no critical blockers remain.
   - **CONDITIONAL PASS** — core requirements are met, but minor, explicitly-listed gaps remain that don't block the next phase's start.
   - **FAIL** — one or more critical requirements are unmet or unverified.
6. **Do not update the task board or mark the phase complete.** Present the recommendation and supporting detail to the user; only the user decides to advance the phase.

## Validation Expectations

- Every "met" requirement must be backed by stated evidence (a command that ran, a manual check performed, a staging URL verified) — not asserted from memory.
- If evidence doesn't exist for an item, treat it as unresolved rather than assuming it's fine.

## Completion Criteria

The checkpoint itself is complete when every item in the phase's scope and completion gate has been explicitly mapped to either "met with evidence," "unresolved," or "deferred (with reason)."

## Expected Final Report Format

- **Recommendation** — PASS, CONDITIONAL PASS, or FAIL, with a one-line reason.
- **Requirement-by-requirement mapping** — each phase item with its status and evidence.
- **Unresolved blockers / risks / deferred work** — listed explicitly.
- **Documentation gaps** — anything the blueprint/task board should record but doesn't yet.
- A closing note that phase completion requires explicit user approval.
