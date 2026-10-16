import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Source uploads and package builds need no local Git hooks. CI enforces the
// same checks independently, and ordinary developer clones install the hooks.
if (process.env.CI || !existsSync(new URL('../.git', import.meta.url))) {
  console.log('Skipping local Git hook installation outside a developer checkout.');
} else {
  const result = spawnSync('lefthook', ['install'], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
