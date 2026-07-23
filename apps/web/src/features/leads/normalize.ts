// Pure contact-normalization functions for Lead/Client duplicate detection
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-022 §4). No I/O, no Prisma — callers
// decide when to invoke these (schemas.ts's blank-handling happens first;
// these assume a non-blank, already-trimmed-or-trimmable string).

/** Trim + lowercase the complete value (D-022 §4's email rule). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const NON_DIGIT_PATTERN = /\D/g;

/**
 * Derives a normalized Philippine-aware phone form per D-022 §4's exact
 * algorithm:
 * (a) strip every non-digit character;
 * (b) strip a leading international `00` prefix, if present;
 * (c) preserve an already-`63`-prefixed international number as-is;
 * (d) else, a 10- or 11-digit domestic number beginning with `0` becomes
 *     `63` + the remaining digits;
 * (e) else, a 10-digit mobile number beginning with `9` (no leading 0)
 *     becomes `63` + the digits;
 * (f) otherwise — the conservative fallback — the digits-only remainder is
 *     used unchanged; no country code is invented for an unrecognized shape.
 *
 * `"0917 123 4567"`, `"+63 917 123 4567"`, `"0063 917 123 4567"`, and
 * `"9171234567"` must all normalize to `"639171234567"` — see
 * normalize.test.ts for the exhaustive equivalence assertions.
 */
export function normalizePhone(phone: string): string {
  const digitsOnly = phone.replace(NON_DIGIT_PATTERN, '');
  const withoutInternationalPrefix = digitsOnly.startsWith('00') ? digitsOnly.slice(2) : digitsOnly;

  if (withoutInternationalPrefix.startsWith('63')) {
    return withoutInternationalPrefix;
  }

  const isDomesticWithLeadingZero =
    (withoutInternationalPrefix.length === 10 || withoutInternationalPrefix.length === 11) &&
    withoutInternationalPrefix.startsWith('0');
  if (isDomesticWithLeadingZero) {
    return `63${withoutInternationalPrefix.slice(1)}`;
  }

  const isMobileWithoutLeadingZero =
    withoutInternationalPrefix.length === 10 && withoutInternationalPrefix.startsWith('9');
  if (isMobileWithoutLeadingZero) {
    return `63${withoutInternationalPrefix}`;
  }

  return withoutInternationalPrefix;
}
