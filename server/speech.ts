import { createHash } from "node:crypto";

import type { TokenCredential } from "@azure/identity";

import type { CommentaryMood } from "../shared/highlights.js";
import type { Language } from "../shared/types.js";
import { getAzureCredential } from "./azure/credential.js";
import { HttpError } from "./validation.js";

/**
 * Azure AI Speech neural text-to-speech on the same Foundry (AIServices) account as the narrator,
 * authenticated with Entra ID. Only text the server generated itself is registered for synthesis,
 * so the audio endpoint can never be used as an open TTS proxy.
 */

const DEFAULT_VOICES: Record<Language, string> = {
  en: "en-GB-Ollie:DragonHDLatestNeural",
  es: "es-ES-Tristan:DragonHDLatestNeural",
  fr: "fr-FR-Remy:DragonHDLatestNeural",
  pt: "pt-BR-Macerio:DragonHDLatestNeural",
};
const FALLBACK_VOICES: Record<Language, string> = {
  en: "en-GB-RyanNeural",
  es: "es-ES-AlvaroNeural",
  fr: "fr-FR-HenriNeural",
  pt: "pt-BR-AntonioNeural",
};
const LOCALES: Record<Language, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR", pt: "pt-BR" };
const RATE: Record<CommentaryMood, string> = { calm: "0%", build: "+4%", tense: "+6%", excited: "+10%" };
const OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";
const MAX_TEXT = 5_000;
const MAX_REGISTERED = 600;
const MAX_CACHED_AUDIO = 160;
const MAX_CONCURRENT = 8;
const TIMEOUT_MS = 20_000;

type Entry = { text: string; language: Language; mood: CommentaryMood };

export interface SpeechService {
  readonly configured: boolean;
  /** Registers server-generated text and returns its audio URL, or undefined when speech is unavailable. */
  register(text: string, language: Language, mood?: CommentaryMood): string | undefined;
  synthesize(id: string): Promise<Buffer>;
  /** Starts synthesis in the background so the audio is ready when the browser asks for it. */
  warm?(audioUrl: string): void;
}

export type SpeechOptions = {
  endpoint?: string;
  voices?: Partial<Record<Language, string>>;
  credential?: TokenCredential;
  fetchImpl?: typeof fetch;
};

export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function buildSsml(entry: Entry, voice: string): string {
  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${LOCALES[entry.language]}">`,
    `<voice name="${escapeXml(voice)}">`,
    `<prosody rate="${RATE[entry.mood]}">${escapeXml(entry.text)}</prosody>`,
    "</voice></speak>",
  ].join("");
}

/** The Speech data plane lives on the account's cognitiveservices custom domain. */
export function resolveSpeechEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.AZURE_SPEECH_ENDPOINT?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const openAi = env.AZURE_OPENAI_ENDPOINT?.trim();
  if (!openAi) return undefined;
  try {
    const url = new URL(openAi);
    const match = /^([a-z0-9-]+)\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/iu.exec(url.hostname);
    return match ? `https://${match[1]}.cognitiveservices.azure.com` : undefined;
  } catch {
    return undefined;
  }
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function createSpeechService(options: SpeechOptions = {}): SpeechService {
  const endpoint = options.endpoint ?? resolveSpeechEndpoint();
  const fetchImpl = options.fetchImpl ?? fetch;
  const voices: Record<Language, string> = {
    en: options.voices?.en ?? process.env.SPEECH_VOICE_EN?.trim() ?? DEFAULT_VOICES.en,
    es: options.voices?.es ?? process.env.SPEECH_VOICE_ES?.trim() ?? DEFAULT_VOICES.es,
    fr: options.voices?.fr ?? process.env.SPEECH_VOICE_FR?.trim() ?? DEFAULT_VOICES.fr,
    pt: options.voices?.pt ?? process.env.SPEECH_VOICE_PT?.trim() ?? DEFAULT_VOICES.pt,
  };
  for (const language of Object.keys(voices) as Language[]) {
    if (!voices[language]) voices[language] = DEFAULT_VOICES[language];
  }
  let credential = options.credential;
  const registered = new Map<string, Entry>();
  const audio = new Map<string, Buffer>();
  const inFlight = new Map<string, Promise<Buffer>>();
  let active = 0;
  const waiting: Array<() => void> = [];

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function token(): Promise<string> {
    credential ??= getAzureCredential();
    const result = await credential.getToken("https://cognitiveservices.azure.com/.default");
    if (!result?.token) throw new HttpError(503, "Speech authentication failed");
    return result.token;
  }

  async function request(entry: Entry, voice: string): Promise<Response> {
    return fetchImpl(`${endpoint}/tts/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/ssml+xml; charset=utf-8",
        "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
        "User-Agent": "matchlens",
      },
      body: buildSsml(entry, voice),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function render(entry: Entry): Promise<Buffer> {
    let response = await request(entry, voices[entry.language]);
    // HD voices are not available in every region; retry once with the standard neural voice.
    if (!response.ok && response.status === 400 && voices[entry.language] !== FALLBACK_VOICES[entry.language]) {
      response = await request(entry, FALLBACK_VOICES[entry.language]);
    }
    if (response.status === 429) throw new HttpError(429, "Speech request limit reached");
    if (!response.ok) throw new HttpError(503, "Speech synthesis is temporarily unavailable");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) throw new HttpError(503, "Speech synthesis returned no audio");
    return body;
  }

  const service: SpeechService = {
    configured: Boolean(endpoint),
    register(text, language, mood = "calm") {
      const clean = text.replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT);
      if (!endpoint || !clean) return undefined;
      const id = createHash("sha256").update(`${voices[language]}|${mood}|${language}|${clean}`).digest("hex").slice(0, 32);
      registered.delete(id);
      registered.set(id, { text: clean, language, mood });
      trimMap(registered, MAX_REGISTERED);
      return `/api/audio/${id}.mp3`;
    },
    async synthesize(id) {
      const cached = audio.get(id);
      if (cached) return cached;
      const entry = registered.get(id);
      if (!entry || !endpoint) throw new HttpError(404, "Audio not found");
      const pending = inFlight.get(id);
      if (pending) return pending;
      const job = slot(() => render(entry))
        .then((buffer) => {
          audio.set(id, buffer);
          trimMap(audio, MAX_CACHED_AUDIO);
          return buffer;
        })
        .catch((error: unknown) => {
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, "Speech synthesis is temporarily unavailable");
        })
        .finally(() => inFlight.delete(id));
      inFlight.set(id, job);
      return job;
    },
    warm(audioUrl) {
      const id = /([a-f0-9]{32})\.mp3$/u.exec(audioUrl)?.[1];
      if (id) service.synthesize(id).catch(() => undefined);
    },
  };
  return service;
}
