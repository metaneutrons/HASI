import type { ChatRoomOption, ChatWorkspace } from "./chat-sessions";

export const LIVE_AVAILABILITY_MS = 30_000;

interface Lease {
  readonly option: ChatRoomOption;
  readonly capturedAt: number;
}

function key(sessionId: string, messageId: string, resourceId: string) {
  return JSON.stringify([sessionId, messageId, resourceId]);
}

/** Display-only, account/store-local leases. Never serialize these as authority. */
export class LiveRoomAvailability {
  private readonly leases = new Map<string, Lease>();

  capture(workspace: ChatWorkspace, now: number) {
    const present = new Set<string>();
    for (const session of workspace.sessions) for (const message of session.snapshot.messages) {
      if (message.role !== "assistant") continue;
      for (const option of message.rooms ?? []) {
        const id = key(session.id, message.id, option.resource.id);
        present.add(id);
        // A repeated snapshot, draft edit or save acknowledgement cannot renew
        // an observation. A fresh search creates a new message identity.
        if (option.checked && !this.leases.has(id)) {
          this.leases.set(id, { option: structuredClone(option), capturedAt: now });
        }
      }
    }
    for (const id of this.leases.keys()) if (!present.has(id)) this.leases.delete(id);
  }

  /** Intersect only an own-save response with its current authorized resources.
   * The server's metadata, model history, sources, proposals and text win.
   * GET/reload/conflict responses must never pass through this overlay.
   */
  apply(remote: ChatWorkspace, now: number): ChatWorkspace {
    return {
      ...remote,
      sessions: remote.sessions.map(session => ({
        ...session,
        snapshot: {
          ...session.snapshot,
          messages: session.snapshot.messages.map(message => {
            if (message.role !== "assistant" || !message.rooms) return message;
            const rooms = message.rooms.map(option => {
              const lease = this.leases.get(key(session.id, message.id, option.resource.id));
              if (!lease || now < lease.capturedAt || now - lease.capturedAt >= LIVE_AVAILABILITY_MS
                || JSON.stringify(lease.option.resource) !== JSON.stringify(option.resource)
                || lease.option.requestedStartDate !== option.requestedStartDate
                || lease.option.requestedEndDate !== option.requestedEndDate) return option;
              return { ...option, checked: true, intervals: structuredClone(lease.option.intervals) };
            });
            const restored = rooms.some((room, index) => room !== message.rooms?.[index]);
            return restored ? { ...message, rooms, tool: "anny · Verfügbarkeit",
              text: "Gerade geprüfte Verfügbarkeit. Vor der Buchung wird erneut geprüft." } : message;
          }),
        },
      })),
    };
  }

  /** Expire only transient room fields; never reconstruct other protected data. */
  expire(workspace: ChatWorkspace, now: number, busy: Readonly<Record<string, boolean>> = {}): ChatWorkspace {
    const sessions = workspace.sessions.map(session => {
      if (busy[session.id]) return session;
      const messages = session.snapshot.messages.map(message => {
        if (message.role !== "assistant" || !message.rooms) return message;
        const rooms = message.rooms.map(option => {
          const lease = this.leases.get(key(session.id, message.id, option.resource.id));
          if (!option.checked || !lease || (now >= lease.capturedAt && now - lease.capturedAt < LIVE_AVAILABILITY_MS)) return option;
          return { ...option, checked: false, intervals: [] };
        });
        const expired = rooms.some((room, index) => room !== message.rooms?.[index]);
        if (!expired) return message;
        return { ...message, rooms, tool: "anny · Frühere Suchergebnisse",
          text: "Die Verfügbarkeitsanzeige ist abgelaufen. Prüfe die Verfügbarkeit erneut." };
      });
      return messages.some((message, index) => message !== session.snapshot.messages[index])
        ? { ...session, snapshot: { ...session.snapshot, messages } } : session;
    });
    return sessions.some((session, index) => session !== workspace.sessions[index]) ? { ...workspace, sessions } : workspace;
  }

  nextExpiry(now: number): number | undefined {
    const future = [...this.leases.values()].map(lease => lease.capturedAt + LIVE_AVAILABILITY_MS).filter(at => at > now);
    return future.length ? Math.min(...future) : undefined;
  }

  clear() { this.leases.clear(); }
}
