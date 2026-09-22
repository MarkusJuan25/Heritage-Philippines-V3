import { resolveV2CatalogueLink } from '@/features/regional-tours/catalogue-url';

import styles from './regional-tours.module.css';

// D-052 §4/§9 — per-request freshness (mirrors `client/support/page.tsx`'s
// identical pair). `APP_V2_PUBLIC_SITE_URL` is a server-only value that is
// not present when CI runs `pnpm build`, so this page must never be
// statically prerendered: the value is read on every request, never baked
// into a build. Inherits the `/client/:path*` `Cache-Control: private,
// no-store` and `Referrer-Policy: no-referrer` headers from
// `next.config.ts` (unchanged).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-052 §6 — the exact page copy, fixed by the accepted contract.
const HEADING = 'Regional Tours';
const AVAILABLE_COPY =
  'Browse the Heritage Philippines tour catalogue on our public website. The catalogue is separate from your client portal.';
const LINK_TEXT = 'View the tour catalogue (opens in a new tab)';
const UNAVAILABLE_COPY =
  "The tour catalogue link isn't available right now. Please contact your Heritage Philippines travel team for help.";

/**
 * D-052 Stage 3 — the single `/client/regional-tours` page: one heading,
 * one sentence, and (when a valid V2 public-site origin is configured) one
 * disclosed outbound link to V2's public `/tour` catalogue.
 *
 * A synchronous Server Component with no awaited work, rendered inside
 * `client/layout.tsx`'s single `<main>` (so it never renders its own). That
 * is why it ships no `loading.tsx` or `error.tsx` (D-052 §9): if this
 * function ever needs to be asynchronous, that decision is void.
 *
 * `process.env.APP_V2_PUBLIC_SITE_URL` is read here, inside the request-time
 * function and never at module scope, and its raw value goes straight to
 * `resolveV2CatalogueLink`, which accepts `unknown`, never throws, and never
 * coerces. The page reads no protected data and makes no database, service,
 * session, or network call (D-052 §8): `client/layout.tsx` owns
 * authentication and the only dynamic input is a public link. The outbound
 * `href` is exactly the resolver's result — no identifier, query, fragment,
 * or tracking value is appended — and in the unavailable state nothing
 * about the configured value is rendered and no `<a>` exists at all.
 */
export default function ClientRegionalToursPage() {
  const catalogue = resolveV2CatalogueLink(process.env.APP_V2_PUBLIC_SITE_URL);

  if (catalogue.status === 'available') {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>{HEADING}</h1>
        <p className={styles.description}>{AVAILABLE_COPY}</p>
        <a
          className={styles.catalogueLink}
          href={catalogue.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {LINK_TEXT}
        </a>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{HEADING}</h1>
      <p className={styles.description}>{UNAVAILABLE_COPY}</p>
    </div>
  );
}
