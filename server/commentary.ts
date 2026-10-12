import { createHash } from "node:crypto";

import { z } from "zod";

import {
  commentarySignature,
  defaultCaption,
  eventSecondOf,
  latestRevisions,
  type CommentaryLine,
  type CommentaryMood,
  type HighlightCommentary,
  type HighlightCommentaryRequest,
  type HighlightKind,
} from "../shared/highlights.js";
import type { Storyline } from "../shared/platform.js";
import type { Language, MatchEvent, MatchFixture, TeamId } from "../shared/types.js";
import {
  completeWithSingleRetry,
  createBudget,
  getRemainingTime,
  LANGUAGE_NAME,
  parseJsonWithSchema,
  type CompletionClient,
} from "./narrator.js";
import type { SpeechService } from "./speech.js";
import { groundingProblems } from "./spokenGuard.js";
import { HttpError } from "./validation.js";

/**
 * Highlights commentator: writes broadcast-style spoken lines for each reel clip from the verified
 * event sequence inside the clip window, then voices them with Azure AI Speech neural voices.
 */

const kinds = ["goal", "disallowed_goal", "red_card", "big_chance", "key_save", "booking"] as const satisfies readonly HighlightKind[];
const moods = ["calm", "build", "tense", "excited"] as const satisfies readonly CommentaryMood[];
const boundedId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9:_.-]+$/u);

export const commentaryRequestSchema = z.object({
  language: z.enum(["en", "es", "fr"]),
  clips: z.array(z.object({
    id: z.string().regex(/^clip-\d{2}$/u),
    keyEventId: boundedId,
    kind: z.enum(kinds),
    startSecond: z.number().finite().min(0).max(4 * 3600),
    endSecond: z.number().finite().min(0).max(4 * 3600),
    storylineId: boundedId.optional(),
  }).strict()).min(1).max(10),
}).strict();

const lineSchema = z.object({ text: z.string().trim().min(2).max(320), mood: z.enum(moods) }).strict();
const modelSchema = z.object({
  intro: lineSchema,
  lines: z.array(lineSchema.extend({ clipId: z.string() }).strict()).min(1).max(10),
  outro: lineSchema,
}).strict();

const DEFAULT_MOOD: Record<HighlightKind, CommentaryMood> = {
  goal: "excited",
  disallowed_goal: "tense",
  red_card: "tense",
  big_chance: "build",
  key_save: "tense",
  booking: "calm",
};
const SEQUENCE_SKIP = new Set(["kickoff", "halftime", "fulltime"]);
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 32;
const TIMEOUT_MS = 30_000;

export interface Commentator {
  readonly configured: boolean;
  write(request: HighlightCommentaryRequest, fixture: MatchFixture, storylines: Storyline[], requestId: string): Promise<HighlightCommentary>;
}

export type CommentatorOptions = {
  completion?: { client: CompletionClient; deployment: string };
  speech: SpeechService;
  maxRequestsPerHour?: number;
  maxConcurrent?: number;
  now?: () => number;
};

function playerName(fixture: MatchFixture, playerId: string): string {
  return [...fixture.home.players, ...fixture.away.players].find((player) => player.id === playerId)?.name ?? "Unknown player";
}

function teamName(fixture: MatchFixture, teamId: TeamId): string {
  return teamId === "home" ? fixture.home.name : fixture.away.name;
}

function scoreBefore(events: MatchEvent[], second: number): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of events) {
    if (event.type === "goal" && !event.rescinded && eventSecondOf(event) <= second) score[event.teamId] += 1;
  }
  return score;
}

/** Attacking-frame coordinates (0-100, attacking towards x=100). */
function zone(event: MatchEvent): string | undefined {
  if (event.type !== "shot" && event.type !== "goal") return undefined;
  const central = event.y >= 37 && event.y <= 63;
  if (event.x >= 94 && central) return "six-yard box";
  if (event.x >= 83 && event.y >= 21 && event.y <= 79) return "inside the penalty area";
  if (event.x >= 75) return "edge of the area";
  return "from distance";
}

function outcomeLabel(event: MatchEvent): string {
  if (event.type === "goal") return event.rescinded ? "goal ruled out after review" : "scored";
  return event.outcome;
}

function storylineText(storyline: Storyline | undefined, language: Language): string | undefined {
  if (!storyline) return undefined;
  for (const candidate of [language, "en"] as Language[]) {
    const text = storyline.onAirLine[candidate]?.trim() || storyline.overlay[candidate]?.trim() || storyline.headline[candidate]?.trim();
    if (text) return text.slice(0, 300);
  }
  return undefined;
}

function fallbackIntro(fixture: MatchFixture, language: Language): string {
  if (language === "es") return `Resumen del partido: ${fixture.home.name} contra ${fixture.away.name}.`;
  if (language === "fr") return `Le résumé du match : ${fixture.home.name} contre ${fixture.away.name}.`;
  return `The highlights: ${fixture.home.name} against ${fixture.away.name}.`;
}

