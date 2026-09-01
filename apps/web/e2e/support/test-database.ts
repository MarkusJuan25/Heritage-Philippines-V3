import { createServer } from 'node:http';

import type { Prisma } from '@/generated/prisma/client';

// D-033 §5: the single canonical E2E database-safety implementation, used
// identically by run-e2e.ts, playwright.config.ts, fixtures.ts, and the
// spec's own direct-assertion code. Mirrors every existing
// `*.service.integration.test.ts` file's own `validateTestDatabaseUrl`
// allowlist logic exactly. Never imports the production `lib/db.ts`
// singleton or `getServerEnv()` — this module reads and validates
// `TEST_DATABASE_URL` only.

const ALLOWED_PROTOCOLS = new Set(['postgresql:', 'postgres:']);
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const REQUIRED_DATABASE_NAME = 'heritage_v3_test';

export function getValidatedTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error('TEST_DATABASE_URL is required to run the E2E suite. Refusing to proceed.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL. Refusing to run the E2E suite.');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL must use the postgresql:// or postgres:// protocol (got "${parsed.protocol}"). Refusing to proceed.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    throw new Error(
      `TEST_DATABASE_URL hostname must be localhost, 127.0.0.1, or ::1 (got "${hostname}"). Refusing to run against a non-local host.`,
    );
  }

  // Reject any `host` query parameter (case-insensitive; `URLSearchParams`
  // already decodes percent-encoded keys and exposes every repeated
  // occurrence) — confirmed directly against the installed
  // `pg-connection-string@2.14.0` source (`index.js` lines 40-56): every
  // query parameter is copied onto its internal `config` object, and
  // `config.host` is derived from the URL's actual hostname only `if
  // (!config.host)`, i.e. only when no `host=` query parameter was already
  // present. Without this check, a value such as
  // `postgresql://e2e:secret@localhost/heritage_v3_test?host=remote.example`
  // would pass every check above yet silently direct the pg driver to
  // `remote.example` instead of the validated hostname (Stage 2 Correction
  // Pass 4).
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === 'host') {
      throw new Error(
        'TEST_DATABASE_URL must not include a "host" query parameter. Refusing to proceed.',
      );
    }
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL must target the "${REQUIRED_DATABASE_NAME}" database (got "${databaseName || '(empty)'}"). Refusing to run against any other database, including heritage_v3_dev.`,
    );
  }

  if (!parsed.username) {
    throw new Error('TEST_DATABASE_URL must include a non-empty username. Refusing to proceed.');
  }

  return raw;
}

/**
 * A safe, non-secret confirmation string for validation-contract evidence
 * (D-033 §12) — a fixed literal, never the URL, hostname, username,
 * password, or any other connection detail.
 */
export function describeValidatedDatabaseSafely(): string {
  getValidatedTestDatabaseUrl();
  return 'Validated local heritage_v3_test database.';
}

// --- Real-Prisma RPC bridge -------------------------------------------
//
// Directly loading the generated Prisma client (`@/generated/prisma/client`)
// from Playwright-run code fails reproducibly: Playwright 1.62.1's own
// installed loader (`playwright/lib/common/index.js`'s
// `requireOrImport`/`fileIsModule`, confirmed directly against the
// installed source) routes every `.ts` file in a package with no
// `"type": "module"` field — which includes every file in this Stage 2
// boundary — through plain CJS `require()`, and that exact code path fails
// with `Cannot require() ES Module ... in a cycle` once it actually reaches
// the generated client, whose own module graph does contain an internal
// circular reference (`internal/class.ts`/`internal/prismaNamespace.ts`).
//
// This is not established as a universal rule, however: an isolated
// `tsx/cjs`-hooked `require()` of the identical generated-client file, run
// outside Playwright's own process, succeeds with no error. So the
// circular reference has not been proven the complete, sufficient cause on
// its own, and the exact mechanism distinguishing Playwright's own failing
// pipeline from that succeeding isolated case has not been isolated (e.g.
// at the level of Playwright's specific babel/CJS transform or its module
// cache state) — this remains open. What is directly, repeatedly confirmed
// is narrower: no file inside the Stage 2 boundary can load the generated
// Prisma client for runtime use through Playwright's own actual loading
// process. `tsx` (a genuine ESM-capable runtime, already used to run
// `run-e2e.ts` itself) loads the identical file with zero issue in that
// separate context — directly verified across multiple runs. D-033
// §5a/§5b (Stage 2 Correction Pass 1/2) is this architecture's explicit
// contract authorization, adopted as the practical workaround for
// Playwright's confirmed failure within the fixed `.ts` file-extension
// boundary — not as a claim that the underlying mechanism is fully
// understood.
//
// The fix: `run-e2e.ts` (running under `tsx`) starts a small localhost-only
// HTTP bridge holding one real `PrismaClient`; `fixtures.ts` and the spec
// (running inside Playwright's process) talk to it over plain `fetch()`
// via `createE2EPrismaRpcClient()` below, whose returned Proxy mimics the
// identical `client.<model>.<method>(args)` calling convention the real
// client already uses for the exact, allowlisted set of operations this
// suite needs, so calling code is unaffected. No `$transaction` callback
// bridging is required: every E2E write relies on Prisma's own
// nested-write atomicity (mirroring `prisma/seed.ts`'s identical
// established pattern) rather than an explicit `$transaction()` call.

const E2E_PRISMA_RPC_PORT = 3101;
const E2E_PRISMA_RPC_HOST = '127.0.0.1';
const E2E_PRISMA_RPC_URL = `http://${E2E_PRISMA_RPC_HOST}:${E2E_PRISMA_RPC_PORT}`;
const E2E_PRISMA_RPC_PATH = '/call';
const E2E_PRISMA_RPC_MAX_BODY_BYTES = 1_048_576; // 1 MiB — generous for this suite's small JSON payloads.

