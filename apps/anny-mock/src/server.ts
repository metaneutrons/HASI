import { pathToFileURL } from 'node:url';
import { createAnnyMock } from './index.js';

export async function startAnnyMock(): Promise<void> {
  const rawPort = process.env.ANNY_MOCK_PORT ?? '4102';
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('ANNY_MOCK_PORT must be a valid TCP port.');
  }
  const host = process.env.ANNY_MOCK_HOST ?? '127.0.0.1';
  const token = process.env.ANNY_MOCK_TOKEN;
  const app = createAnnyMock(token === undefined ? {} : { token });
  await app.listen({ host, port });
  app.log.info(`Anny contract mock listening on http://${host}:${String(port)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAnnyMock().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
