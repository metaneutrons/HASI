"use client";

import { ArrowRight, Building2, CalendarDays, Check, ChevronDown, Clock3, MapPin, Users } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { formatDateTime, formatTime } from "@/lib/api";
import type { ChatRoomOption } from "@/lib/chat-sessions";
import type { Resource, TimeInterval } from "@/lib/types";

const INITIAL_VISIBLE_ROOMS = 4;

export interface ChatRoomResultsProps {
  rooms: ChatRoomOption[];
  disabled: boolean;
  onChooseRoom: (resource: Resource) => void;
  onChooseSlot: (resource: Resource, interval: TimeInterval) => void;
}

function kindLabel(resource: Resource): string {
  switch (resource.kind) {
    case "workplace": return "Einzelner Arbeitsplatz";
    case "lecture_hall": return "Hörsaal";
    case "meeting_room": return "Besprechungsraum";
    default: return "Raum";
  }
}

function resourceIdentity(resource: Resource): string {
  return `${resource.serviceId}:${resource.id}`;
}

function roomActionLabel(resource: Resource): string {
  return resource.kind === "workplace" ? "Diesen Arbeitsplatz planen" : "Diesen Raum planen";
}

function roomTimeLabel(resource: Resource, interval: TimeInterval): string {
  return `${resource.name}${resource.parentName ? ` in ${resource.parentName}` : ""} am ${formatDateTime(interval.startDate)} bis ${formatTime(interval.endDate)} vorbereiten`;
}

function RoomResult({
  room,
  disabled,
  onChooseRoom,
  onChooseSlot,
}: {
  room: ChatRoomOption;
  disabled: boolean;
  onChooseRoom: (resource: Resource) => void;
  onChooseSlot: (resource: Resource, interval: TimeInterval) => void;
}) {
  const headingId = `chat-room-result-heading-${useId()}`;
  const { resource, intervals, checked } = room;
  const isWorkplace = resource.kind === "workplace";
  const hasSlots = intervals.length > 0;
  const requestedTimestamp = room.requestedStartDate ? Date.parse(room.requestedStartDate) : Number.NaN;
  const hasRequestedTime = Number.isFinite(requestedTimestamp);
  const hasExactRequestedSlot = hasSlots && hasRequestedTime
    && intervals.some((interval) => Date.parse(interval.startDate) === requestedTimestamp);
  const statusLabel = checked
    ? hasSlots
      ? hasRequestedTime
        ? hasExactRequestedSlot ? "Im gewünschten Zeitraum verfügbar" : "Andere freie Zeiten"
        : `Verfügbarkeit geprüft · ${String(intervals.length)} freie ${intervals.length === 1 ? "Zeit" : "Zeiten"}`
      : hasRequestedTime ? "Keine freien Zeiten im gewünschten Zeitraum" : "Verfügbarkeit geprüft · keine freien Zeiten"
    : "Treffer · Verfügbarkeit ungeprüft";

  return (
    <article className="chat-room-result" aria-labelledby={headingId}>
      <div className="chat-room-result__heading">
        <span className="chat-room-result__icon" aria-hidden="true"><CalendarDays size={18} strokeWidth={1.7} /></span>
        <div className="chat-room-result__title">
          <h3 id={headingId}>{resource.name}</h3>
          {resource.parentName && <span className="chat-room-result__location"><Building2 size={13} aria-hidden="true" /> Büro: {resource.parentName}</span>}
          <span className="chat-room-result__location"><MapPin size={13} aria-hidden="true" /> {resource.location}</span>
        </div>
      </div>

      <div className="chat-room-result__meta">
        <span className="chat-room-result__kind"><Users size={13} aria-hidden="true" /> {kindLabel(resource)}</span>
        {isWorkplace && resource.officeWorkplaceCount !== null && resource.officeWorkplaceCount !== undefined && resource.officeWorkplaceCount > 0 && (
          <span className="chat-room-result__capacity">
            {resource.officeWorkplaceCount === 1 ? "Büro mit 1 Arbeitsplatz" : `Geteiltes Büro · ${String(resource.officeWorkplaceCount)} Arbeitsplätze`}
          </span>
        )}
        {!isWorkplace && <span className="chat-room-result__capacity">{resource.capacity === null ? "Personenkapazität nicht hinterlegt" : `bis ${String(resource.capacity)} Personen`}</span>}
        <span className={`chat-room-result__status ${checked ? hasSlots ? "chat-room-result__status--available" : "chat-room-result__status--checked" : "chat-room-result__status--candidate"}`}>
          {checked && hasSlots && <Check size={12} aria-hidden="true" />}
          {statusLabel}
        </span>
      </div>

      {resource.features.length > 0 && (
        <details className="chat-room-result__details">
          <summary><ChevronDown size={14} aria-hidden="true" /> Merkmale ({resource.features.length})</summary>
          <ul aria-label="Ausstattungsmerkmale">
            {resource.features.map((feature, index) => <li key={`${feature}-${String(index)}`}>{feature}</li>)}
          </ul>
        </details>
      )}

      {checked ? hasSlots ? (
        <div className="chat-room-result__slots" role="group" aria-label={`Freie Zeiten für ${resource.name}`}>
          {intervals.map((interval, index) => (
            <button
              className="chat-room-result__slot"
              type="button"
              disabled={disabled}
              onClick={() => { onChooseSlot(resource, interval); }}
              key={`${interval.startDate}-${interval.endDate}-${String(index)}`}
              aria-label={roomTimeLabel(resource, interval)}
            >
              <Clock3 size={14} aria-hidden="true" />
              <span>{formatDateTime(interval.startDate)}–{formatTime(interval.endDate)}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <p className="chat-room-result__no-slots" role="status">{hasRequestedTime ? "Keine freien Zeiten im gewünschten Zeitraum." : "Keine freien Zeiten zu diesen Anforderungen."}</p>
      ) : (
        <button className="chat-room-result__action" type="button" disabled={disabled} onClick={() => { onChooseRoom(resource); }}>
          {roomActionLabel(resource)} <ArrowRight size={15} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

export function ChatRoomResults({ rooms, disabled, onChooseRoom, onChooseSlot }: ChatRoomResultsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = `chat-room-results-${useId()}`;
  const headingId = `${listId}-heading`;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreToggle = useRef(false);

  useLayoutEffect(() => {
    if (!expanded && restoreToggle.current) {
      restoreToggle.current = false;
      toggleRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [expanded]);

  if (rooms.length === 0) return null;

  const visibleRooms = expanded ? rooms : rooms.slice(0, INITIAL_VISIBLE_ROOMS);
  const remainingCount = Math.max(0, rooms.length - INITIAL_VISIBLE_ROOMS);

  return (
    <div className="chat-room-results" role="group" aria-labelledby={headingId}>
      <h2 className="sr-only" id={headingId}>Gefundene Räume</h2>
      <div className="chat-room-results__list" id={listId}>
        {visibleRooms.map((room, index) => (
          <RoomResult
            key={`${resourceIdentity(room.resource)}-${String(index)}`}
            room={room}
            disabled={disabled}
            onChooseRoom={onChooseRoom}
            onChooseSlot={onChooseSlot}
          />
        ))}
      </div>
      {remainingCount > 0 && (
        <button
          ref={toggleRef}
          className="chat-room-results__toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            restoreToggle.current = expanded;
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "Weniger anzeigen" : `Weitere ${String(remainingCount)} anzeigen`}
          <ChevronDown className={expanded ? "is-expanded" : undefined} size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
