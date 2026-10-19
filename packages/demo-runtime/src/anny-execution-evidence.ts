import { DEMO_EXECUTION_HEADER, demoExecutionStatusSchema } from '@hasi/anny-mock';
import type { ExecutionBinding } from '@hasi/plugin-sdk';

interface DemoAnnyTransportOptions {
  origin: string;
  workspaceId: string;
  serviceToken: string;
  fetch: typeof fetch;
  execution?: Readonly<ExecutionBinding>;
}

/** Synthetic source correlation is an explicit mock capability, not an Anny API extension. */
export function createDemoAnnyTransport(options: DemoAnnyTransportOptions): typeof fetch {
  return (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== options.origin || !target.pathname.startsWith('/api/v1/')) throw new Error('Unapproved mock destination.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => { headers.set(name, value); });
    headers.delete(DEMO_EXECUTION_HEADER);
    headers.set('x-hasi-demo-workspace', options.workspaceId);
    headers.set('authorization', `Bearer ${options.serviceToken}`);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const tool = method === 'POST' && target.pathname === '/api/v1/orders/from-config' ? 'anny.execute_booking'
      : method === 'GET' && /^\/api\/v1\/bookings\/[A-Za-z0-9_-]+\/cancel$/u.test(target.pathname) ? 'anny.execute_cancellation' : undefined;
    if (tool && options.execution) {
      if (options.execution.tool !== tool) throw new Error('Mock execution/tool mismatch.');
      headers.set(DEMO_EXECUTION_HEADER, Buffer.from(JSON.stringify({ schemaVersion: 1, binding: options.execution })).toString('base64url'));
    }
    return options.fetch(input, { ...init, headers, redirect: 'error' });
  };
}

export async function readDemoAnnyExecutionEvidence(options: DemoAnnyTransportOptions, binding: Readonly<ExecutionBinding>): Promise<unknown> {
  const response = await createDemoAnnyTransport(options)(`${options.origin}/api/v1/_hasi-demo/execution-status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ binding }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); return []; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk: { done: boolean; value?: unknown } = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid source evidence stream.');
      size += value.byteLength;
      if (size > 32 * 1024) { await reader.cancel(); return []; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const parsed = demoExecutionStatusSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  return parsed.success ? parsed.data.receipts : [];
}
