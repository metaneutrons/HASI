import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReferencePluginQualification } from '../scripts/qualify-reference-plugin.js';

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const name of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  return environment;
}

function runGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', [...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function clearGitEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
  }
}

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const path = relative(root, fullPath).split(sep).join('/');
      const stats = await lstat(fullPath);
      const mode = stats.mode & 0o777;
      if (entry.isDirectory()) {
        snapshot.push(`directory\0${path}\0${String(mode)}`);
        await visit(fullPath);
      } else if (entry.isSymbolicLink()) {
        snapshot.push(`symlink\0${path}\0${String(mode)}\0${await readlink(fullPath)}`);
      } else if (entry.isFile()) {
        snapshot.push(`file\0${path}\0${String(mode)}\0${(await readFile(fullPath)).toString('base64')}`);
      }
    }
  }
  await visit(root);
  return snapshot;
}

describe('independent generic v2 reference plugin process', () => {
  it('isolates disposable Git operations from poisoned inherited settings', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'hasi-reference-git-isolation-'));
    const previousGitEnvironment = new Map(Object.entries(process.env)
      .filter(([name, value]) => name.startsWith('GIT_') && value !== undefined));
    const foreignRepo = join(temporaryRoot, 'foreign-repo');
    const foreignGitDirectory = join(foreignRepo, '.git');
    const foreignIndex = join(foreignGitDirectory, 'poisoned-index');
    const cleanEnvironment = cleanGitEnvironment();
    try {
      await mkdir(foreignRepo, { recursive: true });
      runGit(['init', '--quiet'], foreignRepo, cleanEnvironment);
      await writeFile(join(foreignRepo, 'keep.txt'), 'foreign repository state\n', 'utf8');
      runGit(['add', 'keep.txt'], foreignRepo, cleanEnvironment);
      runGit(['-c', 'user.name=Foreign fixture', '-c', 'user.email=foreign@example.invalid', 'commit', '--quiet', '-m', 'Foreign fixture'], foreignRepo, cleanEnvironment);
      await copyFile(join(foreignGitDirectory, 'index'), foreignIndex);
      const foreignBefore = await snapshotTree(foreignRepo);
      const poisonedGlobalConfig = join(temporaryRoot, 'poisoned-global-config');
      await writeFile(poisonedGlobalConfig, '[core]\n\tbare = true\n', 'utf8');
      const poisonedTemplateDirectory = join(temporaryRoot, 'poisoned-template');
      await mkdir(poisonedTemplateDirectory);

      clearGitEnvironment();
      process.env.GIT_DIR = foreignGitDirectory;
      process.env.GIT_WORK_TREE = foreignRepo;
      process.env.GIT_INDEX_FILE = foreignIndex;
      process.env.GIT_CONFIG_GLOBAL = poisonedGlobalConfig;
      process.env.GIT_CONFIG_NOSYSTEM = '0';
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.bare';
      process.env.GIT_CONFIG_VALUE_0 = 'true';
      process.env.GIT_TEMPLATE_DIR = poisonedTemplateDirectory;

      const evidence = await runReferencePluginQualification();

      expect(evidence.pluginId).toBe('hasi.reference');
      expect(evidence.initialVersion).toBe('1.0.0');
      expect(evidence.updatedVersion).toBe('1.0.1');
      expect(evidence.initialSourceSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(evidence.updatedSourceSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(evidence.initialManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.updatedManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.initialArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.updatedArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.initialArtifactSha256).not.toBe(evidence.updatedArtifactSha256);
      expect(evidence.initialArtifactManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.updatedArtifactManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.licenseInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.sdkRuntimePackageCount).toBeGreaterThan(1);
      expect(evidence.sdkLicenseCount).toBeGreaterThan(1);
      expect(evidence.initialPluginPid).not.toBe(evidence.updatedPluginPid);
      expect(evidence.confirmedActionCount).toBe(1);
      expect(evidence.publicLabel).toBe('Synthetic reading-room marker');
      expect(evidence.scopedAccountClaim).toBe('reference-test-account-17');
      expect(evidence.updateStatus).toBe('available');
      expect(evidence.hostRestarted).toBe(false);
      expect(evidence.rollbackSupported).toBe(true);
      expect(evidence.recoveredVersion).toBe('1.0.0');
      expect(runGit(['--no-optional-locks', 'status', '--porcelain'], foreignRepo, cleanEnvironment)).toBe('');
      expect(await snapshotTree(foreignRepo)).toEqual(foreignBefore);
    } finally {
      clearGitEnvironment();
      for (const [name, value] of previousGitEnvironment) process.env[name] = value;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    const restoredGitEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([name, value]) => name.startsWith('GIT_') && value !== undefined));
    expect(restoredGitEnvironment).toEqual(Object.fromEntries(previousGitEnvironment));
  }, 120_000);
});
