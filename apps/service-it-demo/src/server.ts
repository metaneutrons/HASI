import { pathToFileURL } from 'node:url';
import { createServiceItDemo } from './index.js';

export async function startServiceItDemo(): Promise<void> {
  const rawPort = process.env.SERVICE_IT_DEMO_PORT ?? '4110';
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('SERVICE_IT_DEMO_PORT must be a valid TCP port.');
  }
  const host = process.env.SERVICE_IT_DEMO_HOST ?? '0.0.0.0';
  const app = createServiceItDemo();
  await app.listen({ host, port });
  app.log.info(`Service IT synthetic demo listening on http://${host}:${String(port)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServiceItDemo().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
