/**
 * Until loadAuthStore names a file, the store is memory-only and writes nothing.
 * Jest gives each test file its own module registry, so importing the store
 * here — and never loading it — is exactly that state.
 */
import { jest, describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { clientStore, refreshTokenStore } from '../../../src/auth/store';

describe('auth store before loadAuthStore', () => {
  it('serves clients and refresh tokens from memory without writing any file', () => {
    const write = jest.spyOn(fs, 'writeFileSync');
    const rename = jest.spyOn(fs, 'renameSync');

    clientStore.save({
      client_id: 'client-unloaded',
      client_secret: 'secret-for-client-unloaded',
      client_id_issued_at: 1_788_000_000,
      client_secret_expires_at: 1_790_592_000,
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Claude',
      scope: 'claudeai',
    });
    refreshTokenStore.save('rt-unloaded', {
      clientId: 'client-unloaded',
      email: 'person@example.com',
      scopes: ['claudeai'],
    });

    expect(clientStore.get('client-unloaded')?.client_id).toBe('client-unloaded');
    expect(refreshTokenStore.take('rt-unloaded')?.clientId).toBe('client-unloaded');
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
});
