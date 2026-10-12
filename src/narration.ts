import { useEffect, useMemo, useRef, useState } from "react";
import { commentaryRequest, commentarySignature, type HighlightCommentary, type HighlightReel } from "../shared/highlights.js";
import type { Language } from "../shared/types.js";
import { api } from "./api.js";

const VOICE_LANG: Record<Language, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR", pt: "pt-BR" };
const DUCKED_GAIN = 0.3;

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

export function speak(text: string, language: Language): void {
  if (!speechSupported() || !text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = VOICE_LANG[language];
  const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith(language));
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  synth.speak(utterance);
}

/**
 * Plays neural-voice commentary through Web Audio, so the same lines can be heard, ducked under clip
 * audio and recorded into exported video on a single audio track.
 */
export class CommentaryPlayer {
  private ctx: AudioContext | null = null;
  private voiceBus: GainNode | null = null;
  private mediaBus: GainNode | null = null;
  private record: MediaStreamAudioDestinationNode | null = null;
  private readonly mediaSources = new WeakSet<HTMLMediaElement>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private current: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly listeners = new Set<(speaking: boolean) => void>();

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null;
    this.ctx = new AudioContext();
    this.voiceBus = this.ctx.createGain();
    this.voiceBus.connect(this.ctx.destination);
    this.mediaBus = this.ctx.createGain();
    this.mediaBus.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Call from a click handler so browsers allow audio. */
  resume(): void {
    void this.context()?.resume();
  }

  clear(): void {
    this.stop(0);
    this.buffers.clear();
  }

