import { describe, expect, it } from 'vitest';
import { ASSISTANT_BUDGET_NAMESPACE } from '@hasi/state';
import {
  assertBudgetRecoveryBoundaryPassed,
  assertOwnedBudgetLedgerRemoval,
  budgetRecoverySafeAt,
  BUDGET_RECOVERY_CLOCK_MARGIN_MS,
  parseQualificationMode,
  validateQualificationEnvironment,
} from '../scripts/qualify-model-budget-topology.js';

const safeEnvironment = { HASI_BUDGET_QUALIFY: '1' };
const ownedRemoval = {
  mode: 'state-loss-drill' as const,
  namespace: ASSISTANT_BUDGET_NAMESPACE,
  ledgerKey: 'model-budget:v1:' + 'a'.repeat(64),
  containerName: 'hasi-m2-budget-proof-pg-123e4567-e89b-12d3-a456-426614174000',
  expectedOwnerLabel: '123e4567-e89b-12d3-a456-426614174001',
  actualOwnerLabel: '123e4567-e89b-12d3-a456-426614174001',
};

describe('model budget topology qualifier state-loss mode', () => {
  it('keeps the topology run as default and accepts only the explicit optional drill flag', () => {
    expect(parseQualificationMode([])).toBe('topology');
    expect(parseQualificationMode(['--state-loss-drill'])).toBe('state-loss-drill');
    expect(() => { parseQualificationMode(['--state-loss-drill', '--unexpected']); }).toThrow('--state-loss-drill');
    expect(() => { parseQualificationMode(['--unexpected']); }).toThrow('--state-loss-drill');
  });

  it('requires the usual explicit opt-in and rejects inherited databases before fixture setup', () => {
    expect(() => { validateQualificationEnvironment('unknown', safeEnvironment); })
      .toThrow('qualification_mode_invalid');
    expect(() => { validateQualificationEnvironment('state-loss-drill', {}); }).toThrow('explicit_opt_in_required');
    expect(() => { validateQualificationEnvironment('state-loss-drill', {
      ...safeEnvironment,
      TEST_DATABASE_URL: 'postgresql://caller-owned.example/test',
    }); }).toThrow('inherited_database_url_forbidden');
    expect(() => { validateQualificationEnvironment('state-loss-drill', {
      ...safeEnvironment,
      DATABASE_URL: 'postgresql://production.example/demo',
    }); }).toThrow('inherited_database_url_forbidden');
    expect(() => { validateQualificationEnvironment('state-loss-drill', safeEnvironment); }).not.toThrow();
  });

  it('requires the next UTC window plus a one-minute clock margin before recovery initialization', () => {
    const latestPossibleDispatch = Date.parse('2026-10-21T23:59:59.000Z');
    const nextWindowEnd = Date.parse('2026-10-22T00:00:00.000Z');
    const safeAt = nextWindowEnd + BUDGET_RECOVERY_CLOCK_MARGIN_MS;

    expect(budgetRecoverySafeAt(latestPossibleDispatch)).toBe(safeAt);
    expect(() => { assertBudgetRecoveryBoundaryPassed(safeAt - 1, latestPossibleDispatch); })
      .toThrow('budget_recovery_window_not_safe');
    expect(assertBudgetRecoveryBoundaryPassed(safeAt, latestPossibleDispatch)).toBe(safeAt);
    expect(() => { budgetRecoverySafeAt(-1); }).toThrow('budget_recovery_boundary_invalid');
  });

  it('permits deleting only the shared budget row in the currently owned fixture container', () => {
    expect(() => { assertOwnedBudgetLedgerRemoval(ownedRemoval); }).not.toThrow();
    expect(() => { assertOwnedBudgetLedgerRemoval({ ...ownedRemoval, mode: 'topology' }); })
      .toThrow('state_loss_drill_not_enabled');
    expect(() => { assertOwnedBudgetLedgerRemoval({ ...ownedRemoval, namespace: 'production:identity' }); })
      .toThrow('budget_loss_namespace_not_owned');
    expect(() => { assertOwnedBudgetLedgerRemoval({ ...ownedRemoval, ledgerKey: 'session:some-user' }); })
      .toThrow('budget_loss_ledger_key_invalid');
    expect(() => { assertOwnedBudgetLedgerRemoval({ ...ownedRemoval, containerName: 'hasi-production-postgres' }); })
      .toThrow('budget_loss_container_name_invalid');
    expect(() => { assertOwnedBudgetLedgerRemoval({ ...ownedRemoval, actualOwnerLabel: undefined }); })
      .toThrow('budget_loss_container_ownership_unverified');
  });
});
