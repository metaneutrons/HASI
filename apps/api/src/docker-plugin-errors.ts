import { DeploymentDriverError } from './plugin-artifacts.js';

export class DockerPluginDriverError extends DeploymentDriverError {
  constructor(outcome: 'failed' | 'unknown', public readonly reason: 'image_provenance_mismatch' | null = null) {
    super(outcome);
    this.name = 'DockerPluginDriverError';
  }
}
