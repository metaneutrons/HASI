"use client";

import {
  ArrowDownRight,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  MapPin,
  Search,
  Sparkles,
  Users,
  Wifi,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiRequest, formatDateTime, formatTime, postJson, toOffsetIso } from "@/lib/api";
import type { Resource, TimeInterval, User } from "@/lib/types";
import { useSession } from "@/components/session-provider";

type ResourceResult = { resources: Resource[] };
type AvailabilityResult = { intervals: TimeInterval[] };
type Proposal = {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "confirmed" | "outcome_unknown" | "failed";
  expiresAt: string;
};
type ProposalResult = { proposal: Proposal };
type ConfirmationResult = { proposal: Proposal; bookingId?: string };

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "Guten Morgen";
  if (hour < 18) return "Guten Tag";
  return "Guten Abend";
}

function firstName(user: User | null) {
  return user?.displayName.trim().split(/\s+/)[0] ?? "";
}

function defaultDateAndTime() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function ResourceIcon({ feature }: { feature: string }) {
  const normalized = feature.toLocaleLowerCase("de-DE");
  if (normalized.includes("wifi") || normalized.includes("wlan")) return <Wifi size={14} aria-hidden="true" />;
  if (normalized.includes("kapaz") || normalized.includes("plätze") || normalized.includes("sitz")) return <Users size={14} aria-hidden="true" />;
  return <Check size={14} aria-hidden="true" />;
}

