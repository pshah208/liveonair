/** Concurrent clients allowed on one SSE endpoint. Override with a positive integer env value. */
export const DEFAULT_STREAM_CAP = 200;

export function streamCap(override: number | undefined, envValue: string | undefined): number {
  const chosen = override ?? parseCap(envValue);
  if (chosen !== undefined && Number.isInteger(chosen) && chosen > 0) return chosen;
  return DEFAULT_STREAM_CAP;
}

function parseCap(envValue: string | undefined): number | undefined {
  if (envValue === undefined || envValue.trim() === "") return undefined;
  const parsed = Number(envValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type SseGate = {
  readonly blocked: boolean;
  write(chunk: string): boolean;
  drain(): void;
};

/**
 * Skips writes while the socket is backed up and flushes only the latest skipped chunk on drain.
 * The chunk that filled the buffer is left with the socket; it is not written again.
 */
export function createSseGate(write: (chunk: string) => boolean): SseGate {
  let blocked = false;
  let pending: string | null = null;
  const gate: SseGate = {
    get blocked() {
      return blocked;
    },
    write(chunk: string) {
      if (blocked) {
        pending = chunk;
        return false;
      }
      const ok = write(chunk);
      blocked = !ok;
      return ok;
    },
    drain() {
      blocked = false;
      if (pending === null) return;
      const chunk = pending;
      pending = null;
      gate.write(chunk);
    },
  };
  return gate;
}