type RpcRequestBody = { model: string; method: string; args: unknown };
type RpcResponseBody = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * D-033 §5b: the exact Prisma model/method pairs the canonical journey and
 * its fixture/cleanup code use — the bridge must never dispatch to an
 * arbitrary model/method pair supplied in a request body.
 */
const RPC_ALLOWED_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  user: new Set(['create', 'deleteMany']),
  lead: new Set(['findUniqueOrThrow', 'deleteMany']),
  client: new Set(['findUniqueOrThrow', 'deleteMany']),
  proposal: new Set(['findUniqueOrThrow', 'deleteMany']),
  proposalVersion: new Set(['deleteMany']),
  proposalAcceptance: new Set(['findUniqueOrThrow', 'deleteMany']),
  booking: new Set(['findUniqueOrThrow', 'deleteMany']),
  staffAssignment: new Set(['findFirst', 'deleteMany']),
  leadStatusHistory: new Set(['findMany', 'deleteMany']),
  bookingStatusHistory: new Set(['findMany', 'deleteMany']),
  auditLog: new Set(['findMany', 'deleteMany']),
  // D-034 Stage 5e (D-037 Section 15): the exact, minimal surface the
  // activation E2E spec needs — final-state verification and cleanup
  // only, never anything the browser flow itself could instead perform.
  // `PortalInvitation.clientId` and `ClientProfile.clientId` are both
  // `@unique` (schema.prisma), so `findUniqueOrThrow({ where: { clientId
  // } })` is the same convention every other unique-by-parent lookup in
  // this allowlist already uses. No `user` or `account` operation is
  // added here: the activated User's id is recovered from
  // `clientProfile.findUniqueOrThrow`'s own nested `user` select instead
  // of a separate lookup, and `Account` cascade-deletes automatically
  // when its owning `User` row is deleted (`onDelete: Cascade`, already
  // fixtures.ts's own established assumption).
  portalInvitation: new Set(['findUniqueOrThrow', 'deleteMany']),
  clientProfile: new Set(['findUniqueOrThrow', 'deleteMany']),
  // Real activation requests unavoidably write RateLimitBucket rows
  // (every gated POST/GET increments the shared SOURCE `"unknown-source"`
  // bucket before any other work, per D-037 Section 10) — `deleteMany`
  // only, by exact bucketKey/windowStart, never a read/update/upsert,
  // since the spec never needs to inspect a count, only to remove the
  // exact disposable rows its own real HTTP requests created.
  rateLimitBucket: new Set(['deleteMany']),
};

/** A transported RPC method: real Prisma input-argument typing, but an
 * honestly `unknown` transported result — JSON transport does not preserve
 * genuine Prisma return-value semantics (e.g. a `Date` becomes a string),
 * so no real Prisma delegate return type may be asserted for it. Every
 * caller must runtime-validate/narrow the result before any field access
 * (Stage 2 Correction Pass 2). */
type RpcMethod<Args> = (args: Args) => Promise<unknown>;

/**
 * The exact, honestly-scoped surface Playwright-side code may call over
 * the RPC bridge (D-033 §5a) — never a `PrismaClient` type assertion. This
 * is a transport proxy, not a database connection: `$disconnect` is a
 * documented no-op (the real connection lives in, and is closed
 * exclusively by, `run-e2e.ts`), kept only so calling code can use one
 * uniform `finally { await prisma.$disconnect() }` pattern.
 */
