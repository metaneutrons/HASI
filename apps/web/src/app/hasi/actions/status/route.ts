import { demoResponse } from "@/lib/server/demo-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return demoResponse(request, "handlePlugin"); }