  async load(entries: Array<{ key: string; url: string }>, signal?: AbortSignal): Promise<void> {
    const ctx = this.context();
    if (!ctx) throw new Error("Web Audio is not available");
    const decoded = await Promise.all(entries.map(async ({ key, url }) => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Commentary audio failed with ${response.status}`);
      return [key, await ctx.decodeAudioData(await response.arrayBuffer())] as const;
    }));
    for (const [key, buffer] of decoded) this.buffers.set(key, buffer);
  }

  has(key: string): boolean {
    return this.buffers.has(key);
  }

  duration(key: string): number | undefined {
    return this.buffers.get(key)?.duration;
  }

  play(key: string): boolean {
    const ctx = this.context();
    const buffer = this.buffers.get(key);
    if (!ctx || !buffer || !this.voiceBus) return false;
    this.stop(0.15);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(this.voiceBus);
    source.onended = () => {
      if (this.current?.source !== source) return;
      this.current = null;
      this.emit(false);
    };
    source.start();
    this.current = { source, gain };
    this.emit(true);
    return true;
  }

  stop(fadeSeconds = 0.15): void {
    if (!this.current || !this.ctx) return;
    const { source, gain } = this.current;
    this.current = null;
    const at = this.ctx.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, at);
    gain.gain.linearRampToValueAtTime(0, at + fadeSeconds);
    try { source.stop(at + fadeSeconds + 0.02); } catch { /* already stopped */ }
    this.emit(false);
  }

  /** Routes a video element's sound through the mixer so it is ducked under commentary and recorded. */
  attachMedia(element: HTMLMediaElement): boolean {
    const ctx = this.context();
    if (!ctx || !this.mediaBus) return false;
    if (this.mediaSources.has(element)) return true;
    try {
      ctx.createMediaElementSource(element).connect(this.mediaBus);
      this.mediaSources.add(element);
      return true;
    } catch {
      return false;
    }
  }

  /** One mixed audio track (commentary + attached media) for MediaRecorder. */
  recordStream(): MediaStream | null {
    const ctx = this.context();
    if (!ctx || !this.voiceBus || !this.mediaBus) return null;
    if (!this.record) {
      this.record = ctx.createMediaStreamDestination();
      this.voiceBus.connect(this.record);
      this.mediaBus.connect(this.record);
    }
    return this.record.stream;
  }

  onSpeaking(listener: (speaking: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stop(0);
    this.listeners.clear();
    void this.ctx?.close();
    this.ctx = null;
  }

  private emit(speaking: boolean): void {
    if (this.ctx && this.mediaBus) {
      const at = this.ctx.currentTime;
      this.mediaBus.gain.cancelScheduledValues(at);
      this.mediaBus.gain.setTargetAtTime(speaking ? DUCKED_GAIN : 1, at, 0.12);
    }
    for (const listener of this.listeners) listener(speaking);
  }
}

export type CommentaryStatus = "idle" | "loading" | "ready" | "fallback";

type CommentaryState = {
  signature: string;
  status: CommentaryStatus;
  commentary: HighlightCommentary | null;
  durations: Map<string, number>;
  error?: string;
};

const NO_DURATIONS = new Map<string, number>();

/**
 * Broadcast commentary for a highlight reel: lines written by the Foundry commentator and voiced with
 * Azure neural voices. Falls back to the browser's speech voice reading captions when unavailable.
 */
export function useHighlightCommentary(reel: HighlightReel, enabled: boolean) {
  const player = useMemo(() => new CommentaryPlayer(), []);
  const request = useMemo(() => commentaryRequest(reel), [reel]);
  const signature = useMemo(() => commentarySignature(request), [request]);
  const [state, setState] = useState<CommentaryState | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const pending = useRef<{ signature: string; promise: Promise<void> } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => player.onSpeaking(setSpeaking), [player]);
  useEffect(() => () => { player.dispose(); stopSpeaking(); }, [player]);

  const current = state?.signature === signature ? state : null;
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const reelRef = useRef(reel);
  reelRef.current = reel;

  /** Latest state for this reel, read through refs so callbacks captured mid-export stay current. */
  function latest(): CommentaryState | null {
    const known = stateRef.current;
    return known?.signature === signatureRef.current ? known : null;
  }

  function prepare(): Promise<void> {
    player.resume();
    if (!enabled || request.clips.length === 0) return Promise.resolve();
    const known = stateRef.current;
    if (known?.signature === signature && (known.status === "ready" || known.status === "fallback")) return Promise.resolve();
    if (pending.current?.signature === signature) return pending.current.promise;
    const promise = (async () => {
      setState({ signature, status: "loading", commentary: null, durations: NO_DURATIONS });
      try {
        const commentary = await api.highlightCommentary(request);
        if (!commentary) throw new Error("No commentary returned");
        const entries = [
          { key: "intro", line: commentary.intro },
          ...commentary.lines.map((line) => ({ key: line.clipId, line })),
          { key: "outro", line: commentary.outro },
        ].flatMap(({ key, line }) => (line.audioUrl ? [{ key, url: line.audioUrl }] : []));
        player.clear();
        let voiced = false;
        if (entries.length > 0) {
          try {
            await player.load(entries);
            voiced = true;
          } catch {
            player.clear();
          }
        }
        const durations = new Map(entries.map(({ key }) => [key, player.duration(key) ?? 0] as const).filter(([, seconds]) => seconds > 0));
        setState({ signature, status: voiced ? "ready" : "fallback", commentary, durations });
      } catch (error: unknown) {
        setState({ signature, status: "fallback", commentary: null, durations: NO_DURATIONS, error: error instanceof Error ? error.message : "Commentary unavailable" });
      } finally {
        pending.current = null;
      }
    })();
    pending.current = { signature, promise };
    return promise;
  }

  function lineText(key: string): string | undefined {
    const commentary = latest()?.commentary;
    if (!commentary) return undefined;
    if (key === "intro") return commentary.intro.text;
    if (key === "outro") return commentary.outro.text;
    return commentary.lines.find((line) => line.clipId === key)?.text;
  }

  /** Speaks the line for a cue ("intro", "outro" or a clip id). */
  function cue(key: string): void {
    if (!enabled) return;
    if (latest()?.status === "ready" && player.play(key)) {
      stopSpeaking();
      return;
    }
    const activeReel = reelRef.current;
    const clip = activeReel.clips.find((item) => item.id === key);
    const written = lineText(key);
    const text = written ?? clip?.caption;
    if (text) speak(text, written ? activeReel.language : clip?.captionLanguage ?? activeReel.language);
  }

  function stop(): void {
    player.stop();
    stopSpeaking();
  }

  return {
    player,
    status: current?.status ?? "idle",
    commentary: current?.commentary ?? null,
    error: current?.error,
    /** Voice lengths in seconds, used to pace the data reel so lines are never cut off. */
    durations: current?.status === "ready" ? current.durations : NO_DURATIONS,
    speaking,
    prepare,
    cue,
    stop,
    lineText,
  };
}

export type HighlightCommentaryControls = ReturnType<typeof useHighlightCommentary>;
