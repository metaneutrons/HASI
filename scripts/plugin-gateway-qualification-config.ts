/** Fixed disposable local test database; production destinations are forbidden. */
export function qualificationDatabase(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('qualification_database_required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('qualification_database_invalid'); }
  const port = Number(url.port);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.username !== 'postgres' || url.password || url.search || url.hash
    || url.pathname !== '/hasi_topology_test' || !url.port || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('qualification_database_not_disposable_loopback');
  }
  return { host: '127.0.0.1', port, user: 'postgres', password: '', database: 'hasi_topology_test', ssl: false as const,
    max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000 };
}

export function assertNoPostgresEnvironment(): void {
  if (Object.keys(process.env).some(name => (name.startsWith('PG') || name === 'NODE_PG_FORCE_NATIVE') && process.env[name])) {
    throw new Error('qualification_postgres_environment_override');
  }
}
