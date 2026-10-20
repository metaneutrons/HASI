import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_JSON_BYTES = 64 * 1_024;
const MAX_MANAGED_SOURCE_BYTES = 60 * 1_024;
const MAX_KEY_BYTES = 256;
const BUSY_TIMEOUT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class ReferenceStateError extends Error {}

function stateError(message) {
  return new ReferenceStateError(message);
}

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function quoteJson(value) {
  return JSON.stringify(value);
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw stateError('Invalid reference state value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw stateError('Invalid reference state value');
    ancestors.add(value);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw stateError('Invalid reference state value');
      items.push(canonicalJson(value[index], ancestors));
    }
    ancestors.delete(value);
    return `[${items.join(',')}]`;
  }
  if (!isRecord(value) || ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw stateError('Invalid reference state value');
  }
  ancestors.add(value);
  const fields = Object.keys(value).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw stateError('Invalid reference state value');
    return `${quoteJson(key)}:${canonicalJson(descriptor.value, ancestors)}`;
  });
  ancestors.delete(value);
  return `{${fields.join(',')}}`;
}

function checkedJson(value) {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw stateError('Reference state value is too large');
  return json;
}

function checkedKey(key) {
  if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw stateError('Invalid reference state key');
  }
  return key;
}

function safeDatabaseError(callback, message) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ReferenceStateError) throw error;
    throw stateError(message);
  }
}

function ensurePrivateDatabaseFile(filename) {
  if (filename === ':memory:') return;
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.length > 4_096 || filename.includes('\0')) {
    throw stateError('Reference state path must be absolute');
  }

  try {
    const current = lstatSync(filename);
    if (current.isSymbolicLink() || !current.isFile()) throw stateError('Reference state file is invalid');
    chmodSync(filename, 0o600);
  } catch (error) {
    if (error instanceof ReferenceStateError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      try {
        const descriptor = openSync(
          filename,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          // Apply the requested mode even when the process has a restrictive umask.
          chmodSync(filename, 0o600);
        } finally {
          closeSync(descriptor);
        }
      } catch (createError) {
        if (!(createError && typeof createError === 'object' && 'code' in createError && createError.code === 'EEXIST')) {
          throw stateError('Reference state file could not be created');
        }
        const raced = lstatSync(filename);
        if (raced.isSymbolicLink() || !raced.isFile()) throw stateError('Reference state file is invalid');
        chmodSync(filename, 0o600);
      }
    } else {
      throw stateError('Reference state file could not be prepared');
    }
  }

  const verified = lstatSync(filename);
  if (verified.isSymbolicLink() || !verified.isFile()) throw stateError('Reference state file is invalid');
  chmodSync(filename, 0o600);
}

function validateBinding(value) {
  if (!isRecord(value)) throw stateError('Invalid execution binding');
  const fields = ['subject', 'installationId', 'executionId', 'tool', 'argsHash', 'configurationRevision'];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) {
    throw stateError('Invalid execution binding');
  }
  const { subject, installationId, executionId, tool, argsHash, configurationRevision } = value;
  if (
    typeof subject !== 'string' || subject.length === 0 || Buffer.byteLength(subject, 'utf8') > MAX_KEY_BYTES ||
    typeof installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(installationId) ||
    typeof executionId !== 'string' || !UUID_PATTERN.test(executionId) ||
    typeof tool !== 'string' || tool.length === 0 || Buffer.byteLength(tool, 'utf8') > MAX_KEY_BYTES ||
    typeof argsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(argsHash) ||
    !Number.isSafeInteger(configurationRevision) || configurationRevision < 0
  ) {
    throw stateError('Invalid execution binding');
  }
  return { subject, installationId, executionId, tool, argsHash, configurationRevision };
}

function accountFor(actor) {
  if (!isRecord(actor) || typeof actor.subject !== 'string' || actor.subject.length === 0 || Buffer.byteLength(actor.subject, 'utf8') > MAX_KEY_BYTES) {
    throw stateError('Invalid reference actor');
  }
  const value = isRecord(actor.claims) ? actor.claims['reference.account'] : undefined;
  if (value === undefined || typeof value !== 'string') return 'unscoped';
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) throw stateError('Invalid reference actor');
  return value;
}

function sourceIdentity(binding) {
  return createHash('sha256').update(canonicalJson([
    binding.subject,
    binding.installationId,
    binding.executionId,
  ]), 'utf8').digest('hex');
}

function invocationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw stateError('Invalid invocation identity');
  return value;
}

function transaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the static operation error. */ }
    throw error;
  }
}

function ownDataKeys(value) {
  if (!isRecord(value)) throw stateError('Invalid managed reference state');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw stateError('Invalid managed reference state');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw stateError('Invalid managed reference state');
    }
  }
  return keys;
}

