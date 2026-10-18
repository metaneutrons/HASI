import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const failures = vi.hoisted(() => ({ close: vi.fn(() => Promise.resolve()) }));
vi.mock("@hasi/state", async importOriginal => {
  const original = await importOriginal<typeof import("@hasi/state")>();
  return { ...original, PostgresJsonStore: class {
    initialize() { return Promise.resolve(); }
    read() { return Promise.resolve(undefined); }
    close = failures.close;
  } };
});

afterEach(() => { vi.unstubAllEnvs(); });

it("closes failed budget pools and never bootstraps absent deployed state on a retry", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture.invalid/test");
  const { getModelBudgetAdmission } = await import("../src/lib/server/model-budgets");
  await expect(getModelBudgetAdmission()).rejects.toMatchObject({ code: "budget_unavailable" });
  await expect(getModelBudgetAdmission()).rejects.toMatchObject({ code: "budget_unavailable" });
  expect(failures.close).toHaveBeenCalledTimes(2);
});

it('requires existing durable state for live operator probes even outside production', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/test');
  const before = failures.close.mock.calls.length;
  const { getDurableModelBudgetAdmission } = await import('../src/lib/server/model-budgets');
  await expect(getDurableModelBudgetAdmission()).rejects.toMatchObject({ code: 'budget_unavailable' });
  expect(failures.close).toHaveBeenCalledTimes(before + 1);
  vi.stubEnv('DATABASE_URL', '');
  await expect(getDurableModelBudgetAdmission()).rejects.toMatchObject({ code: 'budget_unavailable' });
  expect(failures.close).toHaveBeenCalledTimes(before + 1);
});
