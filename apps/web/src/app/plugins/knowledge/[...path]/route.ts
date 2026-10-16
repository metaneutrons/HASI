import { demoResponse } from '@/lib/server/demo-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
function handle(request: Request) { return demoResponse(request, 'handleKnowledgePlugin'); }
export { handle as GET, handle as POST, handle as DELETE, handle as HEAD, handle as OPTIONS };