function fallbackOutro(fixture: MatchFixture, score: { home: number; away: number }, language: Language): string {
  const line = `${fixture.home.name} ${score.home}, ${fixture.away.name} ${score.away}.`;
  if (language === "es") return `Así queda: ${line}`;
  if (language === "fr") return `Voilà le score : ${line}`;
  return `And that's how it stands: ${line}`;
}

type ClipContext = {
  clipId: string;
  kind: HighlightKind;
  minute: number;
  keyPlayer: string;
  team: string;
  scoreBefore: { home: number; away: number };
  scoreAfter: { home: number; away: number };
  sequence: Array<Record<string, unknown>>;
  producerNote?: string;
};

function buildContexts(request: HighlightCommentaryRequest, fixture: MatchFixture, storylines: Storyline[]) {
  const events = latestRevisions(fixture.events);
  const byId = new Map(events.map((event) => [event.id, event]));
  const storylineById = new Map(storylines.map((storyline) => [storyline.id, storyline]));
  const contexts: ClipContext[] = [];
  const fallbacks = new Map<string, string>();
  for (const clip of request.clips) {
    const key = byId.get(clip.keyEventId);
    if (!key) throw new HttpError(400, "Clip references an unknown event");
    const keySecond = eventSecondOf(key);
    if (clip.endSecond <= clip.startSecond || clip.endSecond - clip.startSecond > 180 || keySecond < clip.startSecond - 1 || keySecond > clip.endSecond + 1) {
      throw new HttpError(400, "Clip window does not contain its key event");
    }
    const storyline = clip.storylineId ? storylineById.get(clip.storylineId) : undefined;
    const note = storylineText(storyline, request.language);
    const name = playerName(fixture, key.playerId);
    fallbacks.set(clip.id, note ?? defaultCaption(clip.kind, key, name, byId, request.language));
    const sequence = events
      .filter((event) => !SEQUENCE_SKIP.has(event.type))
      .filter((event) => eventSecondOf(event) >= clip.startSecond && eventSecondOf(event) <= clip.endSecond)
      .filter((event) => !event.rescinded || event.id === key.id)
      .slice(-14)
      .map((event) => ({
        minute: event.minute,
        type: event.type,
        player: playerName(fixture, event.playerId),
        team: teamName(fixture, event.teamId),
        outcome: outcomeLabel(event),
        ...(zone(event) ? { where: zone(event) } : {}),
        ...(event.xg !== undefined ? { chanceQuality: event.xg >= 0.35 ? "big chance" : event.xg >= 0.15 ? "decent chance" : "half chance" } : {}),
        ...(event.id === key.id ? { keyMoment: true } : {}),
      }));
    contexts.push({
      clipId: clip.id,
      kind: clip.kind,
      minute: key.minute,
      keyPlayer: name,
      team: teamName(fixture, key.teamId),
      scoreBefore: scoreBefore(events, keySecond - 1),
      scoreAfter: scoreBefore(events, clip.endSecond),
      sequence,
      ...(note ? { producerNote: note } : {}),
    });
  }
  return { contexts, fallbacks };
}

function cacheKey(fixture: MatchFixture, request: HighlightCommentaryRequest, contexts: ClipContext[]): string {
  return createHash("sha256").update(JSON.stringify([fixture.id, request.language, contexts])).digest("hex");
}

