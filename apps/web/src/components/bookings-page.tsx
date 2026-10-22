"use client";

import { ArrowRight, CalendarDays, CircleAlert, Clock3, MapPin, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, formatDateTime, formatTime } from "@/lib/api";
import type { Booking } from "@/lib/types";

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    accepted: "Bestätigt",
    confirmed: "Bestätigt",
    pending: "Ausstehend",
    requested: "Ausstehend",
    cancelled: "Storniert",
    canceled: "Storniert",
    failed: "Fehlgeschlagen",
  };
  return labels[status] ?? status;
}

export function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedBookings = [...bookings].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  const loadBookings = useCallback(async () => {
    setLoading(true);
    setBookings([]);
    setHasLoaded(false);
    setError(null);
    try {
      const result = await apiRequest<{ bookings: Booking[] }>("/api/bookings");
      setBookings(result.bookings);
      setHasLoaded(true);
    } catch (cause) {
      setBookings([]);
      setError(cause instanceof Error ? cause.message : "Buchungen konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<{ bookings: Booking[] }>("/api/bookings")
      .then((result) => {
        if (active) {
          setBookings(result.bookings);
          setHasLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setBookings([]);
          setError(cause instanceof Error ? cause.message : "Buchungen konnten nicht geladen werden.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="bookings-page page-enter">
      <section className="page-intro-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-rule" /> DEIN CAMPUS</div>
          <h1>Meine Buchungen</h1>
          <p>Alles, was du für deinen nächsten Termin brauchst.</p>
        </div>
        <button className="icon-button refresh-button" type="button" aria-label="Buchungen aktualisieren" onClick={() => void loadBookings()} disabled={loading}>
          <RefreshCw size={17} aria-hidden="true" />
        </button>
      </section>

      <div className="bookings-toolbar">
        <div><span className="section-kicker">RESERVIERUNGEN</span><h2>Deine Übersicht</h2></div>
        {hasLoaded && !loading && !error && <span className="result-count">{bookings.length} {bookings.length === 1 ? "Buchung" : "Buchungen"}</span>}
      </div>

      {loading ? (
        <div className="booking-list" aria-label="Buchungen werden geladen" aria-busy="true">
          {[0, 1].map((item) => <div className="booking-skeleton" key={item}><span /><div><i /><i /></div></div>)}
        </div>
      ) : error ? (
        <div className="state-card state-card--error" role="alert">
          <span className="state-icon"><CircleAlert size={20} aria-hidden="true" /></span>
          <div><strong>Buchungen gerade nicht erreichbar</strong><p>{error}</p></div>
          <Link className="button button--secondary" href="/account/connections?returnTo=/bookings">Verbindung prüfen</Link>
          <button className="button button--secondary" type="button" onClick={() => void loadBookings()}>Erneut laden</button>
        </div>
      ) : bookings.length === 0 ? (
        <div className="bookings-empty">
          <div className="empty-calendar" aria-hidden="true">
            <span className="empty-calendar-orbit empty-calendar-orbit--one" />
            <span className="empty-calendar-orbit empty-calendar-orbit--two" />
            <CalendarDays size={26} strokeWidth={1.5} />
          </div>
          <span className="section-kicker">NOCH IST ALLES OFFEN</span>
          <h2>Dein nächster Termin<br />beginnt hier.</h2>
          <p>Wenn du einen Raum reservierst, findest du ihn an dieser Stelle wieder.</p>
          <Link className="button button--primary" href="/">Raum finden <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      ) : (
        <div className="booking-list">
          {sortedBookings.map((booking) => (
            <article className="booking-card" key={booking.id}>
              <div className="booking-date-block">
                <span>{new Intl.DateTimeFormat("de-DE", { month: "short" }).format(new Date(booking.startDate)).replace(".", "")}</span>
                <strong>{new Intl.DateTimeFormat("de-DE", { day: "2-digit" }).format(new Date(booking.startDate))}</strong>
              </div>
              <div className="booking-card-main">
                <div className="booking-card-title-row">
                  <h3>{booking.resourceName}</h3>
                  <span className={`booking-status booking-status--${booking.status}`}>{statusLabel(booking.status)}</span>
                </div>
                <div className="booking-card-details">
                  <span><CalendarDays size={14} aria-hidden="true" />{formatDateTime(booking.startDate)}</span>
                  <span><Clock3 size={14} aria-hidden="true" />{formatTime(booking.startDate)}–{formatTime(booking.endDate)} Uhr</span>
                </div>
              </div>
              <span className="booking-card-mark"><MapPin size={18} aria-hidden="true" /></span>
            </article>
          ))}
        </div>
      )}

      <div className="bookings-help">
        <span className="knowledge-icon"><Sparkles size={16} aria-hidden="true" /></span>
        <span><strong>Gut vorbereitet</strong><small>Halte Buchungszeit und Raumnamen bei Rückfragen bereit.</small></span>
        <span className="help-label">HASI TESTUMGEBUNG</span>
      </div>
    </div>
  );
}
