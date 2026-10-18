import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginFetch, PluginNetworkError, type PluginFetch } from '../apps/api/src/network-policy.js';
import { createPluginDeploymentGateway } from '../apps/api/src/plugin-deployment-proxy.js';

const fetchers: PluginFetch[] = [];

afterEach(async () => {
  await Promise.all(fetchers.splice(0).map(fetcher => fetcher.close()));
  vi.unstubAllEnvs();
});

async function withServer<T>(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function track(options: Parameters<typeof createPluginFetch>[0]): PluginFetch {
  const fetcher = createPluginFetch(options);
  fetchers.push(fetcher);
  return fetcher;
}

describe('plugin outbound network policy', () => {
  it('accepts only bare configured HTTPS origins or explicitly enabled loopback HTTP', async () => {
    for (const origin of [
      'https://user:secret@plugin.example',
      'https://plugin.example/path',
      'https://plugin.example?secret=1',
      'https://plugin.example#fragment',
      'http://plugin.example',
      'http://127.0.0.1',
      'https://localhost',
    ]) {
      expect(() => createPluginFetch({ origins: [origin] })).toThrow();
    }
    expect(() => createPluginFetch({ origins: ['https://169.254.169.254'] })).toThrow();
    expect(() => createPluginFetch({ origins: ['https://[::ffff:127.0.0.1]'] })).toThrow();
    expect(() => createPluginFetch({ origins: ['https://[64:ff9b::a9fe:a9fe]'] })).toThrow();
    const loopbackFetch = createPluginFetch({ origins: ['http://127.0.0.1'], allowLoopback: true });
    await loopbackFetch.close();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createPluginFetch({ origins: ['http://127.0.0.1'], allowLoopback: true })).toThrow('Loopback plugin access is unavailable in production.');
    vi.unstubAllEnvs();
  });

  it('pins the real loopback connection through the injected connection-time lookup', async () => {
    let lookups = 0;
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      lookups += 1;
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    };

    await withServer((_request, response) => response.end('loopback-ok'), async origin => {
      const hostnameOrigin = origin.replace('127.0.0.1', 'localhost');
      const fetcher = track({ origins: [hostnameOrigin], allowLoopback: true, lookup });
      const response = await fetcher(hostnameOrigin);
      expect(await response.text()).toBe('loopback-ok');
      expect(lookups).toBeGreaterThan(0);
    });
  });

  it('permits only the exact operator-created 127.0.0.1 gateway origin in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const gateway = await createPluginDeploymentGateway({
      port: 0,
      endpointResolver: {
        resolveActiveEndpoint: () => Promise.resolve(null),
        assertActiveEndpoint: () => Promise.resolve(false),
      },
      authorize: () => false,
    });
    try {
      const url = new URL(gateway.origin);
      expect(url.hostname).toBe('127.0.0.1');
      const fetcher = track({ origins: [gateway.origin], operatorManagedLoopbackOrigin: gateway.origin });
      const health = await fetcher(`${gateway.origin}/healthz`, { signal: AbortSignal.timeout(1_000) });
      expect(health.status).toBe(200);
      await health.body?.cancel();

      expect(() => createPluginFetch({
        origins: [`http://localhost:${url.port}`],
        operatorManagedLoopbackOrigin: gateway.origin,
      })).toThrow('Loopback plugin origins must be explicitly enabled.');
      expect(() => createPluginFetch({
        origins: [gateway.origin],
        operatorManagedLoopbackOrigin: `http://127.0.0.1:${String(Number(url.port) + 1)}`,
      })).toThrow('Loopback plugin origins must be explicitly enabled.');
      expect(() => createPluginFetch({ origins: [gateway.origin], allowLoopback: true })).toThrow('Loopback plugin access is unavailable in production.');
    } finally {
      await gateway.close();
    }
  });

  it('rejects a mixed DNS answer set before connecting, even when one address is operator-approved', async () => {
    let requests = 0;
    let lookups = 0;
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      lookups += 1;
      callback(null, [
        { address: '10.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    };

    await withServer((_request, response) => {
      requests += 1;
      response.end('should-not-connect');
    }, async origin => {
      const port = new URL(origin).port;
      const fetcher = track({
        origins: [`https://mixed.test:${port}`],
        allowedPrivateCidrs: ['10.0.0.0/8'],
        lookup,
      });
      await expect(fetcher(`https://mixed.test:${port}/?credential=private-value`)).rejects.toBeInstanceOf(PluginNetworkError);
      expect(lookups).toBe(1);
      expect(requests).toBe(0);
    });
  });

  it.each([
    { label: 'IPv4 metadata/link-local', address: '169.254.169.254', family: 4, cidr: '169.254.0.0/16' },
    { label: 'IPv6 link-local', address: 'fe80::1', family: 6, cidr: 'fe80::/10' },
    { label: 'IPv6 metadata', address: 'fd00:ec2::254', family: 6, cidr: 'fd00::/8' },
  ])('keeps $label blocked even when its range is operator-approved', async ({ address, family, cidr }) => {
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, [{ address, family }]);
    };
    const fetcher = track({
      origins: ['https://protected.test'],
      allowedPrivateCidrs: [cidr],
      lookup,
    });
    await expect(fetcher('https://protected.test/')).rejects.toBeInstanceOf(PluginNetworkError);
  });

  it.each(['127.0.0.0/8', '127.0.0.1/32', '::1/128', '::/4'])('rejects loopback CIDR %s without weakening the explicit loopback guard', cidr => {
    expect(() => createPluginFetch({ origins: ['https://plugin.example'], allowedPrivateCidrs: [cidr] })).toThrow('loopback policy');
  });

  it('does not allow an approved range to include public IPv4 space', () => {
    expect(() => createPluginFetch({
      origins: ['https://plugin.example'],
      allowedPrivateCidrs: ['0.0.0.0/0'],
    })).toThrow('Approved ranges must be non-public network ranges.');
    expect(() => createPluginFetch({
      origins: ['https://plugin.example'],
      allowedPrivateCidrs: ['10.0.0.0/7'],
    })).toThrow('Approved ranges must be non-public network ranges.');
  });

  it('accepts narrow operator-approved IPv6 special-use ranges', async () => {
    const fetcher = createPluginFetch({
      origins: ['https://plugin.example'],
      allowedPrivateCidrs: ['2001:db8::/32', 'fd00::/8'],
    });
    await fetcher.close();
  });

  it('rejects request credentials and fragments without echoing their values', async () => {
    await withServer((_request, response) => response.end('ok'), async origin => {
      const fetcher = track({ origins: [origin], allowLoopback: true });
      await expect(fetcher(origin.replace('127.0.0.1', 'user:password@127.0.0.1'))).rejects.toMatchObject({
        name: 'PluginNetworkError',
      });
      await expect(fetcher(`${origin}/#private-fragment`)).rejects.toMatchObject({
        name: 'PluginNetworkError',
      });
      await expect(fetcher('https://unlisted.example/')).rejects.toMatchObject({
        name: 'PluginNetworkError',
      });
    });
  });

  it('refuses redirects and bounds response bytes with generic errors', async () => {
    let redirectTargetRequests = 0;
    await withServer((request, response) => {
      if (request.url?.startsWith('/redirect')) {
        response.writeHead(302, { location: '/redirect-target?secret=never-expose' }).end();
      } else if (request.url?.startsWith('/redirect-target')) {
        redirectTargetRequests += 1;
        response.end('followed');
      } else {
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        response.write('12');
        response.end('345');
      }
    }, async origin => {
      const fetcher = track({ origins: [origin], allowLoopback: true, maxResponseBytes: 4 });
      const redirectError: unknown = await fetcher(`${origin}/redirect?query-is-allowed`).catch((error: unknown): unknown => error);
      expect(redirectError).toBeInstanceOf(PluginNetworkError);
      expect((redirectError as Error).message).not.toContain('never-expose');
      expect(redirectTargetRequests).toBe(0);

      const response = await fetcher(`${origin}/body`);
      await expect(response.text()).rejects.toBeInstanceOf(PluginNetworkError);
    });
  });

  it('bounds connection and response-header waits', async () => {
    await withServer((_request, _response) => undefined, async origin => {
      const fetcher = track({
        origins: [origin],
        allowLoopback: true,
        headersTimeoutMs: 100,
      });
      await expect(fetcher(origin)).rejects.toBeInstanceOf(PluginNetworkError);
    });
  });
});
