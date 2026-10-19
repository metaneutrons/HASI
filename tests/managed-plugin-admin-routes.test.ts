import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedPluginCommand,
  ManagedPluginView,
} from '@hasi/plugin-sdk/deployment-admin';
import { createApi, PluginRegistry } from '../apps/api/src/index.js';
import type { ManagedPluginAdmin } from '../apps/api/src/managed-plugin-admin.js';

const commandId = 'd70a51c8-632b-48be-92e8-066ea455e21b';
const digest = 'a'.repeat(64);
const stateToken = 'b'.repeat(64);
const installation: ManagedPluginView = {
  id: 'de.example.calendar',
  label: 'Calendar',
  stateToken,
  status: 'empty',
  configurationRevision: 'configuration-1',
  configurationReady: true,
  current: null,
  previous: null,
  candidate: null,
  releases: [{
    id: 'calendar-1.0.0',
    version: '1.0.0',
    publisher: 'example.publisher',
    digest,
    migration: 'none',
    license: 'MIT',
    inventoryDigest: digest,
    approved: true,
  }],
};

const openApis: Awaited<ReturnType<typeof createApi>>[] = [];
const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };

async function setup(managedPlugins?: ManagedPluginAdmin) {
  const registry = new PluginRegistry(generateKeyPairSync('ed25519').privateKey);
  const api = await createApi({ mode: 'test', registry, ...(managedPlugins ? { managedPlugins } : {}) });
  openApis.push(api);

  async function login(personaId: 'admin' | 'student') {
    const response = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId } });
    expect(response.statusCode).toBe(200);
    return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  return { api, login };
}

afterEach(async () => {
  await Promise.all(openApis.splice(0).map(api => api.close()));
});

describe('managed plugin admin HTTP bridge', () => {
  it('requires the existing admin session and returns an empty catalog when the optional service is absent', async () => {
    const { api, login } = await setup();
    const adminCookie = await login('admin');
    const studentCookie = await login('student');

    expect((await api.inject({ url: '/api/admin/managed-plugins', headers })).statusCode).toBe(401);
    const list = await api.inject({ url: '/api/admin/managed-plugins', headers: { ...headers, cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ installations: [] });

    const denied = await api.inject({
      url: '/api/admin/managed-plugins',
      headers: { ...headers, cookie: studentCookie },
    });
    expect(denied.statusCode).toBe(403);

    const absentCommand = await api.inject({
      method: 'POST',
      url: '/api/admin/managed-plugins/de.example.calendar/commands',
      headers: { ...headers, cookie: adminCookie },
      payload: { commandId, expectedState: stateToken, operation: 'stage', releaseId: 'calendar-1.0.0' },
    });
    expect(absentCommand.statusCode).toBe(503);
    expect(absentCommand.json()).toEqual({ error: 'Die verwaltete Plug-in-Verwaltung ist derzeit nicht verfügbar.' });

    const badOrigin = await api.inject({
      method: 'POST',
      url: '/api/admin/managed-plugins/de.example.calendar/commands',
      headers: { host: '127.0.0.1', origin: 'https://outside.example', cookie: adminCookie },
      payload: { commandId, expectedState: stateToken, operation: 'stage', releaseId: 'calendar-1.0.0' },
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it('passes only the authenticated admin subject and enforces strict command schemas', async () => {
    const received: { operation: string; subject: string; installationId: string }[] = [];
    const statusCalls: { commandId: string; subject: string; installationId: string }[] = [];
    const listMock = vi.fn((subject: string) => {
      expect(subject).toBe('fixture-admin');
      return Promise.resolve({ installations: [installation] });
    });
    const commandMock = vi.fn((installationId: string, command: ManagedPluginCommand, subject: string) => {
      received.push({ operation: command.operation, subject, installationId });
      return Promise.resolve({ commandId: command.commandId, status: 'completed' as const, view: installation });
    });
    const commandStatusMock = vi.fn((installationId: string, requestedCommandId: string, subject: string) => {
      statusCalls.push({ commandId: requestedCommandId, subject, installationId });
      return Promise.resolve({ commandId: requestedCommandId, status: 'uncertain' as const, view: installation });
    });
    const service: ManagedPluginAdmin = {
      list: listMock,
      command: commandMock,
      commandStatus: commandStatusMock,
    };
    const { api, login } = await setup(service);
    const adminCookie = await login('admin');
    const studentCookie = await login('student');

    const list = await api.inject({ url: '/api/admin/managed-plugins', headers: { ...headers, cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ installations: [installation] });

    const baseCommand = { commandId, expectedState: stateToken, operation: 'stage', releaseId: 'calendar-1.0.0' };
    const extraField = await api.inject({
      method: 'POST',
      url: '/api/admin/managed-plugins/de.example.calendar/commands',
      headers: { ...headers, cookie: adminCookie },
      payload: { ...baseCommand, subject: 'attacker', role: 'admin' },
    });
    expect(extraField.statusCode).toBe(400);
    expect(commandMock).not.toHaveBeenCalled();

    const unauthorized = await api.inject({
      method: 'POST',
      url: '/api/admin/managed-plugins/de.example.calendar/commands',
      headers: { ...headers, cookie: studentCookie },
      payload: baseCommand,
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(commandMock).not.toHaveBeenCalled();

    const command = await api.inject({
      method: 'POST',
      url: '/api/admin/managed-plugins/de.example.calendar/commands',
      headers: { ...headers, cookie: adminCookie },
      payload: baseCommand,
    });
    expect(command.statusCode).toBe(200);
    expect(command.json()).toMatchObject({ commandId, status: 'completed', view: installation });
    expect(received).toEqual([{ operation: 'stage', subject: 'fixture-admin', installationId: 'de.example.calendar' }]);

    const commandState = await api.inject({
      url: `/api/admin/managed-plugins/de.example.calendar/commands/${commandId}`,
      headers: { ...headers, cookie: adminCookie },
    });
    expect(commandState.statusCode).toBe(200);
    expect(commandState.json()).toMatchObject({ commandId, status: 'uncertain' });
    expect(statusCalls).toEqual([{ commandId, subject: 'fixture-admin', installationId: 'de.example.calendar' }]);
  });

  it('returns fixed bridge errors without exposing service failure details', async () => {
    const service: ManagedPluginAdmin = {
      list: () => Promise.reject(new Error('private RPC address and token detail')),
      command: (_installationId: string, command: ManagedPluginCommand) => Promise.resolve({
        commandId: command.commandId,
        status: 'completed' as const,
        view: installation,
      }),
      commandStatus: () => Promise.reject(new Error('internal job record contents')),
    };
    const { api, login } = await setup(service);
    const adminCookie = await login('admin');

    const list = await api.inject({ url: '/api/admin/managed-plugins', headers: { ...headers, cookie: adminCookie } });
    expect(list.statusCode).toBe(502);
    expect(list.body).not.toContain('private RPC');
    expect(list.json()).toEqual({ error: 'Die verwalteten Plug-in-Installationen konnten nicht geladen werden.' });

    const status = await api.inject({
      url: `/api/admin/managed-plugins/de.example.calendar/commands/${commandId}`,
      headers: { ...headers, cookie: adminCookie },
    });
    expect(status.statusCode).toBe(502);
    expect(status.body).not.toContain('internal job');
    expect(status.json()).toEqual({ error: 'Der Befehlsstatus konnte nicht geprüft werden.' });
  });
});
