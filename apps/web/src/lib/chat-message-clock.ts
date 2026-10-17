import { timestampResponseSchema, type MessageTimestamp, type WireMessage } from "./chat-contract";

/** Only newly created events are registered; historical messages stay unknown. */
export function createChatMessageClock(request: (messages: WireMessage[]) => Promise<unknown>) {
  const pending = new Map<string, WireMessage>();
  return {
    track<T extends WireMessage>(message: T): T {
      message.id ??= crypto.randomUUID();
      // A coalesced history entry may have acquired a new event ID.
      for (const [key, event] of pending) if (event === message && key !== message.id) pending.delete(key);
      if (!message.timestamp) pending.set(message.id, message);
      return message;
    },
    async flush(): Promise<Map<string, MessageTimestamp>> {
      const timestamps = new Map<string, MessageTimestamp>();
      const events = [...pending.values()];
      pending.clear();
      for (let offset = 0; offset < events.length;) {
        const batch: WireMessage[] = [];
        let bytes = 20;
        while (offset < events.length && batch.length < 16) {
          const event = events[offset]!;
          const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
          if (batch.length && bytes + size > 50_000) break;
          batch.push(event);
          bytes += size;
          offset++;
        }
        const response = timestampResponseSchema.parse(await request(batch));
        const byId = new Map(response.timestamps.map(event => [event.id, event.timestamp]));
        if (response.timestamps.length !== batch.length || byId.size !== batch.length || batch.some(event => !byId.has(event.id!))) throw new Error("Die Serverzeiten passen nicht zu den Nachrichten.");
        for (const event of batch) {
          event.timestamp = byId.get(event.id!)!;
          timestamps.set(event.id!, event.timestamp);
        }
      }
      return timestamps;
    },
  };
}
