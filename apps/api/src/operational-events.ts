import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const operationalEventName = 'api.request.completed' as const;
export const operationalRequestMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;
export type OperationalRequestMethod = typeof operationalRequestMethods[number];

export interface OperationalRequestEvent {
  readonly eventName: typeof operationalEventName;
  readonly requestId: string;
  readonly route: string;
  readonly method: OperationalRequestMethod;
  readonly statusCode: number;
  readonly elapsedMs: number;
}

/** Trusted server-side composition hook; callers must not pass client-controlled data as an event. */
export type OperationalEventSink = (event: OperationalRequestEvent) => void | Promise<void>;

const supportedMethods = new Set<string>(operationalRequestMethods.filter(method => method !== 'OTHER'));
const requestIdHeader = 'x-request-id';

function boundedMethod(method: string): OperationalRequestMethod {
  return supportedMethods.has(method) ? method as OperationalRequestMethod : 'OTHER';
}

function registeredRoute(request: FastifyRequest): string {
  const routeOptions = (request as unknown as { routeOptions?: { url?: unknown } }).routeOptions;
  const route = routeOptions?.url;
  return typeof route === 'string' && route !== '*' && route.length > 0 ? route : 'unmatched';
}

export function registerOperationalEventHooks(app: FastifyInstance, sink?: OperationalEventSink): void {
  const requests = new WeakMap<FastifyRequest, { readonly requestId: string; readonly method: OperationalRequestMethod; readonly startedAt: number }>();

  app.addHook('onRequest', async (request, reply) => {
    const requestId = randomUUID();
    requests.set(request, { requestId, method: boundedMethod(request.method), startedAt: performance.now() });
    reply.header(requestIdHeader, requestId);
  });

  app.addHook('onResponse', async (request, reply) => {
    const started = requests.get(request);
    if (!started || !sink) return;

    const event: OperationalRequestEvent = {
      eventName: operationalEventName,
      requestId: started.requestId,
      route: registeredRoute(request),
      method: started.method,
      statusCode: reply.statusCode,
      elapsedMs: Math.max(0, Math.round(performance.now() - started.startedAt)),
    };
    try {
      await sink(event);
    } catch {
      // Operational telemetry is best effort; sink errors and their payloads stay out of logs and responses.
    }
  });
}

export function createConsoleOperationalEventSink(): OperationalEventSink {
  return event => { console.log(JSON.stringify(event)); };
}