function ResourceCard({
  resource,
  selected,
  onSelect,
}: {
  resource: Resource;
  selected: boolean;
  onSelect: (resource: Resource) => void;
}) {
  const shortLocation = resource.location.split(",")[0] ?? resource.location;
  return (
    <button
      type="button"
      className={`resource-card${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(resource)}
    >
      <span className="resource-card-art" aria-hidden="true">
        <span className="resource-art-disc resource-art-disc--one" />
        <span className="resource-art-disc resource-art-disc--two" />
        <span className="resource-art-line resource-art-line--one" />
        <span className="resource-art-line resource-art-line--two" />
        <span className="resource-art-number">{String(resource.capacity).padStart(2, "0")}</span>
        <span className="resource-art-caption">PLÄTZE</span>
        <span className="resource-art-arrow"><ArrowDownRight size={16} /></span>
      </span>
      <span className="resource-card-content">
        <span className="resource-card-location"><MapPin size={13} aria-hidden="true" /> {shortLocation}</span>
        <span className="resource-card-title">{resource.name}</span>
        <span className="resource-card-description">{resource.description}</span>
        <span className="resource-card-bottom">
          <span className="resource-people"><Users size={14} aria-hidden="true" /> Bis {resource.capacity} Personen</span>
          <ChevronRight className="resource-chevron" size={17} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

function SelectionPanel({ onClear, children }: { onClear: () => void; children: import("react").ReactNode }) {
  return (
    <section className="selection-panel" id="selection-panel" tabIndex={-1}>
      <div className="selection-panel-heading">
        <div>
          <span className="section-kicker">DEIN NÄCHSTER SCHRITT</span>
          <h2>Raum planen</h2>
        </div>
        <button className="icon-button selection-close" type="button" onClick={onClear} aria-label="Auswahl schließen">
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      {children}
    </section>
  );
}

function AvailabilityForm({
  resource,
}: {
  resource: Resource;
}) {
  const initial = useMemo(() => defaultDateAndTime(), []);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [duration, setDuration] = useState(60);
  const [intervals, setIntervals] = useState<TimeInterval[]>([]);
  const [selectedInterval, setSelectedInterval] = useState<TimeInterval | null>(null);
  const [checking, setChecking] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function checkAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    setProposal(null);
    setConfirmation(null);
    setProposalError(null);
    setConfirmError(null);
    try {
      const startDate = toOffsetIso(`${date}T${time}`);
      const result = await postJson<AvailabilityResult>("/api/availability", {
        resourceId: resource.id,
        serviceId: resource.serviceId,
        startDate,
        durationMinutes: duration,
      });
      const available = result.intervals.filter((interval) => interval.available);
      setIntervals(result.intervals);
      setSelectedInterval(available[0] ?? null);
      if (result.intervals.length === 0) setError("Für diesen Zeitraum wurden keine freien Zeiten zurückgegeben.");
    } catch (cause) {
      setIntervals([]);
      setSelectedInterval(null);
      const message = cause instanceof Error ? cause.message : "Die Verfügbarkeit konnte nicht geladen werden.";
      setError(message);
    } finally {
      setChecking(false);
    }
  }

  async function createProposal() {
    if (!selectedInterval) return;
    setProposing(true);
    setProposalError(null);
    setConfirmation(null);
    try {
      const result = await postJson<ProposalResult>("/api/proposals", {
        resourceId: resource.id,
        serviceId: resource.serviceId,
        startDate: selectedInterval.startDate,
        endDate: selectedInterval.endDate,
      });
      setProposal(result.proposal);
    } catch (cause) {
      setProposalError(cause instanceof Error ? cause.message : "Der Reservierungsvorschlag konnte nicht erstellt werden.");
    } finally {
      setProposing(false);
    }
  }

  async function confirmProposal() {
    if (!proposal) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const result = await postJson<ConfirmationResult>(`/api/proposals/${encodeURIComponent(proposal.id)}/confirm`, {});
      setConfirmation(result);
      if (result.proposal.status === "confirmed") setProposal(null);
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "Die Bestätigung konnte nicht abgeschlossen werden.");
    } finally {
      setConfirming(false);
    }
  }

  const availableIntervals = intervals.filter((interval) => interval.available);
  const proposalState = confirmation?.proposal.status;

  return (
    <div className="booking-flow">
      <div className="selected-resource-summary">
        <span className="selected-resource-icon"><CalendarDays size={18} aria-hidden="true" /></span>
        <span className="selected-resource-copy">
          <strong>{resource.name}</strong>
          <span><MapPin size={13} aria-hidden="true" /> {resource.location}</span>
        </span>
      </div>

      <form className="availability-form" onSubmit={(event) => void checkAvailability(event)}>
        <div className="form-field-grid">
          <label className="form-field">
            <span>Datum</span>
            <input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setDate(event.currentTarget.value)} required />
          </label>
          <label className="form-field">
            <span>Startzeit</span>
            <input type="time" value={time} onChange={(event) => setTime(event.currentTarget.value)} required />
          </label>
        </div>
        <label className="form-field form-field--duration">
          <span>Dauer</span>
          <span className="select-wrap">
            <select value={duration} onChange={(event) => setDuration(Number(event.currentTarget.value))}>
              <option value={30}>30 Minuten</option>
              <option value={60}>1 Stunde</option>
              <option value={90}>1,5 Stunden</option>
              <option value={120}>2 Stunden</option>
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        <button className="button button--secondary button--wide" type="submit" disabled={checking || !date || !time}>
          {checking ? <><span className="spinner" /> Zeiten werden geprüft</> : <>Verfügbarkeit prüfen <ArrowRight size={16} aria-hidden="true" /></>}
        </button>
      </form>

      {error && <div className="inline-alert inline-alert--soft" role="status"><CircleAlert size={17} aria-hidden="true" />{error}</div>}

      {intervals.length > 0 && (
        <div className="availability-results" aria-live="polite">
          <div className="availability-title-row">
            <div>
              <span className="section-kicker">VERFÜGBARE ZEITEN</span>
              <h3>{availableIntervals.length ? "Das passt gut." : "Keine Zeit frei"}</h3>
            </div>
            <span className="availability-count">{availableIntervals.length} frei</span>
          </div>
          <div className="availability-source"><span className="status-dot" /> Verfügbarkeit aus der Testumgebung</div>
          {availableIntervals.length > 0 ? (
            <div className="time-slot-list">
              {availableIntervals.map((interval) => {
                const selected = selectedInterval?.startDate === interval.startDate;
                return (
                  <button
                    key={interval.startDate}
                    type="button"
                    className={`time-slot${selected ? " is-selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => {
                      setSelectedInterval(interval);
                      setProposal(null);
                      setConfirmation(null);
                    }}
                  >
                    <span className="time-slot-time"><Clock3 size={15} aria-hidden="true" />{formatTime(interval.startDate)}–{formatTime(interval.endDate)}</span>
                    {selected && <Check size={16} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="small-copy">Wähle ein anderes Datum oder eine andere Dauer.</p>
          )}
          {selectedInterval && !proposal && !confirmation && (
            <button className="button button--primary button--wide" type="button" onClick={() => void createProposal()} disabled={proposing}>
              {proposing ? <><span className="spinner spinner--light" /> Vorschlag wird erstellt</> : <>Buchung vorbereiten <ArrowRight size={16} aria-hidden="true" /></>}
            </button>
          )}
        </div>
      )}

      {proposalError && <div className="inline-alert" role="alert"><CircleAlert size={17} aria-hidden="true" />{proposalError}</div>}

      {proposal && !confirmation && (
        <div className="proposal-card">
          <div className="proposal-heading"><span className="proposal-check"><Check size={15} aria-hidden="true" /></span><strong>Buchungsvorschlag</strong></div>
          <p>{formatDateTime(proposal.startDate)} · {formatTime(proposal.endDate)} Uhr</p>
          <p className="proposal-expiry">Der Buchungsvorschlag läuft am {formatDateTime(proposal.expiresAt)} ab.</p>
          <button className="button button--primary button--wide" type="button" onClick={() => void confirmProposal()} disabled={confirming}>
            {confirming ? <><span className="spinner spinner--light" /> Bestätigung läuft</> : <>Verbindlich bestätigen <Check size={16} aria-hidden="true" /></>}
          </button>
        </div>
      )}

      {confirmation && proposalState === "confirmed" && (
        <div className="success-card" role="status">
          <span className="success-icon"><Check size={18} aria-hidden="true" /></span>
          <div><strong>Der Raum ist reserviert.</strong><p>{formatDateTime(confirmation.proposal.startDate)} · {formatTime(confirmation.proposal.endDate)} Uhr</p></div>
          <Link href="/bookings" className="success-link">Buchung ansehen <ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
      )}

      {confirmation && (proposalState === "outcome_unknown" || proposalState === "failed") && (
        <div className={`inline-alert ${proposalState === "outcome_unknown" ? "inline-alert--soft" : ""}`} role="status">
          <CircleAlert size={17} aria-hidden="true" />
          {proposalState === "outcome_unknown"
            ? "Der externe Buchungsdienst hat nicht eindeutig geantwortet. Prüfe deine Buchungen, bevor du erneut reservierst."
            : "Der Buchungsdienst konnte den Raum nicht bestätigen. Wähle einen anderen Zeitraum."}
        </div>
      )}

      {confirmError && <div className="inline-alert" role="alert"><CircleAlert size={17} aria-hidden="true" />{confirmError}</div>}
    </div>
  );
}

