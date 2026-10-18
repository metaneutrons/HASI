import { describe, expect, it } from 'vitest';
import { runReferencePluginQualification } from '../scripts/qualify-reference-plugin.js';

describe('independent generic v2 reference plugin process', () => {
  it('installs, configures, invokes, confirms and updates without restarting the host', async () => {
    const evidence = await runReferencePluginQualification();

    expect(evidence.pluginId).toBe('hasi.reference');
    expect(evidence.initialVersion).toBe('1.0.0');
    expect(evidence.updatedVersion).toBe('1.0.1');
    expect(evidence.initialSourceSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(evidence.updatedSourceSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(evidence.sdkBuildSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.initialPluginPid).not.toBe(evidence.updatedPluginPid);
    expect(evidence.confirmedActionCount).toBe(1);
    expect(evidence.publicLabel).toBe('Synthetic reading-room marker');
    expect(evidence.scopedAccountClaim).toBe('reference-test-account-17');
    expect(evidence.updateStatus).toBe('available');
    expect(evidence.hostRestarted).toBe(false);
    expect(evidence.rollbackSupported).toBe(false);
  }, 120_000);
});
