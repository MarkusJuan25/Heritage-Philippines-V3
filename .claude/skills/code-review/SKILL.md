---
name: code-review
description: Review a Heritage Philippines V3 diff, branch, or pull request for security, authorization/ownership, financial-calculation, correctness, privacy, validation, accessibility, and maintainability issues in priority order, with evidence-backed findings only. Use before merging a nontrivial change or whenever a code review is requested.
---

# Code Review Skill

## Purpose

Review a code change for correctness, security, and quality issues, in priority order, without inventing findings that aren't backed by evidence in the diff.

## When to Use It

Before merging a nontrivial change, or when explicitly asked to review a diff, branch, or pull request within Heritage Philippines V3.

## Required Inputs

- The diff or set of changed files to review.
- The relevant blueprint section(s) describing the intended behavior, if the change implements a business rule (roles, balances, statuses, document/visa handling).
- The applicable `.claude/rules/` file(s) for the area touched.

## Step-by-Step Workflow

Review the change against each of the following, in this priority order, stopping to flag issues as they're found:

1. **Security vulnerabilities** — injection, unsafe deserialization, insecure file handling, secret exposure, missing input validation at boundaries.
2. **Authorization and ownership failures** — missing or incorrect role/assignment checks; a client or lower-privileged role able to reach data or actions blueprint Section 4 says they shouldn't.
3. **Data corruption or financial-calculation errors** — anything touching balance calculations, payment status effects, or floating-point use for money (blueprint Section 11, `.claude/rules/database-security.md`).
4. **Broken functionality** — logic errors, incorrect status transitions, unhandled edge cases in the changed code path.
5. **Privacy exposure** — one user's/client's data reachable by another; sensitive fields over-exposed in a response.
6. **Missing validation and error handling** — unvalidated input, swallowed errors, unclear error responses.
7. **Accessibility and mobile regressions** — for UI changes: keyboard/focus issues, missing labels, broken responsive behavior.
8. **Performance and maintainability concerns** — unnecessary re-renders, unbounded queries/fetches, unjustified duplication or premature abstraction.

## Validation Expectations

- Every finding must cite the specific file/area and the concrete evidence in the diff that supports it.
- Do not report a finding you cannot point to specific evidence for; absence of evidence means no finding, not a guessed one.

## Completion Criteria

The review is complete when all eight categories above have been considered against the actual diff, and every reported finding includes severity, affected file/area, evidence, impact, and a concrete remediation.

## Expected Final Report Format

For each finding: **severity**, **affected file/area**, **evidence** (what in the diff shows this), **impact** (what goes wrong and for whom), and **remediation** (a concrete fix). If no issues are found in a category, do not manufacture one — state that the category was checked and clear.
