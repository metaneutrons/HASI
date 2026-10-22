import {
  matchingResources,
  missingRoomDetails,
  requestStartDate,
  workplaceGroupQuestion,
  workplaceOfficeTypeCounts,
  workplaceRefinementQuestion,
  type RoomRequest,
} from "./chat-demo";
import type { HostDialogueCode } from "./host-dialogue";
import type { Resource } from "./types";

export type RoomDialogueCode = Extract<HostDialogueCode, `room_${string}`>;

export interface RoomDialoguePlan {
  code: RoomDialogueCode | null;
  text: string;
  resources: Resource[];
  total: number;
  needsAvailability: boolean;
  catalogDependent: boolean;
}

function staticPlan(code: RoomDialogueCode, text: string): RoomDialoguePlan {
  return {
    code,
    text,
    resources: [],
    total: 0,
    needsAvailability: false,
    catalogDependent: false,
  };
}

/** Plans bounded, catalog-backed room dialogue without performing any I/O. */
export function planRoomDialogue(
  request: RoomRequest,
  catalog: readonly Resource[],
  selectedResourceId?: string,
): RoomDialoguePlan {
  const groupQuestion = workplaceGroupQuestion(request);
  if (groupQuestion) return staticPlan("room_group", groupQuestion);

  const missing = missingRoomDetails(request);
  const invalid = Object.values(request).some((value) =>
    value === "__invalid__"
    || (typeof value === "number" && value <= 0)
    || (Array.isArray(value) && value.includes("__invalid__"))
  );
  if (invalid) {
    const details = missing.join(", ") || "Ausstattung oder Suchbegriff";
    return staticPlan(
      "room_invalid",
      `Diese Angaben sind nicht eindeutig. Bitte präzisiere: ${details}.`,
    );
  }

  const allMatches = matchingResources([...catalog], request);
  const matches = selectedResourceId === undefined
    ? allMatches
    : allMatches.filter((resource) => resource.id === selectedResourceId);

  const refinement = selectedResourceId === undefined
    ? workplaceRefinementQuestion(matches, request)
    : null;
  if (refinement) {
    return {
      code: "room_refine",
      text: refinement.question,
      resources: [],
      total: refinement.candidateCount,
      needsAvailability: false,
      catalogDependent: true,
    };
  }

  if (
    request.kind === "workplace"
    && request.officeType !== undefined
    && request.officeType !== "any"
    && matches.length === 0
  ) {
    const unfilteredRequest = { ...request };
    delete unfilteredRequest.officeType;
    const unfiltered = matchingResources([...catalog], unfilteredRequest);
    const unknown = workplaceOfficeTypeCounts(unfiltered).unknown;
    if (unknown > 0) {
      const requestedName = request.officeType === "single"
        ? "Einzelbüro oder 1er-Büro"
        : "geteiltes Büro oder 2er-/3er-Büro";
      return {
        code: "room_unknown_office",
        text: `Kein Arbeitsplatz ist ausdrücklich als ${requestedName} dokumentiert. Bei ${String(unknown)} passenden Arbeitsplätzen ist der Bürotyp nicht dokumentiert. Das schließt passende Büros nicht aus.`,
        resources: [],
        total: 0,
        needsAvailability: false,
        catalogDependent: true,
      };
    }
  }

  if (matches.length === 0) {
    return {
      code: "room_empty",
      text: "In den zugänglichen Raumdaten finde ich keinen passenden Raum. Ändere eine Anforderung oder nenne einen anderen Standort.",
      resources: [],
      total: 0,
      needsAvailability: false,
      catalogDependent: true,
    };
  }

  const resources = matches.slice(0, 8);
  const startDate = requestStartDate(request);
  const needsDetails = missing.length > 0 || !startDate || !request.durationMinutes;
  if (needsDetails) {
    const missingText = missing.join(", ") || "ein gültiges Datum und eine gültige Startzeit";
    const selected = selectedResourceId === undefined ? undefined : matches[0];
    const selectionText = selected
      ? `Wir planen mit ${selected.name}.`
      : `${String(matches.length)} passende ${request.kind === "workplace" ? "Arbeitsplätze" : "Ressourcen"} im Katalog gefunden.`;
    return {
      code: "room_details",
      text: `${selectionText} Für die weitere Prüfung fehlen noch: ${missingText}.`,
      resources: [],
      total: matches.length,
      needsAvailability: false,
      catalogDependent: true,
    };
  }

  return {
    code: null,
    text: "",
    resources,
    total: matches.length,
    needsAvailability: true,
    catalogDependent: true,
  };
}
