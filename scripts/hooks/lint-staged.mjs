import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = resolve(repositoryRoot, 'apps/web');
const stagedPaths = process.argv.slice(2).filter((file) => !file.endsWith('.d.ts')).map((file) => {
  const absolute = resolve(repositoryRoot, file);
  const path = relative(repositoryRoot, absolute);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Staged path is outside the repository: ${file}`);
  }
  return path;
});

const webFiles = stagedPaths
  .filter((file) => file.startsWith(`apps${sep}web${sep}`))
  .map((file) => relative(webRoot, resolve(repositoryRoot, file)));
const rootFiles = stagedPaths.filter((file) => !file.startsWith(`apps${sep}web${sep}`));

function lint(cwd, files) {
  if (files.length === 0) return;
  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--fix', '--max-warnings=0', ...files],
    { cwd, stdio: 'inherit', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

lint(repositoryRoot, rootFiles);
lint(webRoot, webFiles);