function exactFields(value, fields) {
  const keys = ownDataKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
    throw stateError('Invalid managed reference state');
  }
}

function validateReferenceAccount(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) {
    throw stateError('Invalid managed reference state');
  }
  return value;
}

function validateManagedBinding(value) {
  exactFields(value, ['subject', 'installationId', 'executionId', 'tool', 'argsHash', 'configurationRevision']);
  return validateBinding(value);
}

function managedStateJson(value) {
  let json;
  try {
    json = canonicalJson(value);
  } catch {
    throw stateError('Invalid managed reference state');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_MANAGED_SOURCE_BYTES) {
    throw stateError('Managed reference state is too large');
  }
  return json;
}

function validateManagedScope(scope) {
  if (!isRecord(scope) || typeof scope.installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(scope.installationId)
    || typeof scope.subject !== 'string' || scope.subject.length === 0 || Buffer.byteLength(scope.subject, 'utf8') > MAX_KEY_BYTES) {
    throw stateError('Invalid reference execution');
  }
  return {
    installationId: scope.installationId,
    subject: scope.subject,
    account: validateReferenceAccount(scope.account),
  };
}

function validateManagedBlob(value, expectedScope) {
  managedStateJson(value);
  exactFields(value, ['version', 'actionCount', 'receipts']);
  if (value.version !== 1 || !Number.isSafeInteger(value.actionCount) || value.actionCount < 0) {
    throw stateError('Invalid managed reference state');
  }

  ownDataKeys(value.receipts);
  const receiptKeys = Object.keys(value.receipts);
  if (receiptKeys.length !== value.actionCount) throw stateError('Invalid managed reference state');

  const observedCounts = new Set();
  for (const identity of receiptKeys) {
    if (!/^[a-f0-9]{64}$/u.test(identity)) throw stateError('Invalid managed reference state');
    const receipt = value.receipts[identity];
    exactFields(receipt, ['binding', 'account', 'result']);

    const binding = validateManagedBinding(receipt.binding);
    const account = validateReferenceAccount(receipt.account);
    if (binding.tool !== 'execute_mark' || sourceIdentity(binding) !== identity
      || expectedScope && (binding.installationId !== expectedScope.installationId || binding.subject !== expectedScope.subject || account !== expectedScope.account)) {
      throw stateError('Invalid managed reference state');
    }

    const result = receipt.result;
    exactFields(result, ['confirmed', 'actionCount', 'label', 'account']);
    if (result.confirmed !== true || !Number.isSafeInteger(result.actionCount) || result.actionCount < 1 || result.actionCount > value.actionCount
      || typeof result.label !== 'string' || result.label.length < 1 || result.label.length > 80
      || result.account !== account || observedCounts.has(result.actionCount)) {
      throw stateError('Invalid managed reference state');
    }
    observedCounts.add(result.actionCount);
  }

  for (let actionCount = 1; actionCount <= value.actionCount; actionCount += 1) {
    if (!observedCounts.has(actionCount)) throw stateError('Invalid managed reference state');
  }

  return value;
}

function checkedManagedEntry(entry) {
  if (entry === undefined) return undefined;
  exactFields(entry, ['revision', 'value']);
  if (typeof entry.revision !== 'string' || !UUID_PATTERN.test(entry.revision)) {
    throw stateError('Invalid managed reference state revision');
  }
  return entry;
}

/**
 * Managed source state backed by the host's application store. The host
 * partitions this store by installation, subject and account; the receipt
 * checks below also bind every saved result to that scope and execution.
 */
