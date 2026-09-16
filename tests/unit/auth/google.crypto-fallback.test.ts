/**
 * jose reads the bare `crypto` global. Node 20+ always defines it, but on an
 * older runtime Google ID token verification threw "ReferenceError: crypto is
 * not defined" — so google.ts installs node:crypto's webcrypto when the global
 * is missing. Jest gives each test file its own module registry, so the global
 * can be removed here before google.ts is first evaluated.
 */
import { describe, it, expect } from '@jest/globals';
import { webcrypto } from 'node:crypto';

describe('google.ts on a runtime without a global crypto', () => {
  it('installs node:crypto webcrypto for jose to use', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    delete (globalThis as { crypto?: Crypto }).crypto;
    try {
      expect(globalThis.crypto).toBeUndefined();

      await import('../../../src/auth/google');

      expect(globalThis.crypto).toBe(webcrypto);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
