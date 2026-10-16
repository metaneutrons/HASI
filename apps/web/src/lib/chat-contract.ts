import { z } from "zod";

export const MODEL_PROFILE_IDS = [
  "groq-oss-120b",
  "groq-oss-20b",
  "groq-qwen-3.8-27b",
  "gwdg-qwen3-30b",
  "custom-default",
] as const;
export type ModelProfileId = (typeof MODEL_PROFILE_IDS)[number];

export const chatProfileIdSchema = z.union([z.enum(MODEL_PROFILE_IDS), z.literal("offline")]);

export const modelProfileSchema = z.strictObject({
  id: z.enum(MODEL_PROFILE_IDS),
  label: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(128),
  provider: z.enum(["groq", "gwdg", "custom"]),
  configured: z.boolean(),
});

export const modelProfilesResponseSchema = z
  .strictObject({
    configured: z.boolean(),
    profiles: z.array(modelProfileSchema),
    defaultProfileId: z.enum(MODEL_PROFILE_IDS),
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
] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

const nonEmptyText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
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
    capacity: z.number().int().min(1).max(500).describe("Mindest-Personenkapazität eines ganzen Raums. Für einen Arbeitsplatz weglassen; mehrere Arbeitsplätze sind separate Ressourcen.").optional(),
    features: z.array(nonEmptyText(128)).max(10).describe("Nur ausdrücklich gewünschte Ausstattungsmerkmale; sonst weglassen.").optional(),
    location: nonEmptyText(300).describe("Nur ein ausdrücklich genannter Standort; sonst weglassen, niemals leer oder null.").optional(),
    query: nonEmptyText(500).describe("Ein konkreter Raumname oder Suchbegriff; bei allgemeiner Raumsuche weglassen, niemals leer oder null.").optional(),
  }),
  anny_get_availability: z.strictObject({
    resourceId: annyId,
    date: calendarDateSchema,
    time: clockTimeSchema,
    durationMinutes: z.number().int().min(15).max(1440),
  }),
  anny_list_my_bookings: z.strictObject({}),
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
    knowledge_search: "Suche in den freigegebenen synthetischen Service-IT- und Intranet-Dokumenten. Verwende dieses Tool für Hochschul- und IT-Fragen. Ergebnisse sind erfundene Beispiele, keine echten HsH-Anleitungen. Fehlende oder widersprüchliche Belege ausdrücklich nennen.",
    anny_search_resources:
      "Suche getrennt nach einzelnen Arbeitsplätzen (auch bei Büro-Anfragen), Besprechungsräumen oder Hörsälen. Nutze kind für die Buchungseinheit. Personenkapazität gehört zu ganzen Räumen. Arbeitsplätze liefern ihr übergeordnetes Büro, das nicht mitgebucht wird. Verfügbarkeit wird separat geprüft.",
    anny_get_availability:
      "Prüfe die Verfügbarkeit einer bekannten Ressource für ein konkretes Datum, eine Uhrzeit und eine Dauer. Behaupte keine Verfügbarkeit ohne dieses Ergebnis.",
    anny_list_my_bookings:
      "Rufe die Buchungen der angemeldeten Person ab. Erfinde keine Buchungsdaten und leite keine Identität aus dem Gespräch ab.",
    anny_propose_booking:
      "Erstelle einen Buchungsvorschlag für eine Ressource und einen Zeitraum. Dieses Tool führt keine Buchung aus. Eine Buchung darf erst nach einer gesonderten ausdrücklichen Bestätigung behauptet werden.",
  });

const toolCallSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  name: z.enum(CHAT_TOOL_NAMES),
  arguments: z.record(z.string(), z.unknown()),
});

const userMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string().min(1).max(4000),
});

const assistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().max(4000),
  toolCalls: z.array(toolCallSchema).min(1).max(4).optional(),
});

const toolMessageSchema = z.strictObject({
  role: z.literal("tool"),
  content: z.string().max(8000),
  toolCallId: z.string().trim().min(1).max(128),
  name: z.enum(CHAT_TOOL_NAMES),
});

const wireMessageSchema = z.discriminatedUnion("role", [
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
  const pendingToolCalls: Array<{ id: string; name: ChatToolName }> = [];
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

        const argumentResult = chatToolSchemas[toolCall.name].safeParse(
          toolCall.arguments,
        );
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
    profileId: z.enum(MODEL_PROFILE_IDS),
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
    profile: z.strictObject({
      id: z.enum(MODEL_PROFILE_IDS),
      label: nonEmptyText(100),
      modelId: nonEmptyText(128),
      provider: z.enum(["groq", "gwdg", "custom"]),
    }),
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

      const argumentResult = chatToolSchemas[toolCall.name].safeParse(
        toolCall.arguments,
      );
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