export function createManagedReferenceState(store) {
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSet !== 'function') {
    throw stateError('Managed reference state is unavailable');
  }

  async function read(scope) {
    const entry = checkedManagedEntry(await store.read('source'));
    const value = entry ? entry.value : { version: 1, actionCount: 0, receipts: {} };
    return {
      revision: entry?.revision ?? null,
      value: validateManagedBlob(value, scope),
    };
  }

  function scopeFor(binding, actor, account) {
    if (binding.subject !== actor.subject || binding.tool !== 'execute_mark') {
      throw stateError('Invalid reference execution');
    }
    return validateManagedScope({
      installationId: binding.installationId,
      subject: binding.subject,
      account,
    });
  }

  return Object.freeze({
    async mark(bindingValue, args, actor) {
      const binding = validateManagedBinding(bindingValue);
      const account = accountFor(actor);
      const scope = scopeFor(binding, actor, account);
      if (!isRecord(args)) throw stateError('Invalid reference execution');
      const argsJson = checkedJson(args);
      const argsDigest = createHash('sha256').update(argsJson, 'utf8').digest('hex');
      if (argsDigest !== binding.argsHash || typeof args.label !== 'string' || args.label.length < 1 || args.label.length > 80) {
        throw stateError('Invalid reference execution');
      }

      const bindingJson = checkedJson(binding);
      const identity = sourceIdentity(binding);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await read(scope);
        const prior = current.value.receipts[identity];
        if (prior) {
          if (checkedJson(prior.binding) !== bindingJson || prior.account !== account) {
            throw stateError('Reference source binding changed');
          }
          return prior.result;
        }

        const actionCount = current.value.actionCount + 1;
        if (!Number.isSafeInteger(actionCount)) throw stateError('Reference counter is full');
        const result = { confirmed: true, actionCount, label: args.label, account };
        const next = {
          version: 1,
          actionCount,
          receipts: {
            ...current.value.receipts,
            [identity]: { binding, account, result },
          },
        };
        validateManagedBlob(next, scope);
        if (await store.compareAndSet('source', current.revision, next)) return result;
      }
      throw stateError('Managed reference state changed concurrently');
    },
    async resolve(bindingValue, actor) {
      const binding = validateManagedBinding(bindingValue);
      const account = accountFor(actor);
      const scope = scopeFor(binding, actor, account);
      const current = await read(scope);
      const prior = current.value.receipts[sourceIdentity(binding)];
      if (!prior) return undefined;
      if (checkedJson(prior.binding) !== checkedJson(binding) || prior.account !== account) {
        throw stateError('Reference source binding changed');
      }
      return prior.result;
    },
    async count(installationId, actor) {
      if (typeof installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(installationId)) {
        throw stateError('Invalid reference installation');
      }
      const account = accountFor(actor);
      const scope = validateManagedScope({ installationId, subject: actor.subject, account });
      const current = await read(scope);
      return current.value.actionCount;
    },
  });
}

