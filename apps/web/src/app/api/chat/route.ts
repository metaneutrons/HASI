import { createChatPostHandler } from "@/lib/server/chat-route";
import { listModelProfiles } from "@/lib/server/model-router";
import { loadModelPrices, modelPrice } from "@/lib/server/model-budgets";
import { loadModelConfiguration } from "@/lib/server/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  try {
    const result = listModelProfiles();
    const configuration = loadModelConfiguration(process.env);
    const prices = loadModelPrices(process.env);
    return Response.json({ ...result, profiles: result.profiles.map(profile => ({ ...profile, configured: profile.configured && modelPrice(profile.id, configuration, prices) !== undefined })) }, { headers: { "cache-control": "private, no-store" } });
  }
  catch { return Response.json({ error: "Die Modellkonfiguration ist nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}

export const POST = createChatPostHandler();
