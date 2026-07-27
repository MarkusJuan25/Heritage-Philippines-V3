import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// This project's vitest.config.ts intentionally does not set `globals:
// true` (it would change the ambient test namespace for every existing
// suite), so @testing-library/react's own auto-cleanup — which only
// registers itself when it detects a global `afterEach` — never fires.
// Registering it explicitly here (run for every test file, jsdom or node)
// is a no-op for the ~40 existing node-environment service/repository
// tests, which never call `render()`, and prevents DOM elements rendered
// by one component test from leaking into the next.
afterEach(() => {
  cleanup();
});