/** Independent durable state for the synthetic reference plugin. */
export function createReferenceState(filename = ':memory:') {
  let database;
  try {
    ensurePrivateDatabaseFile(filename);
    database = new DatabaseSync(filename, { timeout: BUSY_TIMEOUT_MS });
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};
    `);
    const journalMode = database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (filename !== ':memory:' && journalMode !== 'wal') throw stateError('Reference state durability is unavailable');
    database.exec(`
      CREATE TABLE IF NOT EXISTS execution_journal (
        key TEXT PRIMARY KEY CHECK(length(key) <= ${String(MAX_KEY_BYTES)}),
        revision TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= ${String(MAX_JSON_BYTES)})
      ) STRICT;
      CREATE TABLE IF NOT EXISTS used_invocations (
        jti TEXT PRIMARY KEY CHECK(length(jti) = 36),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS action_counters (
        installation_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        account TEXT NOT NULL,
        action_count INTEGER NOT NULL CHECK(action_count >= 0),
        PRIMARY KEY (installation_id, subject, account)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_receipts (
        source_key TEXT PRIMARY KEY CHECK(length(source_key) = 64),
        binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB)) <= ${String(MAX_JSON_BYTES)}),
        account TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= ${String(MAX_JSON_BYTES)})
      ) STRICT;
    `);
  } catch (error) {
    try { database?.close(); } catch { /* Preserve a path-free initialization error. */ }
    if (error instanceof ReferenceStateError) throw error;
    throw new Error('Reference state could not be opened');
  }

  let closed = false;
  const db = database;
  const executionStore = Object.freeze({
    async read(key) {
      return safeDatabaseError(() => {
        assertOpen();
        const row = db.prepare('SELECT revision, value_json FROM execution_journal WHERE key = ?').get(checkedKey(key));
        return row ? { revision: row.revision, value: JSON.parse(row.value_json) } : undefined;
      }, 'Reference journal read failed');
    },
    async compareAndSet(key, revision, value) {
      return safeDatabaseError(() => {
        assertOpen();
        const safeKey = checkedKey(key);
        const valueJson = checkedJson(value);
        if (revision !== null && (typeof revision !== 'string' || revision.length > MAX_KEY_BYTES)) {
          throw stateError('Invalid reference journal revision');
        }
        const nextRevision = randomUUID();
        if (revision === null) {
          const inserted = db.prepare(`
            INSERT INTO execution_journal (key, revision, value_json) VALUES (?, ?, ?)
            ON CONFLICT(key) DO NOTHING
          `).run(safeKey, nextRevision, valueJson);
          return Number(inserted.changes) === 1;
        }
        const changed = db.prepare(`
          UPDATE execution_journal SET revision = ?, value_json = ? WHERE key = ? AND revision = ?
        `).run(nextRevision, valueJson, safeKey, revision);
        return Number(changed.changes) === 1;
      }, 'Reference journal write failed');
    },
  });

  return Object.freeze({
    executionStore,
    async consumeInvocation(jti, expiresAt) {
      return safeDatabaseError(() => {
        assertOpen();
        const safeJti = invocationId(jti);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw stateError('Invalid invocation expiry');
        const now = Math.floor(Date.now() / 1_000);
        return transaction(db, () => {
          db.prepare('DELETE FROM used_invocations WHERE expires_at <= ?').run(now);
          if (expiresAt <= now) return false;
          const inserted = db.prepare(`
            INSERT INTO used_invocations (jti, expires_at) VALUES (?, ?)
            ON CONFLICT(jti) DO NOTHING
          `).run(safeJti, expiresAt);
          return Number(inserted.changes) === 1;
        });
      }, 'Reference invocation guard failed');
    },
    async mark(bindingValue, args, actor) {
      return safeDatabaseError(() => {
        assertOpen();
        const binding = validateBinding(bindingValue);
        const actorAccount = accountFor(actor);
        if (binding.subject !== actor.subject || binding.tool !== 'execute_mark' || !isRecord(args)) {
          throw stateError('Invalid reference execution');
        }
        const argsJson = checkedJson(args);
        const argsDigest = createHash('sha256').update(argsJson, 'utf8').digest('hex');
        if (argsDigest !== binding.argsHash || typeof args.label !== 'string' || args.label.length < 1 || args.label.length > 80) {
          throw stateError('Invalid reference execution');
        }
        const bindingJson = checkedJson(binding);
        const sourceKey = sourceIdentity(binding);
        return transaction(db, () => {
          const prior = db.prepare('SELECT binding_json, account, result_json FROM source_receipts WHERE source_key = ?').get(sourceKey);
          if (prior) {
            if (prior.binding_json !== bindingJson || prior.account !== actorAccount) throw stateError('Reference source binding changed');
            return JSON.parse(prior.result_json);
          }

          const current = db.prepare(`
            SELECT action_count FROM action_counters WHERE installation_id = ? AND subject = ? AND account = ?
          `).get(binding.installationId, binding.subject, actorAccount);
          const actionCount = Number(current?.action_count ?? 0) + 1;
          if (!Number.isSafeInteger(actionCount)) throw stateError('Reference counter is full');
          db.prepare(`
            INSERT INTO action_counters (installation_id, subject, account, action_count) VALUES (?, ?, ?, ?)
            ON CONFLICT(installation_id, subject, account) DO UPDATE SET action_count = excluded.action_count
          `).run(binding.installationId, binding.subject, actorAccount, actionCount);

          const result = { confirmed: true, actionCount, label: args.label, account: actorAccount };
          db.prepare(`
            INSERT INTO source_receipts (source_key, binding_json, account, result_json) VALUES (?, ?, ?, ?)
          `).run(sourceKey, bindingJson, actorAccount, checkedJson(result));
          return result;
        });
      }, 'Reference source write failed');
    },
    async resolve(bindingValue, actor) {
      return safeDatabaseError(() => {
        assertOpen();
        const binding = validateBinding(bindingValue);
        const actorAccount = accountFor(actor);
        if (binding.subject !== actor.subject || binding.tool !== 'execute_mark') throw stateError('Invalid reference execution');
        const prior = db.prepare('SELECT binding_json, account, result_json FROM source_receipts WHERE source_key = ?').get(sourceIdentity(binding));
        if (!prior) return undefined;
        if (prior.binding_json !== checkedJson(binding) || prior.account !== actorAccount) throw stateError('Reference source binding changed');
        return JSON.parse(prior.result_json);
      }, 'Reference source read failed');
    },
    async count(installationId, actor) {
      return safeDatabaseError(() => {
        assertOpen();
        if (typeof installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(installationId)) {
          throw stateError('Invalid reference installation');
        }
        const account = accountFor(actor);
        const row = db.prepare(`
          SELECT action_count FROM action_counters WHERE installation_id = ? AND subject = ? AND account = ?
        `).get(installationId, actor.subject, account);
        return Number(row?.action_count ?? 0);
      }, 'Reference counter read failed');
    },
    stats() {
      return safeDatabaseError(() => {
        assertOpen();
        const marks = db.prepare('SELECT COALESCE(SUM(action_count), 0) AS value FROM action_counters').get().value;
        const journalRows = db.prepare('SELECT COUNT(*) AS value FROM execution_journal').get().value;
        const sourceRows = db.prepare('SELECT COUNT(*) AS value FROM source_receipts').get().value;
        const invocationRows = db.prepare('SELECT COUNT(*) AS value FROM used_invocations').get().value;
        return {
          marks: Number(marks),
          journalRows: Number(journalRows),
          sourceRows: Number(sourceRows),
          invocationRows: Number(invocationRows),
        };
      }, 'Reference state statistics failed');
    },
    close() {
      if (closed) return;
      safeDatabaseError(() => db.close(), 'Reference state could not be closed');
      closed = true;
    },
  });

  function assertOpen() {
    if (closed) throw stateError('Reference state is closed');
  }
}
