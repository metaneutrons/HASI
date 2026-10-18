import { z } from 'zod';

const historyEntrySchema = z.strictObject({
  operation: z.enum(['consent', 'renewal', 'authorization_failed', 'disconnect', 'revocation_confirmed', 'external_revocation', 'expired', 'authority_changed']),
  at: z.iso.datetime({ offset: true }),
  authorityRevision: z.number().int().nonnegative(),
});

const accountSchema = z.strictObject({
  installationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  label: z.string().trim().min(1).max(200),
  status: z.enum(['unlinked', 'linked', 'expired', 'revoked', 'disconnected', 'unavailable']),
  authorityRevision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  flow: z.enum(['idle', 'consent_pending', 'renewal_pending']),
  adapterTrust: z.enum(['trusted', 'demo-only', 'missing']),
  revocationStatus: z.enum(['none', 'pending', 'confirmed']),
  remedies: z.array(z.enum(['connect', 'renew', 'retry_status', 'retry_revocation', 'configure_adapter'])).max(5),
  history: z.array(historyEntrySchema).max(100),
  disconnectImpact: z.strictObject({
    pendingConfirmations: z.literal('invalidated'),
    inFlightExecutions: z.literal('may_complete'),
    completedExternalChanges: z.literal('not_undone'),
    conversationHistory: z.literal('retained'),
  }),
});

export type PluginAccountPanelAccount = z.infer<typeof accountSchema>;

const listSchema = z.strictObject({ accounts: z.array(accountSchema).max(64) });
const beginSchema = z.strictObject({ authorizationUrl: z.string().max(2_048), challengeExpiresAt: z.iso.datetime({ offset: true }) });
const revokeSchema = z.strictObject({
  authorityRevision: z.number().int().nonnegative(),
  status: z.literal('disconnected'),
  revocationStatus: z.enum(['pending', 'confirmed']),
});

export function parsePluginAccountList(value: unknown): PluginAccountPanelAccount[] {
  const parsed = listSchema.parse(value);
  const ids = parsed.accounts.map((account) => account.installationId);
  if (new Set(ids).size !== ids.length) throw new TypeError('Invalid personal account list');
  return parsed.accounts;
}

export function parsePluginAccountBegin(value: unknown): z.infer<typeof beginSchema> {
  const result = beginSchema.parse(value);
  if (result.authorizationUrl.startsWith('/') && !result.authorizationUrl.startsWith('//')) {
    let local: URL;
    try { local = new URL(result.authorizationUrl, 'https://hasi.invalid'); } catch { throw new TypeError('Invalid account authorization URL'); }
    if (local.pathname !== '/account/connections/consent' || local.hash) throw new TypeError('Invalid account authorization URL');
    return result;
  }
  let url: URL;
  try { url = new URL(result.authorizationUrl); } catch { throw new TypeError('Invalid account authorization URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('Invalid account authorization URL');
  return result;
}

export function parsePluginAccountRevoke(value: unknown): z.infer<typeof revokeSchema> {
  return revokeSchema.parse(value);
}

export function getPluginAccountHistoryLabel(operation: PluginAccountPanelAccount['history'][number]['operation']): string {
  switch (operation) {
    case 'consent': return 'Konto verbunden';
    case 'renewal': return 'Zugriff erneuert';
    case 'authorization_failed': return 'Anmeldung nicht abgeschlossen';
    case 'disconnect': return 'Verbindung getrennt';
    case 'revocation_confirmed': return 'Widerruf beim Anmeldedienst bestätigt';
    case 'external_revocation': return 'Zugriff extern widerrufen';
    case 'expired': return 'Zugriff abgelaufen';
    case 'authority_changed': return 'Berechtigung aktualisiert';
  }
}
