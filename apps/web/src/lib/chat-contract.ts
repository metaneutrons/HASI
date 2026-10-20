import { z } from "zod";

export const modelProfileIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/u)
  .refine((profileId) => profileId !== "offline", "offline is reserved for the local demo.");
export type ModelProfileId = z.infer<typeof modelProfileIdSchema>;

export const chatProfileIdSchema = z.union([modelProfileIdSchema, z.literal("offline")]);

export const modelProfileSchema = z.strictObject({
  id: modelProfileIdSchema,
  label: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(128),
  provider: z.enum(["groq", "gwdg", "deepinfra", "custom", "openai", "anthropic"]),
  configured: z.boolean(),
  fallbackLabels: z.array(z.string().min(1).max(100)).max(64).optional(),
});

export const modelProfilesResponseSchema = z
  .strictObject({
    configured: z.boolean(),
    userChoiceEnabled: z.boolean(),
    profiles: z.array(modelProfileSchema),
    defaultProfileId: modelProfileIdSchema,
  })
  .superRefine(({ configured, profiles }, context) => {
    if (configured !== profiles.some((profile) => profile.configured)) {
      context.addIssue({
        code: "custom",
        path: ["configured"],
        message: "The overall readiness must match profile readiness.",
      });
    }
  });
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type ModelProfilesResponse = z.infer<typeof modelProfilesResponseSchema>;

export const CHAT_TOOL_NAMES = [
  "knowledge_search",
  "anny_search_resources",
  "anny_get_availability",
  "anny_list_my_bookings",
  "anny_propose_booking",
  "anny_propose_cancellation",
] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

export const dynamicModelToolNameSchema = z.string().regex(/^hasi_[a-f0-9]{24}$/u);
export const chatToolCallNameSchema = z.union([
  z.enum(CHAT_TOOL_NAMES),
  dynamicModelToolNameSchema,
]);
export type ChatToolCallName = z.infer<typeof chatToolCallNameSchema>;

const nonEmptyText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split("-");
    if (yearText === undefined || monthText === undefined || dayText === undefined) return false;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });

const clockTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const annyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const offsetDateTimeSchema = z.iso.datetime({ offset: true });

export const chatToolSchemas = {
  knowledge_search: z.strictObject({
    query: z.string().trim().min(2).max(500).describe("Konkrete Suchbegriffe zur IT- oder Intranet-Frage, keine Anweisungen an den Dienst."),
    sourceSystem: z.enum(["service_it", "intranet"]).optional(),
  }),
  anny_search_resources: z.strictObject({
    kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']).describe("Büro/Schreibtisch bedeutet workplace (ein einzelner Arbeitsplatz). room umfasst ganze Räume ohne Arbeitsplätze; meeting_room und lecture_hall sind gezielte Raumarten.").optional(),
    officeType: z.enum(["single", "shared", "any"]).describe("Bürotyp bei workplace: officeWorkplaceCount ist maßgeblich (1=single, größer 1=shared). Fehlt der Zähler, nur ausdrücklich als Einzelbüro/1er-Büro oder geteilt/2er-/3er-Büro benannte Büros zuordnen; sonst unbekannt lassen. any bedeutet keine Präferenz.").optional(),
    capacity: z.number().int().min(1).max(500).describe("Mindest-Personenkapazität eines ganzen Raums. Für einen Arbeitsplatz weglassen; mehrere Arbeitsplätze sind separate Ressourcen.").optional(),
    features: z.array(nonEmptyText(128)).max(10).describe("Nur ausdrücklich gewünschte Ausstattungsmerkmale; sonst weglassen.").optional(),
    location: nonEmptyText(300).describe("Nur ein ausdrücklich genannter Standort, ein Gebäudecode (z. B. 1J, ohne das Wort Gebäude) oder bei Arbeitsplätzen das zugehörige Büro; sonst weglassen, niemals leer oder null.").optional(),
    query: nonEmptyText(500).describe("Ein konkreter Raum- oder Büroname, z. B. Amrum. Gebäudecodes gehören in location. Allgemeine Wörter wie Büro, Arbeitsplatz oder Gebäude sind keine Namen: query dann weglassen, niemals leer oder null.").optional(),
  }),
  anny_get_availability: z.strictObject({
    resourceId: annyId,
    date: calendarDateSchema,
    time: clockTimeSchema,
    durationMinutes: z.number().int().min(15).max(1440),
  }),
  anny_list_my_bookings: z.strictObject({}),
  anny_propose_cancellation: z.strictObject({ bookingId: annyId }),
  anny_propose_booking: z
    .strictObject({
      resourceId: annyId,
      startDate: offsetDateTimeSchema,
      endDate: offsetDateTimeSchema,
    })
    .refine(
      ({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate),
    ),
} as const;

export const chatToolDescriptions: Readonly<Record<ChatToolName, string>> =
  Object.freeze({
    knowledge_search: "Suche in aktuell freigegebenen Service-IT- und Intranet-Dokumenten. Verwende dieses Tool für Hochschul- und IT-Fragen. synthetic=true kennzeichnet erfundene Beispiele ohne Geltung als HsH-Anleitung. Quellenrevision, Aktualität und geprüfte Bildtranskripte beachten; fehlende oder widersprüchliche Belege ausdrücklich nennen.",
    anny_search_resources:
      "Suche getrennt nach einzelnen Arbeitsplätzen (auch bei Büro-Anfragen), Besprechungsräumen oder Hörsälen. Nutze kind für die Buchungseinheit. Bei workplace bestimmt officeWorkplaceCount den Typ: 1 bedeutet Einzelbüro, mehr als 1 ein geteiltes Büro. Fehlt der Zähler, klassifiziere nur ausdrücklich als Einzelbüro/1er oder geteilt/2er-/3er bezeichnete Büros; sonst bleibt es unbekannt. any bedeutet keine Präferenz. Personenkapazität gehört zu ganzen Räumen. Arbeitsplätze liefern ihr übergeordnetes Büro, das nicht mitgebucht wird. Verfügbarkeit wird separat geprüft.",
    anny_get_availability:
      "Prüfe die Verfügbarkeit einer bekannten Ressource für ein konkretes Datum, eine Uhrzeit und eine Dauer. Behaupte keine Verfügbarkeit ohne dieses Ergebnis.",
    anny_list_my_bookings:
      "Rufe die Buchungen der angemeldeten Person ab. Erfinde keine Buchungsdaten und leite keine Identität aus dem Gespräch ab.",
    anny_propose_cancellation:
      "Bereite die Stornierung einer eigenen aktiven zukünftigen Buchung vor. Verwende eine bookingId aus anny_list_my_bookings; bei Mehrdeutigkeit nachfragen. Führt keine Stornierung aus. Nur die separate Bestätigung auf der Vorschlagskarte darf sie auslösen.",
    anny_propose_booking:
      "Erstelle einen Buchungsvorschlag für eine Ressource und einen Zeitraum. Dieses Tool führt keine Buchung aus. Eine Buchung darf erst nach einer gesonderten ausdrücklichen Bestätigung behauptet werden.",
  });

function boundedJsonValue(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 512 || depth > 12) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 8_000;
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => visit(child, depth + 1));
    if (typeof item !== "object") return false;
    const entries = Object.entries(item);
    return entries.length <= 128 && entries.every(([key, child]) => key.length <= 256 && key !== "__proto__" && visit(child, depth + 1));
  };
  return visit(value, 0);
}

