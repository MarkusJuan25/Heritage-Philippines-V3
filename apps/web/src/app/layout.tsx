import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Heritage Philippines V3',
  description: 'Heritage Philippines V3 application foundation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
