import { describe, expect, it } from 'vitest';
import { ReferencePackagingCommandError } from '../scripts/package-reference-plugin.js';

describe('reference packaging subprocess diagnostics', () => {
  it('reports a specific offline metadata failure without exposing subprocess output', () => {
    const error = new ReferencePackagingCommandError('offline-deploy', {
      status: 1,
      stdout: Buffer.from('ERR_PNPM_META_FETCH_FAIL: ERR_PNPM_NO_OFFLINE_META at /private/registry'),
      stderr: 'Authorization: Bearer synthetic-secret-marker',
    });
    expect(error.message).toBe('Reference artifact command failed during offline-deploy (category: ERR_PNPM_NO_OFFLINE_META; exit: 1).');
    expect(String(error)).not.toMatch(/registry|Authorization|synthetic-secret-marker/);
    expect(error.cause).toBeUndefined();
  });

  it.each(['ERR_PNPM_NO_OFFLINE_TARBALL', 'ERR_PNPM_TARBALL_INTEGRITY'])(
    'preserves the safe diagnostic category %s', category => {
      const error = new ReferencePackagingCommandError('offline-deploy', { status: 1, stderr: category });
      expect(error.message).toContain(`category: ${category}; exit: 1`);
    },
  );

  it('does not pass through unknown codes, arbitrary messages or invalid exit statuses', () => {
    const error = new ReferencePackagingCommandError('dependency-preparation', {
      code: 'PRIVATE_CODE', status: 'secret-status',
      stderr: 'ERR_PNPM_PRIVATE_URL https://private.example/token', message: 'secret-message',
    });
    expect(error.message).toBe('Reference artifact command failed during dependency-preparation (category: unclassified; exit: unknown).');
    expect(Object.keys(error)).not.toContain('stderr');
  });

  it.each([
    ['ETIMEDOUT', 'timeout'], ['ENOENT', 'command_unavailable'],
  ])('reports operational failure %s without raw details', (code, category) => {
    const error = new ReferencePackagingCommandError('sdk-build', { code, status: null, message: '/private/command' });
    expect(error.message).toContain(`category: ${category}; exit: unknown`);
    expect(error.message).not.toContain('/private');
  });

  it.each([undefined, null, 'private failure', { status: -1 }, { status: 256 }, { status: 1.5 }])(
    'handles malformed subprocess failures safely', failure => {
      expect(new ReferencePackagingCommandError('offline-deploy', failure).message)
        .toBe('Reference artifact command failed during offline-deploy (category: unclassified; exit: unknown).');
    },
  );
});