export type E2EPrismaRpcClient = {
  user: {
    create: RpcMethod<Prisma.UserCreateArgs>;
    deleteMany: RpcMethod<Prisma.UserDeleteManyArgs>;
  };
  lead: {
    findUniqueOrThrow: RpcMethod<Prisma.LeadFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.LeadDeleteManyArgs>;
  };
  client: {
    findUniqueOrThrow: RpcMethod<Prisma.ClientFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.ClientDeleteManyArgs>;
  };
  proposal: {
    findUniqueOrThrow: RpcMethod<Prisma.ProposalFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.ProposalDeleteManyArgs>;
  };
  proposalVersion: {
    deleteMany: RpcMethod<Prisma.ProposalVersionDeleteManyArgs>;
  };
  proposalAcceptance: {
    findUniqueOrThrow: RpcMethod<Prisma.ProposalAcceptanceFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.ProposalAcceptanceDeleteManyArgs>;
  };
  booking: {
    findUniqueOrThrow: RpcMethod<Prisma.BookingFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.BookingDeleteManyArgs>;
  };
  staffAssignment: {
    findFirst: RpcMethod<Prisma.StaffAssignmentFindFirstArgs>;
    deleteMany: RpcMethod<Prisma.StaffAssignmentDeleteManyArgs>;
  };
  leadStatusHistory: {
    findMany: RpcMethod<Prisma.LeadStatusHistoryFindManyArgs>;
    deleteMany: RpcMethod<Prisma.LeadStatusHistoryDeleteManyArgs>;
  };
  bookingStatusHistory: {
    findMany: RpcMethod<Prisma.BookingStatusHistoryFindManyArgs>;
    deleteMany: RpcMethod<Prisma.BookingStatusHistoryDeleteManyArgs>;
  };
  auditLog: {
    findMany: RpcMethod<Prisma.AuditLogFindManyArgs>;
    deleteMany: RpcMethod<Prisma.AuditLogDeleteManyArgs>;
  };
  portalInvitation: {
    findUniqueOrThrow: RpcMethod<Prisma.PortalInvitationFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.PortalInvitationDeleteManyArgs>;
  };
  clientProfile: {
    findUniqueOrThrow: RpcMethod<Prisma.ClientProfileFindUniqueOrThrowArgs>;
    deleteMany: RpcMethod<Prisma.ClientProfileDeleteManyArgs>;
  };
  rateLimitBucket: {
    deleteMany: RpcMethod<Prisma.RateLimitBucketDeleteManyArgs>;
  };
  $disconnect: () => Promise<void>;
};

/**
 * Starts the real-Prisma RPC bridge. Must only ever be called from
 * `run-e2e.ts` (a genuine `tsx`/ESM-capable process) — never from
 * Playwright-loaded code. Deliberately opaque to TypeScript/esbuild's
 * static analysis (a `new Function` boundary hides the `import()` text so
 * it is never downlevel-compiled to `require()`), even though this
 * specific call site does not strictly need it under `tsx` — kept
 * identical to how the generated client must be referenced, for a single
 * consistent pattern.
 */
