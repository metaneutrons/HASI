import 'server-only';

import { validateNamespace } from '@hasi/state';

export function resolveDemoStateNamespace(environment: Readonly<Record<string, string | undefined>>): string {
  const override = environment.HASI_DEMO_STATE_NAMESPACE;
  if (override !== undefined) {
    if (!override.trim() || override !== override.trim()) {
      throw new RangeError('HASI_DEMO_STATE_NAMESPACE must not be empty or surrounded by whitespace');
    }
    validateNamespace(override);
    return override;
  }

  const deployed = Boolean(environment.VERCEL);
  const preview = environment.VERCEL_ENV === 'preview';
  const namespace = deployed
    ? preview
      ? `preview:${environment.VERCEL_GIT_COMMIT_SHA ?? environment.VERCEL_URL ?? 'isolated'}`
      : 'production:v1'
    : 'local-demo:v1';

  validateNamespace(namespace);
  return namespace;
}
