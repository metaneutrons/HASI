import type { ManagedPluginCommand, ManagedPluginCommandResult, ManagedPluginReview, ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import type { PluginSettingsStore } from './plugin-settings.js';

export interface ManagedPluginConfigurationDraft { revision: number; values: Record<string, unknown>; disabledTools: string[] }

/** Implemented by the privileged worker or its private authenticated RPC client.
 * Every call re-resolves subject authority; a browser's role is never trusted.
 */
export interface ManagedPluginAdmin {
  list(subject: string): Promise<{ installations: ManagedPluginView[] }>;
  describeReview?(installationId: string, subject: string): Promise<ManagedPluginReview>;
  command(installationId: string, command: ManagedPluginCommand, subject: string): Promise<ManagedPluginCommandResult>;
  commandStatus(installationId: string, commandId: string, subject: string): Promise<ManagedPluginCommandResult>;
  describeConfiguration?(installationId: string, subject: string): ReturnType<PluginSettingsStore['describe']>;
  saveConfigurationDraft?(installationId: string, draft: ManagedPluginConfigurationDraft, subject: string): ReturnType<PluginSettingsStore['saveDraft']>;
  activateConfiguration?(installationId: string, revision: number, subject: string): ReturnType<PluginSettingsStore['activate']>;
}