export function AssistantPage() {
  const { user } = useSession();
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeFeature, setActiveFeature] = useState<string | null>(null);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [searchSummary, setSearchSummary] = useState<string | null>(null);

  const loadResources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<ResourceResult>("/api/resources");
      setResources(result.resources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Räume konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<ResourceResult>("/api/resources")
      .then((result) => {
        if (active) setResources(result.resources);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Räume konnten nicht geladen werden.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected || !window.matchMedia("(max-width: 760px)").matches) return;
    const panel = document.getElementById("selection-panel");
    if (!panel) return;

    panel.focus({ preventScroll: true });
    panel.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }, [selected]);

  const features = useMemo(
    () => Array.from(new Set(resources.flatMap((resource) => resource.features))).slice(0, 5),
    [resources],
  );
  const filteredResources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("de-DE");
    return resources.filter((resource) => {
      const matchesQuery = !needle || [resource.name, resource.description, resource.location, ...resource.features]
        .join(" ")
        .toLocaleLowerCase("de-DE")
        .includes(needle);
      const matchesFeature = !activeFeature || resource.features.includes(activeFeature);
      return matchesQuery && matchesFeature;
    });
  }, [resources, query, activeFeature]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedQuery = query.trim();
    setSearchSummary(normalizedQuery ? `Ich habe ${filteredResources.length} ${filteredResources.length === 1 ? "Raum" : "Räume"} für „${normalizedQuery}“ gefunden.` : `Ich zeige dir ${filteredResources.length} verfügbare ${filteredResources.length === 1 ? "Möglichkeit" : "Möglichkeiten"}.`);
  }

  function clearSelection() {
    setSelected(null);
  }

  return (
    <div className="assistant-page page-enter">
      <section className="assistant-hero">
        <div className="assistant-hero-copy">
          <div className="eyebrow"><span className="eyebrow-rule" /> DEIN CAMPUSASSISTENT</div>
          <h1>Was steht heute<br /><span>an?</span></h1>
          <p>{getGreeting()}{firstName(user) ? `, ${firstName(user)}` : ""}. Wobei kann ich dich unterstützen?</p>
        </div>
        <div className="assistant-hero-aside">
          <span className="hero-date-label">HEUTE</span>
          <time dateTime={new Date().toISOString()}>{new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</time>
          <span className="hero-aside-line" />
          <span className="hero-aside-note"><Sparkles size={15} aria-hidden="true" /> Raumplanung ist verfügbar</span>
        </div>
      </section>

      <section className="search-section" aria-label="Räume suchen">
        <form className="resource-search" onSubmit={submitSearch}>
          <Search size={20} strokeWidth={1.8} aria-hidden="true" />
          <label className="sr-only" htmlFor="resource-query">Raum, Gebäude oder Ausstattung suchen</label>
          <input
            id="resource-query"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSearchSummary(null);
            }}
            placeholder="Raum, Gebäude oder Ausstattung suchen"
            autoComplete="off"
          />
          {query && <button className="search-clear" type="button" aria-label="Suche leeren" onClick={() => setQuery("")}><X size={16} /></button>}
          <button className="search-submit" type="submit" aria-label="Suchen"><ArrowRight size={19} aria-hidden="true" /></button>
        </form>

        <div className="search-lower-row">
          <div className="feature-filters" aria-label="Ausstattung filtern">
            <button className={`filter-chip${activeFeature === null ? " is-active" : ""}`} type="button" aria-pressed={activeFeature === null} onClick={() => setActiveFeature(null)}>Alle Räume</button>
              {features.map((feature) => (
              <button className={`filter-chip${activeFeature === feature ? " is-active" : ""}`} type="button" key={feature} aria-pressed={activeFeature === feature} onClick={() => setActiveFeature(activeFeature === feature ? null : feature)}>
                  <ResourceIcon feature={feature} />{feature}
              </button>
            ))}
          </div>
          <span className="prototype-note"><span className="status-dot" /> {process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO === "1" ? "Browser-Demo" : "Lokaler Prototyp"}</span>
        </div>
      </section>

      {searchSummary && (
        <div className="assistant-response" role="status" aria-live="polite">
          <span className="response-mark"><Sparkles size={16} aria-hidden="true" /></span>
          <p>{searchSummary}</p>
          <button className="icon-button response-dismiss" type="button" aria-label="Hinweis schließen" onClick={() => setSearchSummary(null)}><X size={16} /></button>
        </div>
      )}

      <div className="assistant-grid">
        <section className="resource-results" aria-labelledby="resources-heading">
          <div className="section-heading-row">
            <div>
              <span className="section-kicker">RÄUME & ARBEITSPLÄTZE</span>
              <h2 id="resources-heading">Was passt zu deinem Tag?</h2>
            </div>
            <span className="result-count">{loading ? "…" : `${filteredResources.length} ${filteredResources.length === 1 ? "Ergebnis" : "Ergebnisse"}`}</span>
          </div>

          {loading ? (
            <div className="resource-list" aria-label="Räume werden geladen" aria-busy="true">
              {[0, 1, 2].map((item) => <div className="resource-skeleton" key={item}><span /><div><i /><i /><i /></div></div>)}
            </div>
          ) : error ? (
            <div className="state-card state-card--error" role="alert">
              <span className="state-icon"><CircleAlert size={20} aria-hidden="true" /></span>
              <div><strong>Räume gerade nicht erreichbar</strong><p>{error}</p></div>
              <button className="button button--secondary" type="button" onClick={() => void loadResources()}>Erneut laden</button>
            </div>
          ) : resources.length === 0 ? (
            <div className="state-card state-card--empty">
              <span className="state-icon"><Search size={20} aria-hidden="true" /></span>
              <div><strong>Im Moment sind keine Räume hinterlegt.</strong><p>Schau später noch einmal vorbei.</p></div>
            </div>
          ) : filteredResources.length === 0 ? (
            <div className="state-card state-card--empty">
              <span className="state-icon"><Search size={20} aria-hidden="true" /></span>
              <div><strong>Keine passenden Räume gefunden.</strong><p>Ändere deine Suche oder setze den Ausstattungsfilter zurück.</p></div>
              <button className="button button--secondary" type="button" onClick={() => { setQuery(""); setActiveFeature(null); setSearchSummary(null); }}>Filter zurücksetzen</button>
            </div>
          ) : (
            <div className="resource-list">
              {filteredResources.map((resource) => (
                <ResourceCard key={resource.id} resource={resource} selected={selected?.id === resource.id} onSelect={setSelected} />
              ))}
            </div>
          )}

          <div className="knowledge-note">
            <span className="knowledge-icon"><Sparkles size={16} aria-hidden="true" /></span>
            <span><strong>Campuswissen</strong><small>Der Wissensassistent ist im MVP vorgesehen, in diesem Prototyp aber noch nicht angebunden.</small></span>
            <span className="coming-soon">Demnächst</span>
          </div>
        </section>

        <aside className={`booking-aside${selected ? " booking-aside--selected" : " booking-aside--empty"}`} aria-label="Raumreservierung">
          {selected ? (
            <SelectionPanel onClear={clearSelection}>
              <AvailabilityForm
                key={selected.id}
                resource={selected}
              />
            </SelectionPanel>
          ) : (
            <div className="selection-empty">
              <div className="selection-empty-art" aria-hidden="true">
                <span className="selection-orbit selection-orbit--one" />
                <span className="selection-orbit selection-orbit--two" />
                <span className="selection-empty-symbol"><CalendarDays size={24} strokeWidth={1.6} /></span>
                <span className="selection-star selection-star--one" />
                <span className="selection-star selection-star--two" />
              </div>
              <span className="section-kicker">GUT ZU WISSEN</span>
              <h2>Ein Platz, der<br />zu dir passt.</h2>
              <p>Wähle einen Raum aus der Liste, um freie Zeiten zu prüfen und direkt zu reservieren.</p>
              <span className="selection-empty-foot"><span className="status-dot" /> Verfügbarkeit aus der Testumgebung</span>
            </div>
          )}
        </aside>
      </div>

      <footer className="app-footer">
        <span>HASI <span className="footer-dot">·</span> Hochschulassistent</span>
        <span>Testumgebung der Hochschule Hannover</span>
      </footer>
    </div>
  );
}