export async function startE2EPrismaRpcServer(): Promise<{ close: () => Promise<void> }> {
  const url = getValidatedTestDatabaseUrl();
  const nativeDynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string,
  ) => Promise<unknown>;
  const adapterModule = (await nativeDynamicImport(
    '@prisma/adapter-pg',
  )) as typeof import('@prisma/adapter-pg');
  const clientModule = (await nativeDynamicImport(
    '@/generated/prisma/client',
  )) as typeof import('@/generated/prisma/client');
  const adapter = new adapterModule.PrismaPg({ connectionString: url });
  const prisma = new clientModule.PrismaClient({ adapter });

  const prismaRecord = prisma as unknown as Record<
    string,
    Record<string, (args: unknown) => Promise<unknown>>
  >;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== E2E_PRISMA_RPC_PATH) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > E2E_PRISMA_RPC_MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      void (async () => {
        let responseBody: RpcResponseBody;
        // Only ever replaced with `${model}.${method}` once both are
        // confirmed runtime strings AND the exact pair is present in
        // RPC_ALLOWED_OPERATIONS below — for every malformed, unknown, or
        // disallowed request, this stays the fixed literal. Request-
        // controlled text is never interpolated into a log, error, or
        // response (Stage 2 Correction Pass 3).
        let loggedOperation = '(rejected request)';
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequestBody;
          const { model, method, args } = parsed;

          if (
            typeof model !== 'string' ||
            typeof method !== 'string' ||
            !RPC_ALLOWED_OPERATIONS[model]?.has(method)
          ) {
            throw new Error('Prisma model/method not allowlisted for E2E RPC.');
          }
          loggedOperation = `${model}.${method}`;

          const modelClient = prismaRecord[model];
          const fn = modelClient?.[method];
          if (typeof fn !== 'function') {
            throw new Error('Prisma model/method not available.');
          }
          const result = await fn.call(modelClient, args);
          responseBody = { ok: true, result };
        } catch (error) {
          // Only safe, non-sensitive information is ever logged or
          // returned — never the raw Error object, message, stack, cause,
          // Prisma/PostgreSQL text, connection string, credential, path,
          // hostname, or any request-controlled value, including in this
          // local console output (D-033 §5b). The wire response's `error`
          // is a completely fixed literal, independent of the caught
          // error's class — only the local log varies, and only by a safe
          // built-in class name derived from the actual caught Error
          // (Stage 2 Correction Pass 3).
          const className = error instanceof Error ? error.constructor.name : typeof error;
          console.error(`[e2e-rpc] request failed: ${loggedOperation} (${className}).`);
          responseBody = { ok: false, error: 'E2E RPC call failed.' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      })();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(E2E_PRISMA_RPC_PORT, E2E_PRISMA_RPC_HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (startupError) {
    // Startup failed after the real PrismaClient was already constructed —
    // disconnect it before propagating, so a failed bridge never leaks an
    // open database connection. The original startup failure still
    // propagates to the caller (run-e2e.ts), whose existing top-level
    // handler (D-033 §6) reports it through the same sanitized mechanism —
    // it is never logged raw here.
    await prisma.$disconnect().catch(() => {});
    throw startupError;
  }

  let closed = false;
  return {
    // Idempotent: a second call is a no-op. Both the HTTP server and the
    // Prisma client always receive their own cleanup attempt regardless of
    // whether the other one fails — neither can block or skip the other —
    // and port 3101 is released whenever `server.close()` itself succeeds,
    // independent of the Prisma disconnect outcome (Stage 2 Correction
    // Pass 2). A failure is reported only as a generic, sanitized
    // rejection — never a raw underlying error.
    close: async () => {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([
        prisma.$disconnect(),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('E2E RPC bridge shutdown failed to cleanly release one or more resources.');
      }
    },
  };
}

/**
 * Sanitized RPC transport. No thrown error here may expose the request
 * URL, host, port, path, raw response body, raw parser error, or
 * underlying cause — only a fixed, stable message. A well-formed `{ ok:
 * false, error: string }` envelope's shape is validated, but its `error`
 * string's *content* is never trusted or surfaced: a wrong or locally
 * spoofed service on the loopback port could return arbitrary text, so
 * every failure path throws only a fixed, local message (Stage 2
 * Correction Pass 3).
 */
async function rpcCall(model: string, method: string, args: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${E2E_PRISMA_RPC_URL}${E2E_PRISMA_RPC_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, method, args } satisfies RpcRequestBody),
    });
  } catch {
    throw new Error('E2E RPC transport failed: could not reach the E2E RPC bridge.');
  }

  if (!response.ok) {
    // Fully fixed literal — no response-controlled value (e.g. the status
    // code) is ever interpolated (Stage 2 Correction Pass 4).
    throw new Error('E2E RPC transport failed: the bridge returned a non-success HTTP response.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('E2E RPC transport failed: the bridge returned a malformed response.');
  }

  if (!body || typeof body !== 'object') {
    throw new Error('E2E RPC transport failed: the bridge returned an invalid response envelope.');
  }
  const envelope = body as Partial<RpcResponseBody>;
  if (envelope.ok === true) {
    return envelope.result;
  }
  if (envelope.ok === false && typeof envelope.error === 'string') {
    // Envelope shape validated; the `error` string's content is
    // deliberately discarded and never copied into a thrown Error (Stage
    // 2 Correction Pass 3).
    throw new Error('E2E RPC operation failed.');
  }
  throw new Error('E2E RPC transport failed: the bridge returned an invalid response envelope.');
}

/**
 * An `E2EPrismaRpcClient`-shaped Proxy (D-033 §5a) that forwards every
 * allowlisted `client.<model>.<method>(args)` call to the real-Prisma RPC
 * bridge `run-e2e.ts` starts — never the production `lib/db.ts` singleton,
 * never `getServerEnv()`, and never a direct in-process import of the
 * generated client (which cannot be loaded from Playwright-run code at
 * all, see above). `$disconnect()` is a no-op here — the bridge's own real
 * `PrismaClient` is disconnected once, by `run-e2e.ts`, when the bridge
 * itself is torn down. Every method's transported result is `Promise<unknown>`
 * — callers must runtime-validate/narrow it before any field access.
 */
export function createE2EPrismaRpcClient(): E2EPrismaRpcClient {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '$disconnect') {
          return async () => {};
        }
        if (typeof prop !== 'string') {
          return undefined;
        }
        const model = prop;
        return new Proxy(
          {},
          {
            get(_modelTarget, methodProp) {
              if (typeof methodProp !== 'string') {
                return undefined;
              }
              const method = methodProp;
              return (args: unknown) => rpcCall(model, method, args);
            },
          },
        );
      },
    },
  ) as unknown as E2EPrismaRpcClient;
}
