import { withRole } from '@/lib/auth/guards';
import { getServerEnv } from '@/lib/env';

import { PaymentError } from '@/features/payments/errors';
import {
  financeExportResponse,
  forbiddenResponse,
  isJsonContentType,
  isTrustedOrigin,
  trustedOriginFrom,
  unsupportedMediaTypeResponse,
} from '@/features/payments/export-http';
import { FinanceExportRequestError } from '@/features/payments/export-schemas';
import { generateFinanceExport } from '@/features/payments/export-service';
import { paymentErrorResponse, validationErrorResponse } from '@/features/payments/http';

export const runtime = 'nodejs';

/**
 * `POST /api/payments/exports` — one basic finance export file (D-061
 * Stage 3). The route receives the request, applies the endpoint's
 * cross-site policy (D-063), and shapes the outcome; every business rule,
 * the transaction, and the audit entry are `generateFinanceExport`'s
 * (D-062 clause 1).
 *
 * In order, each refusing before the next is reached, and all of them
 * before the export service is called:
 *
 * 1. `withRole`: 401 without a session, 403 for a session role that may
 *    not export.
 * 2. `Origin` must be the application's own origin exactly — otherwise the
 *    same generic 403.
 * 3. `Content-Type` must be `application/json` — otherwise 415.
 * 4. The body must be JSON — otherwise the 400 validation envelope.
 *
 * The service then validates the request itself and rechecks the actor's
 * stored role inside its transaction. Its outcomes are kept apart: a
 * `FinanceExportRequestError` is the 400 validation envelope; a
 * `PaymentError` keeps its own status (403 `ROLE_NOT_PERMITTED`, 422
 * `EXPORT_ROW_LIMIT_EXCEEDED`); anything else — an integrity refusal
 * (D-062 clause 7), a transaction timeout, a failure after commit — is
 * rethrown to `withRole`'s generic 500 and never described to the client.
 */
export const POST = withRole(['ADMIN_MANAGER', 'FINANCE_ACCOUNTING'], async (request, { user }) => {
  const trustedOrigin = trustedOriginFrom(getServerEnv().BETTER_AUTH_URL);
  if (!isTrustedOrigin(request.headers.get('origin'), trustedOrigin)) {
    return forbiddenResponse();
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return unsupportedMediaTypeResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationErrorResponse([{ path: [], message: 'Request body must be valid JSON.' }]);
  }

  try {
    return financeExportResponse(await generateFinanceExport(user, body));
  } catch (error) {
    if (error instanceof FinanceExportRequestError) {
      return validationErrorResponse(error.issues);
    }
    if (error instanceof PaymentError) {
      return paymentErrorResponse(error);
    }
    throw error;
  }
});
