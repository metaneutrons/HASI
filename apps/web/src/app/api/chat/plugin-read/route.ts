import { chatAccess } from "@/lib/server/chat-access";
import { createKnowledgeEvidence } from "@/lib/server/knowledge-evidence";
import { productionHistoryAuthority } from "@/lib/server/history-authority";
import { loadAuthorizedModelTools } from "@/lib/server/authorized-tools";
import { protectedCoreRequest } from "@/lib/server/core-api";
import { getServerChatStorage } from "@/lib/server/server-chat-storage";
import { PluginResultContextStore } from "@/lib/server/plugin-result-context";
import { handlePluginResultRead } from "@/lib/server/plugin-result-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  if (!access.production) return Response.json({ error: "Nicht gefunden." }, { status: 404, headers: { "cache-control": "private, no-store" } });
  try {
    return await handlePluginResultRead(access.request, {
      allowedOrigins: access.allowedOrigins, dataClasses: access.modelContext.dataClasses,
      signer: createKnowledgeEvidence(access.production.secret, access.production.scope),
      contexts: new PluginResultContextStore({ store: await getServerChatStorage(), ...access.production }),
      authority: () => productionHistoryAuthority(access.request),
      tools: () => loadAuthorizedModelTools(access.request),
      invoke: (tool, arguments_) => protectedCoreRequest("/api/tools/call", new Request(access.request.url, {
        method: "POST", headers: access.request.headers,
        body: JSON.stringify({ pluginId: tool.pluginId, name: tool.name, arguments: arguments_, requiredEffect: "read" }),
      })),
    });
  } catch {
    return Response.json({ error: "Der Ergebnisspeicher ist vorübergehend nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}