const toolArgumentsSchema = z.record(z.string().max(256), z.unknown()).superRefine((value, context) => {
  if (!boundedJsonValue(value)) context.addIssue({ code: "custom", message: "Tool arguments exceed the permitted JSON bounds." });
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024) {
      context.addIssue({ code: "custom", message: "Tool arguments exceed the permitted size." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Tool arguments are not valid JSON." });
  }
});

const toolCallSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  name: chatToolCallNameSchema,
  arguments: toolArgumentsSchema,
});

export const messageTimestampSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type MessageTimestamp = z.infer<typeof messageTimestampSchema>;
export const messageMetadataShape = {
  id: z.uuid().optional(),
  timestamp: messageTimestampSchema.optional(),
};

const userMessageSchema = z.strictObject({
  ...messageMetadataShape,
  role: z.literal("user"),
  content: z.string().min(1).max(4000),
});

export const knowledgeEvidenceSchema = z.strictObject({
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  contextIds: z.array(z.uuid()).max(32),
  toolContextIds: z.array(z.uuid()).max(32).optional(),
  expiresAt: z.iso.datetime(),
  receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type KnowledgeEvidence = z.infer<typeof knowledgeEvidenceSchema>;

const assistantMessageSchema = z.strictObject({
  evidence: knowledgeEvidenceSchema.optional(),
  ...messageMetadataShape,
  role: z.literal("assistant"),
  content: z.string().max(4000),
  toolCalls: z.array(toolCallSchema).min(1).max(4).optional(),
});

const toolMessageSchema = z.strictObject({
  ...messageMetadataShape,
  role: z.literal("tool"),
  content: z.string().max(8000),
  toolCallId: z.string().trim().min(1).max(128),
  name: chatToolCallNameSchema,
  toolContextId: z.uuid().optional(),
});

export const wireMessageSchema = z.discriminatedUnion("role", [
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

export type WireMessage = z.infer<typeof wireMessageSchema>;

function addSequenceIssue(
  context: z.RefinementCtx,
  index: number,
  message: string,
): void {
  context.addIssue({
    code: "custom",
    path: ["messages", index],
    message,
  });
}

function validateMessageSequence(
  messages: WireMessage[],
  context: z.RefinementCtx,
): void {
  if (messages.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "At least one message is required.",
    });
    return;
  }

  if (messages[0]?.role !== "user") {
    addSequenceIssue(context, 0, "A conversation must begin with a user message.");
  }

  const seenCallIds = new Set<string>();
  const pendingToolCalls: { id: string; name: ChatToolCallName }[] = [];
  let totalContentLength = 0;

  messages.forEach((message, index) => {
    totalContentLength += message.content.length;

    if (pendingToolCalls.length > 0) {
      if (message.role !== "tool") {
        addSequenceIssue(
          context,
          index,
          "Only matching tool results may follow an assistant tool call.",
        );
        return;
      }

      const pendingIndex = pendingToolCalls.findIndex(
        (toolCall) => toolCall.id === message.toolCallId,
      );
      if (pendingIndex === -1) {
        addSequenceIssue(context, index, "The tool result has no pending tool call.");
        return;
      }

      const expected = pendingToolCalls[pendingIndex];
      if (expected?.name !== message.name) {
        addSequenceIssue(context, index, "The tool result name does not match its call.");
        return;
      }

      pendingToolCalls.splice(pendingIndex, 1);
      return;
    }

    if (message.role === "tool") {
      addSequenceIssue(context, index, "The tool result has no pending tool call.");
      return;
    }

    if (message.role === "assistant") {
      const previous = messages[index - 1];
      if (previous?.role === "assistant") {
        addSequenceIssue(
          context,
          index,
          "Assistant messages must follow a user message or completed tool results.",
        );
      }

      for (const [toolIndex, toolCall] of (message.toolCalls ?? []).entries()) {
        if (seenCallIds.has(toolCall.id)) {
          context.addIssue({
            code: "custom",
            path: ["messages", index, "toolCalls", toolIndex, "id"],
            message: "Tool call IDs must be unique within the conversation.",
          });
        }
        seenCallIds.add(toolCall.id);

        const argumentResult = isChatToolName(toolCall.name)
          ? chatToolSchemas[toolCall.name].safeParse(toolCall.arguments)
          : { success: dynamicModelToolNameSchema.safeParse(toolCall.name).success };
        if (!argumentResult.success) {
          context.addIssue({
            code: "custom",
            path: ["messages", index, "toolCalls", toolIndex, "arguments"],
            message: "Tool arguments do not match the tool contract.",
          });
        }

        pendingToolCalls.push({ id: toolCall.id, name: toolCall.name });
      }
    }
  });

  if (pendingToolCalls.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "Every tool call must have one matching tool result.",
    });
  }

  if (totalContentLength > 30_000) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "The conversation exceeds the total content limit.",
    });
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant") {
    addSequenceIssue(
      context,
      messages.length - 1,
      "A model request must end with a user message or a tool result.",
    );
  }
}

