'use client';

import { createAuthClient } from 'better-auth/react';

// No `baseURL` is configured: the client, admin, and API layers are all
// served from the same Next.js origin (ADR-001's modular monolith), so
// Better Auth's default same-origin relative path ("/api/auth") is correct
// and needs no browser-exposed environment variable.
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
