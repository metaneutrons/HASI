import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApi, operationalRequestMethods, PluginRegistry, type OperationalEventSink, type OperationalRequestEvent } from '../apps/api/src/index.js';

const requestHeaders = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };

async function createTestApi(operationalEventSink?: OperationalEventSink) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createApi({ mode: 'test', registry: new PluginRegistry(privateKey), ...(operationalEventSink ? { operationalEventSink } : {}) });
}

describe('content-free operational request events', () => {
  it('emits a closed event for a successful request and replaces a forged request ID', async () => {
    const events: OperationalRequestEvent[] = [];
    const api = await createTestApi(event => { events.push(event); });
    try {
      const response = await api.inject({
        method: 'GET',
        url: '/api/session?filter=QUERY_SECRET_SENTINEL',
        headers: {
          ...requestHeaders,
          'x-request-id': 'FORGED_ID_SENTINEL',
          cookie: 'hasi-session=COOKIE_SECRET_SENTINEL',
          authorization: 'Bearer AUTH_SECRET_SENTINEL',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ mode: 'mock', user: null });
      const responseId = response.headers['x-request-id'];
      expect(responseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(responseId).not.toBe('FORGED_ID_SENTINEL');
      expect(events).toHaveLength(1);
      expect(events[0]!.eventName).toBe('api.request.completed');
      expect(events[0]!.requestId).toBe(responseId);
      expect(events[0]!.route).toBe('/api/session');
      expect(events[0]!.method).toBe('GET');
      expect(events[0]!.statusCode).toBe(200);
      expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(events[0]!.elapsedMs)).toBe(true);
      expect(Object.keys(events[0]!).sort()).toEqual(['elapsedMs', 'eventName', 'method', 'requestId', 'route', 'statusCode']);
      expect(JSON.stringify(events)).not.toContain('QUERY_SECRET_SENTINEL');
      expect(JSON.stringify(events)).not.toContain('COOKIE_SECRET_SENTINEL');
      expect(JSON.stringify(events)).not.toContain('AUTH_SECRET_SENTINEL');
      expect(JSON.stringify(events)).not.toContain('FORGED_ID_SENTINEL');
    } finally {
      await api.close();
    }
  });

  it('records denied and unmatched requests without URL, body, header, cookie, or identity input', async () => {
    const events: OperationalRequestEvent[] = [];
    const api = await createTestApi(event => { events.push(event); });
    try {
      const denied = await api.inject({
        method: 'POST',
        url: '/api/dev/login?token=QUERY_SECRET_SENTINEL',
        headers: {
          ...requestHeaders,
          origin: 'https://HEADER_SECRET_SENTINEL.invalid',
          'x-request-id': 'FORGED_ID_SENTINEL',
          'x-client-data': 'HEADER_SECRET_SENTINEL',
          authorization: 'Bearer AUTH_SECRET_SENTINEL',
          cookie: 'session=COOKIE_SECRET_SENTINEL',
        },
        payload: { personaId: 'BODY_SECRET_SENTINEL' },
      });
      const unmatched = await api.inject({
        method: 'PROPFIND',
        url: '/unmatched/PATH_SECRET_SENTINEL?token=QUERY_SECRET_SENTINEL',
        headers: {
          ...requestHeaders,
          'x-request-id': 'FORGED_ID_SENTINEL',
          'x-client-data': 'HEADER_SECRET_SENTINEL',
          authorization: 'Bearer AUTH_SECRET_SENTINEL',
          cookie: 'session=COOKIE_SECRET_SENTINEL',
        },
        payload: { value: 'BODY_SECRET_SENTINEL' },
      });

      expect(denied.statusCode).toBe(403);
      expect(unmatched.statusCode).toBe(404);
      expect(events.map(event => ({ route: event.route, method: event.method, statusCode: event.statusCode }))).toEqual([
        { route: '/api/dev/login', method: 'POST', statusCode: 403 },
        { route: 'unmatched', method: 'OTHER', statusCode: 404 },
      ]);
      for (const event of events) expect(operationalRequestMethods).toContain(event.method);
      expect(JSON.stringify(events)).not.toContain('SECRET_SENTINEL');
      expect(JSON.stringify(events)).not.toContain('FORGED_ID_SENTINEL');
      for (const response of [denied, unmatched]) {
        expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
        expect(response.headers['x-request-id']).not.toBe('FORGED_ID_SENTINEL');
      }
    } finally {
      await api.close();
    }
  });

  it('keeps the API response intact and does not log sink exception payloads', async () => {
    let sinkCalls = 0;
    const sink: OperationalEventSink = () => {
      sinkCalls++;
      throw new Error('SINK_EXCEPTION_SECRET_SENTINEL');
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = await createTestApi(sink);
    try {
      const response = await api.inject({ method: 'GET', url: '/api/session', headers: requestHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ mode: 'mock', user: null });
      expect(response.body).not.toContain('SINK_EXCEPTION_SECRET_SENTINEL');
      expect(sinkCalls).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      await api.close();
      log.mockRestore();
      error.mockRestore();
    }
  });
});
