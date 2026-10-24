import { useEffect, useRef, useState } from "react";
import type { Language, MatchPeriod, Persona } from "../../shared/types.js";
import type { LiveMessage } from "../../shared/platform.js";
import { STUDIO_TOKEN_EVENT, fetchStudioStreamTicket, getStudioToken } from "../api.js";
import { isLiveMessage } from "../liveMessage.js";

export type LiveStreamState = {
  phase: "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";
  reconnectAttempt: number;
  lastEventAt?: string;
  error?: string;
};

type LiveStreamOptions = {
  enabled: boolean;
  role: "fan" | "studio";
  persona: Persona;
  language: Language;
  favoritePlayerId?: string;
  /** "home" | "away" or a synthetic archive club ID. */
  favoriteClubId?: string;
  /** Scope of snapshot stats and stories; omitted or "full" keeps the whole match. */
  period?: MatchPeriod;
  onMessage: (message: LiveMessage) => void;
};

export function useLiveStream({ enabled, role, persona, language, favoritePlayerId, favoriteClubId, period, onMessage }: LiveStreamOptions): LiveStreamState {
  const [state, setState] = useState<LiveStreamState>({ phase: enabled ? "connecting" : "idle", reconnectAttempt: 0 });
  const [tokenVersion, setTokenVersion] = useState(0);
  const handlerRef = useRef(onMessage);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);

  handlerRef.current = onMessage;

  useEffect(() => {
    if (role !== "studio") return;
    const onToken = () => setTokenVersion((value) => value + 1);
    window.addEventListener(STUDIO_TOKEN_EVENT, onToken);
    return () => window.removeEventListener(STUDIO_TOKEN_EVENT, onToken);
  }, [role]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
      setState({ phase: "idle", reconnectAttempt: 0 });
      return;
    }

    let cancelled = false;
    let attempt = 0;
    const abort = new AbortController();

    const open = async () => {
      if (cancelled) return;
      const params = new URLSearchParams({ role, persona, language });
      if (favoritePlayerId) params.set("favoritePlayerId", favoritePlayerId);
      if (favoriteClubId) params.set("favoriteClubId", favoriteClubId);
      if (period && period !== "full") params.set("period", period);
      setState((current) => ({
        phase: attempt === 0 ? "connecting" : "reconnecting",
        reconnectAttempt: attempt,
        lastEventAt: current.lastEventAt,
        error: current.error
      }));

      if (role === "studio") {
        try {
          const ticket = await fetchStudioStreamTicket(abort.signal);
          if (cancelled) return;
          // Refuse to put the long-lived producer token on the EventSource URL.
          if (ticket && ticket !== getStudioToken()) params.set("ticket", ticket);
        } catch (error) {
          if (cancelled) return;
          attempt += 1;
          const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
          const message = error instanceof Error ? error.message : "Could not open the studio stream.";
          setState((current) => ({
            phase: "reconnecting",
            reconnectAttempt: attempt,
            lastEventAt: current.lastEventAt,
            error: message
          }));
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            void open();
          }, delay);
          return;
        }
      }

      if (cancelled) return;
      const source = new EventSource(`/api/live/stream?${params.toString()}`);
      sourceRef.current = source;

      source.onopen = () => {
        if (cancelled) {
          source.close();
          return;
        }
        attempt = 0;
        setState((current) => ({ phase: "open", reconnectAttempt: 0, lastEventAt: current.lastEventAt }));
      };

      source.onmessage = (event) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(event.data) as unknown;
          if (!isLiveMessage(payload)) throw new Error("Live stream payload failed validation.");
          setState((current) => ({ phase: "open", reconnectAttempt: current.reconnectAttempt, lastEventAt: new Date().toISOString() }));
          handlerRef.current(payload);
        } catch (error) {
          setState((current) => ({ ...current, phase: "error", error: error instanceof Error ? error.message : "Live stream parse error." }));
        }
      };

      source.onerror = () => {
        source.close();
        if (cancelled) return;
        attempt += 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        setState((current) => ({
          phase: "reconnecting",
          reconnectAttempt: attempt,
          lastEventAt: current.lastEventAt,
          error: current.error ?? "Live stream disconnected. Reconnecting…"
        }));
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          void open();
        }, delay);
      };
    };

    void open();

    return () => {
      cancelled = true;
      abort.abort();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
      setState((current) => ({ ...current, phase: "closed" }));
    };
  }, [enabled, favoriteClubId, favoritePlayerId, language, period, persona, role, tokenVersion]);

  return state;
}
