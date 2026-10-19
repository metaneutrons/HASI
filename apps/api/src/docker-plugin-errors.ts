import { DeploymentDriverError } from './plugin-artifacts.js';

export class DockerPluginDriverError extends DeploymentDriverError {
  constructor(outcome: 'failed' | 'unknown') {
    super(outcome);
    this.name = 'DockerPluginDriverError';
  }
}