export const chatRequestSchema = z
  .strictObject({
    profileId: modelProfileIdSchema,
    conversationId: z.uuid().optional(),
    routingToken: z.string().min(1).max(2_048).optional(),
    proposalIds: z.array(z.uuid()).max(8).refine(ids => new Set(ids).size === ids.length).optional(),
    messages: z.array(wireMessageSchema).max(64),
  })
  .superRefine((request, context) => {
    if (request.messages.length > 64) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "A request may contain at most 64 messages.",
      });
    }

    validateMessageSequence(request.messages, context);
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const modelReplySchema = z
  .strictObject({
    message: assistantMessageSchema,
    contextNotice: z.string().max(300).optional(),
    profile: z.strictObject({
      id: modelProfileIdSchema,
      label: nonEmptyText(100),
      modelId: nonEmptyText(128),
      provider: z.enum(["groq", "gwdg", "deepinfra", "custom", "openai", "anthropic"]),
    }),
    routingToken: z.string().min(1).max(2_048).optional(),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  })
  .superRefine((reply, context) => {
    const seenCallIds = new Set<string>();
    for (const [index, toolCall] of (reply.message.toolCalls ?? []).entries()) {
      if (seenCallIds.has(toolCall.id)) {
        context.addIssue({
          code: "custom",
          path: ["message", "toolCalls", index, "id"],
          message: "Tool call IDs must be unique within the assistant message.",
        });
      }
      seenCallIds.add(toolCall.id);

      const argumentResult = isChatToolName(toolCall.name)
        ? chatToolSchemas[toolCall.name].safeParse(toolCall.arguments)
        : { success: dynamicModelToolNameSchema.safeParse(toolCall.name).success };
      if (!argumentResult.success) {
        context.addIssue({
          code: "custom",
          path: ["message", "toolCalls", index, "arguments"],
          message: "Tool arguments do not match the tool contract.",
        });
      }
    }
  });

export type ModelReply = z.infer<typeof modelReplySchema>;

export function isChatToolName(value: string): value is ChatToolName {
  return Object.hasOwn(chatToolSchemas, value);
}

export const timestampRequestSchema = z.strictObject({
  messages: z.array(wireMessageSchema).min(1).max(16),
}).refine(({ messages }) => messages.every(message => message.id !== undefined) && new Set(messages.map(message => message.id)).size === messages.length);
export const timestampResponseSchema = z.strictObject({
  timestamps: z.array(z.strictObject({ id: z.uuid(), timestamp: messageTimestampSchema })).max(16),
});
