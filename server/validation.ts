import { z } from "zod";

import type {
  AnalysisRequest,
  Language,
  MatchFixture,
  MatchPeriod,
  MatchSnapshot,
  NarrativeRequest,
  Persona,
} from "../shared/types.js";

const personaValues = ["analyst", "casual", "player"] as const satisfies readonly Persona[];
const languageValues = ["en", "es", "fr", "pt"] as const satisfies readonly Language[];
const formatValues = ["story", "recap"] as const satisfies readonly NarrativeRequest["format"][];
export const periodValues = ["full", "first", "second"] as const satisfies readonly MatchPeriod[];
export const periodSchema = z.enum(periodValues);

const boundedId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);

const analysisSchema = z.object({
  fixtureId: boundedId,
  atSecond: z.number().int().min(0).max(5400),
  correction: z.boolean().optional(),
  persona: z.enum(personaValues),
  language: z.enum(languageValues),
  favoritePlayerId: boundedId.optional(),
  favoriteClubId: boundedId.optional(),
  period: periodSchema.optional(),
}).strict();

// Recaps walk the whole match (half-time score, every storyline), so only the full-match scope is narrated.
const narrativeSchema = analysisSchema.extend({
  format: z.enum(formatValues),
  storyId: boundedId.optional(),
  period: z.literal("full").optional(),
}).strict();

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export function parseStrict<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, `${path}${issue.message}`);
  }
  return result.data;
}

export function parseAnalysisRequest(payload: unknown): AnalysisRequest {
  return parseStrict(analysisSchema, payload);
}

export function parseNarrativeRequest(payload: unknown): NarrativeRequest {
  return parseStrict(narrativeSchema, payload);
}

export function assertFixtureWindow(fixture: MatchFixture, atSecond: number): void {
  if (atSecond > fixture.durationSeconds) {
    throw new HttpError(400, `atSecond must be <= fixture duration (${fixture.durationSeconds})`);
  }
}

export function assertKnownFavoritePlayer(fixture: MatchFixture, favoritePlayerId?: string): void {
  if (!favoritePlayerId) {
    return;
  }

  const knownPlayerIds = new Set([
    ...fixture.home.players.map((player) => player.id),
    ...fixture.away.players.map((player) => player.id),
  ]);

  if (!knownPlayerIds.has(favoritePlayerId)) {
    throw new HttpError(400, "favoritePlayerId must refer to a player in the fixture");
  }
}

export function assertKnownStory(snapshot: MatchSnapshot, storyId?: string): void {
  if (!storyId) {
    return;
  }

  if (!snapshot.stories.some((story) => story.id === storyId)) {
    throw new HttpError(400, "storyId must refer to a story in the current snapshot");
  }
}
