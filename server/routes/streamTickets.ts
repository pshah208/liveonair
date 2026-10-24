import { randomBytes } from "node:crypto";

/** One-time browser credential for the studio EventSource. Never the long-lived studio token. */
export const STREAM_TICKET_BYTES = 32;
export const STREAM_TICKET_TTL_MS = 60_000;
export const STREAM_TICKET_TTL_SECONDS = STREAM_TICKET_TTL_MS / 1000;
export const STREAM_TICKET_MAX_ENTRIES = 1000;

/** 32 bytes of base64url, without padding. */
const STREAM_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type StreamTicketClock = () => number;

export type IssuedStreamTicket = {
  ticket: string;
  expiresInSeconds: number;
};

export type StreamTicketStore = {
  issue(): IssuedStreamTicket;
  /** True only for a known, unexpired, unused ticket. Consumes it either way. */
  consume(ticket: string): boolean;
};

type StreamTicketEntry = {
  expiresAt: number;
};

type CreateStreamTicketStoreOptions = {
  now?: StreamTicketClock;
  ttlMs?: number;
  maxEntries?: number;
  randomBytes?: (size: number) => Buffer;
};

export function isStreamTicket(value: unknown): value is string {
  return typeof value === "string" && STREAM_TICKET_PATTERN.test(value);
}

/**
 * In-memory one-time tickets. A ticket opens a studio stream once, then it is gone.
 * Expired entries are pruned on issue and consume. The map stays at or below maxEntries
 * by dropping the oldest issued ticket after that prune.
 */
export function createStreamTicketStore(options: CreateStreamTicketStoreOptions = {}): StreamTicketStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? STREAM_TICKET_TTL_MS;
  const maxEntries = options.maxEntries ?? STREAM_TICKET_MAX_ENTRIES;
  const bytes = options.randomBytes ?? randomBytes;
  const tickets = new Map<string, StreamTicketEntry>();

  const prune = (at: number) => {
    for (const [key, entry] of tickets) {
      if (entry.expiresAt <= at) tickets.delete(key);
    }
  };

  const evictOldest = () => {
    while (tickets.size >= maxEntries) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) return;
      tickets.delete(oldest);
    }
  };

  const nextTicket = (): string => {
    let ticket = bytes(STREAM_TICKET_BYTES).toString("base64url");
    let guard = 0;
    while (tickets.has(ticket) && guard < 5) {
      ticket = bytes(STREAM_TICKET_BYTES).toString("base64url");
      guard += 1;
    }
    return ticket;
  };

  return {
    issue() {
      const at = now();
      prune(at);
      evictOldest();
      const ticket = nextTicket();
      tickets.set(ticket, { expiresAt: at + ttlMs });
      return { ticket, expiresInSeconds: Math.round(ttlMs / 1000) };
    },
    consume(ticket) {
      const at = now();
      prune(at);
      const entry = tickets.get(ticket);
      if (!entry) return false;
      tickets.delete(ticket);
      return entry.expiresAt > at;
    },
  };
}
