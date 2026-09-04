import type { ReactNode } from 'react';

import styles from '../client.module.css';

// The shared section shell for the Client Home / Overview body: a semantic
// <section> with a single <h2>. When `count` is provided the heading
// "uses" that count (D-040 §4: the proposals section header uses
// `currentVisibleTotal`; D-040 §5: the bookings section header uses
// `sum(byStatus)`). The count is the exact integer — never re-derived,
// never a label invented around it.
export function OverviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>
        {count === undefined ? title : `${title} (${count})`}
      </h2>
      {children}
    </section>
  );
}
