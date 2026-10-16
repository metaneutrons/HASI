import { demoResponse } from '@/lib/server/demo-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function handle(request: Request) {
  const path = new URL(request.url).pathname;
  return demoResponse(request, path.startsWith('/api/v1/') ? 'handleMock' : 'handleCore');
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
