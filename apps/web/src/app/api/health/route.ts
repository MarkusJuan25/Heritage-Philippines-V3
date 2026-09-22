import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

// D-053 Stage 2 (A7): the service name is shared between the healthy and
// unreachable-database responses below so the two can never drift apart.
const SERVICE_NAME = 'heritage-philippines-v3-web';

/**
 * D-053 Stage 2 (A7) — extends the previously liveness-only check with a
 * minimal database-connectivity probe, so a future real deployment's own
 * health verification (D-053 §11 Stage 6) exercises this database-aware
 * version rather than the old liveness-only one. `SELECT 1` is the
 * smallest possible round trip through the existing `prisma` singleton
 * (`@/lib/db`) — it proves the connection pool can reach PostgreSQL
 * without reading or depending on any application table.
 *
 * On failure, the caught error is never inspected or forwarded in any
 * way: no message, stack, cause, or error-object property is read, so a
 * connection string, hostname, or other database-internal detail
 * embedded in a driver error can never reach the response body (D-053
 * Stage 2's explicit "no sensitive diagnostic data" requirement). The
 * unreachable-database response is deliberately the same fixed shape as
 * the healthy one, but with a `status` value that can never equal
 * `"ok"`, and a `503` (Service Unavailable) HTTP status — the standard,
 * distinct signal that this process is up but its declared dependency is
 * not, for whatever calls this endpoint (a future real deployment's own
 * verification step, or a monitoring probe) to tell apart from `200`.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return Response.json(
      { status: 'error', service: SERVICE_NAME, timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }

  return Response.json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
}
