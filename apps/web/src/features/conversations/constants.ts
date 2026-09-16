// A dependency-free, client-safe module: a single plain numeric constant,
// with no import of Zod, Prisma, or any other runtime dependency. Exists
// specifically so a `'use client'` component (e.g.
// `app/admin/conversations/_components/ConversationReplyForm.tsx`) can
// read this value directly, without transitively importing `schemas.ts`'s
// own runtime value-import of `@/generated/prisma/client` — which pulls in
// the Prisma Client's Node-only runtime (and, through it, `node:module`),
// something Turbopack correctly refuses to bundle into a browser chunk
// (D-051 Stage 3's CI build failure on `ConversationReplyForm.tsx`).
//
// D-051 §16 leaves this exact maximum unfixed by the contract itself; 5000
// is Stage 2's own implementation-time decision (see `schemas.ts`'s own
// doc comment for the full reasoning). This module is its single source
// of truth — `schemas.ts` re-exports it rather than redefining it, so the
// value is never duplicated.
export const MESSAGE_BODY_MAX_LENGTH = 5000;
