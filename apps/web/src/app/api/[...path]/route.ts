import { demoResponse } from '@/lib/server/demo-runtime';
import { productionApiResponse } from '@/lib/server/core-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function handle(request: Request) {
  if (process.env.HASI_APP_MODE === 'production') return productionApiResponse(request);
  const path = new URL(request.url).pathname;
  return demoResponse(request, path.startsWith('/api/v1/') ? 'handleMock' : 'handleCore');
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