export function createCommentator(options: CommentatorOptions): Commentator {
  const now = options.now ?? Date.now;
  const budget = createBudget(
    options.maxRequestsPerHour ?? Number(process.env.AI_MAX_REQUESTS_PER_HOUR ?? 60),
    options.maxConcurrent ?? Number(process.env.AI_MAX_CONCURRENT ?? 2),
    now,
  );
  const cache = new Map<string, { expiresAt: number; value: HighlightCommentary }>();

  async function writeWithModel(
    completion: NonNullable<CommentatorOptions["completion"]>,
    request: HighlightCommentaryRequest,
    fixture: MatchFixture,
    contexts: ClipContext[],
    requestId: string,
  ): Promise<z.infer<typeof modelSchema>> {
    const deadline = Date.now() + TIMEOUT_MS;
    const payload = {
      language: request.language,
      home: fixture.home.name,
      away: fixture.away.name,
      clips: contexts,
    };
    const result = await completeWithSingleRetry(completion.client, {
      messages: [
        {
          role: "system",
          content: [
            `You are the Live on Air highlights commentator, an experienced football TV commentator voicing a highlights package in natural, idiomatic ${LANGUAGE_NAME[request.language]}.`,
            "Write spoken commentary exactly as it would be heard on a real highlights show: vivid, varied and emotional, following the build-up in each clip's sequence and reacting to the key moment. Never sound like a list of tagged events, and never start every line the same way.",
            "Use ONLY the information provided for each clip: players, teams, the event sequence, outcomes, where shots came from, chance quality, the score and any producer note.",
            "Do not invent anything else: no extra players, assists, skills, distances, body parts, weather, crowd, injuries, records or quotes. If the sequence is thin, keep the line short rather than embellishing.",
            "Every number you write must appear in the input; write minutes and scores as digits. Never say xG, decimals, IDs or seconds.",
            "Each clip line is 12-26 words, present tense, made to be spoken aloud over the clip. Goals deserve real excitement; a ruled-out goal must say it was ruled out after review.",
            "intro: one welcoming line naming both teams (at most 22 words). outro: one closing line with the score after the last clip (at most 26 words).",
            "Pick a mood for each line from calm, build, tense, excited. Return strict JSON with intro, lines (one per clip, same clipId order) and outro.",
          ].join(" "),
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.8,
      maxTokens: 1_400,
      timeoutMs: Math.min(25_000, getRemainingTime(deadline)),
      requestId,
      responseSchema: {
        name: "matchlens_commentary",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["intro", "lines", "outro"],
          properties: {
            intro: { type: "object", additionalProperties: false, required: ["text", "mood"], properties: { text: { type: "string" }, mood: { type: "string", enum: [...moods] } } },
            lines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["clipId", "text", "mood"],
                properties: {
                  clipId: { type: "string", enum: contexts.map((context) => context.clipId) },
                  text: { type: "string" },
                  mood: { type: "string", enum: [...moods] },
                },
              },
            },
            outro: { type: "object", additionalProperties: false, required: ["text", "mood"], properties: { text: { type: "string" }, mood: { type: "string", enum: [...moods] } } },
          },
        },
      },
    }, deadline);
    return parseJsonWithSchema(result.text, "commentary", modelSchema);
  }

  return {
    configured: Boolean(options.completion) || options.speech.configured,
    async write(request, fixture, storylines, requestId) {
      if (!options.completion && !options.speech.configured) {
        throw new HttpError(503, "Highlights commentary is not configured");
      }
      const { contexts, fallbacks } = buildContexts(request, fixture, storylines);
      const key = cacheKey(fixture, request, contexts);
      const signature = commentarySignature(request);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        const value = structuredClone(hit.value);
        // Re-register so audio stays available even if the speech registry evicted it.
        for (const line of [value.intro, ...value.lines, value.outro]) options.speech.register(line.text, request.language, line.mood);
        return { ...value, signature, cached: true };
      }

      const finalScore = contexts.at(-1)?.scoreAfter ?? { home: 0, away: 0 };
      const teams = `${fixture.home.name} ${fixture.away.name}`;
      let source: HighlightCommentary["source"] = "fallback";
      let intro: Omit<CommentaryLine, "audioUrl"> = { text: fallbackIntro(fixture, request.language), mood: "build" };
      let outro: Omit<CommentaryLine, "audioUrl"> = { text: fallbackOutro(fixture, finalScore, request.language), mood: "calm" };
      const lines = new Map(contexts.map((context) => [context.clipId, { text: fallbacks.get(context.clipId) ?? "", mood: DEFAULT_MOOD[context.kind] }]));

      if (options.completion) {
        const lease = budget.acquire();
        try {
          const written = await writeWithModel(options.completion, request, fixture, contexts, requestId);
          source = "foundry";
          const sourceFor = (extra: unknown) => {
            const minutes = JSON.stringify(extra).match(/"minute":\d+/gu)?.map((item) => Number(item.split(":")[1]) + 1).join(" ") ?? "";
            return `${JSON.stringify([teams, extra])} ${minutes}`;
          };
          if (groundingProblems(written.intro.text, sourceFor(contexts.map((context) => context.minute)), fixture).length === 0) intro = written.intro;
          if (groundingProblems(written.outro.text, sourceFor([finalScore, contexts]), fixture).length === 0) outro = written.outro;
          for (const line of written.lines) {
            const context = contexts.find((item) => item.clipId === line.clipId);
            if (context && groundingProblems(line.text, sourceFor(context), fixture).length === 0) {
              lines.set(line.clipId, { text: line.text, mood: line.mood });
            }
          }
        } catch {
          // Model failures keep the caption-based lines so the reel still has a voice.
        } finally {
          lease.release();
        }
      }

      const voice = (line: Omit<CommentaryLine, "audioUrl">): CommentaryLine => {
        const audioUrl = options.speech.register(line.text, request.language, line.mood);
        if (audioUrl) options.speech.warm?.(audioUrl);
        return audioUrl ? { ...line, audioUrl } : { ...line };
      };
      const value: HighlightCommentary = {
        fixtureId: fixture.id,
        language: request.language,
        signature,
        intro: voice(intro),
        lines: contexts.map((context) => ({ clipId: context.clipId, ...voice(lines.get(context.clipId)!) })),
        outro: voice(outro),
        source,
        cached: false,
      };
      if (source === "foundry" || !options.completion) {
        cache.delete(key);
        cache.set(key, { expiresAt: now() + CACHE_TTL_MS, value: structuredClone(value) });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      }
      return value;
    },
  };
}
