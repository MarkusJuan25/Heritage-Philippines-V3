---
name: goal
description: Plan and, only when explicitly requested and in scope, execute a stated Heritage Philippines V3 goal under phase-gate, blueprint, and validation discipline. Invoked by the user as /goal [goal description]; not for automatic invocation.
argument-hint: "[goal description]"
disable-model-invocation: true
---

# Goal Skill

Requested goal: $ARGUMENTS

## Purpose

Take a stated goal, place it inside the project's phase-gated workflow, and either plan it or deliver it with the same discipline as `feature-implementation` — never silently expanding scope, skipping validation, or advancing project state.

If `$ARGUMENTS` is empty, ask the user to state the goal; do not guess one.

## Step-by-Step Workflow

1. **Read the active phase.** Read `docs/HERITAGE_V3_TASK_BOARD.md` and identify the currently active phase, its scope, and its completion gate exactly as written.
2. **Read the governing context.** Read the blueprint section(s) of `docs/HERITAGE_V3_PROJECT_BLUEPRINT.md` relevant to the goal, plus the applicable `.claude/rules/` file(s) for the areas the goal touches.
3. **Determine scope fit.** Decide whether the goal falls inside the active phase's scope.
   - If it is **inside** the active phase, proceed.
   - If it is **outside** the active phase (or depends on an open decision in blueprint Section 16), stop after analysis: report the scope conflict and what phase or decision the goal actually belongs to. Do not implement without the user explicitly approving a scoped exception.
4. **Define acceptance criteria.** Write concrete, testable criteria for what "done" means for this goal — specific behaviors, boundaries, and edge cases, not vague outcomes.
5. **Identify affected files and risks.** List the files/areas the goal would touch and the likely risks (security, privacy, authorization, financial accuracy, data loss, V2 compatibility, scope creep).
6. **Implement only when explicitly requested and in scope.** If the user asked only for analysis or planning, stop after Step 5 and report. Implement only when the user's request explicitly includes implementation and Step 3 confirmed the goal is in scope; build the smallest complete vertical slice that satisfies the acceptance criteria.
7. **Run only validation that actually exists.** Execute the formatting, linting, type-checking, test, or build commands that genuinely exist for the files changed, per `.claude/rules/validation-deployment.md`. Never invent or claim a command; if no tooling exists yet (the current state of this repository), state that explicitly.
8. **Review the final diff.** Check every changed file for unrelated changes, leftover debris, or scope creep before reporting.

## Hard Boundaries

- Never run `git commit`, `git push`, `git reset`, `git rebase`, or any other history-altering command as part of this workflow; those require the user to explicitly ask for that specific action (see CLAUDE.md Section 13).
- Never mark a phase complete or advance the task board; only the user can approve that (use `phase-checkpoint` to evaluate readiness).
- Never weaken role, ownership, financial, or privacy rules to make a goal easier to reach; flag the conflict instead.

## Expected Final Report Format

- **Completed work** — what was analyzed or implemented, in plain terms (or the scope conflict found in Step 3).
- **Validation evidence** — commands actually run and their results, or an explicit statement that no tooling exists yet.
- **Remaining risks** — anything not covered, deferred, or uncertain.
- **Next logical step** — what should follow, noting anything that needs explicit user approval.
