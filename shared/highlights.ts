import type { Language, MatchEvent, MatchFixture, TeamId } from "./types.js";
import type { Storyline } from "./platform.js";
import { metricOptions, passDifficulty } from "./metrics.js";
import { eventPeriod, periodBoundary, sameHalf, type MatchPeriod } from "./periods.js";
import { HIGH_XG_SHOT_THRESHOLD } from "./xg.js";

/**
 * Deterministic highlight selection.
 *
 * Live on Air has no footage for synthetic matches, so a highlight "reel" is a list of clips in match
 * time. The same clip list drives two outputs: an animated data reel rendered in the browser, and a
 * cut list (timecodes + ffmpeg commands) that trims a licensed broadcast recording when one exists.
 */

export type HighlightKind =
  | "goal" | "disallowed_goal" | "red_card" | "big_chance" | "key_save" | "booking"
  // Player-focused reels also cut a player's everyday contributions.
  | "shot" | "chance_created" | "tackle" | "hard_pass";

/** Narrows a reel to one player's own actions, or to one club's moments (with both sides' goals and red cards kept for context). */
export interface HighlightFocus {
  playerId?: string;
  teamId?: TeamId;
}

export interface HighlightClip {
  id: string;
  kind: HighlightKind;
  /** Display label that overrides the kind's name, e.g. a Video Lab tag such as "Clearance". */
  label?: string;
  keyEventId: string;
  /** Match-time window in seconds. */
  startSecond: number;
  endSecond: number;
  /** Match second of the key event inside the window. */
  keySecond: number;
  /** All feedevents inside the window, chronological; used to animate the build-up. */
  eventIds: string[];
  minute: number;
  teamId: TeamId;
  playerId: string;
  title: string;
  caption: string;
  /** Language the caption is actually in (falls back to English when no translation exists). */
  captionLanguage: Language;
  storylineId?: string;
  importance: number;
  scoreAfter: { home: number; away: number };
}

export interface HighlightReel {
  fixtureId: string;
  language: Language;
  clips: HighlightClip[];
  /** Sum of clip windows in match seconds. */
  totalMatchSeconds: number;
}

export type CommentaryMood = "calm" | "build" | "tense" | "excited";

export interface CommentaryLine {
  text: string;
  mood: CommentaryMood;
  /** Server-synthesized neural voice audio; absent when speech is not configured. */
  audioUrl?: string;
}

/** Spoken highlights commentary written by the Foundry commentator from the verified event feed. */
export interface HighlightCommentary {
  fixtureId: string;
  language: Language;
  /** Identifies the reel the commentary was written for; see commentarySignature. */
  signature: string;
  intro: CommentaryLine;
  lines: Array<CommentaryLine & { clipId: string }>;
  outro: CommentaryLine;
  source: "foundry" | "fallback";
  cached: boolean;
}

export interface CommentaryClipRequest {
  id: string;
  keyEventId: string;
  kind: HighlightKind;
  startSecond: number;
  endSecond: number;
  storylineId?: string;
}

export interface HighlightCommentaryRequest {
  language: Language;
  clips: CommentaryClipRequest[];
}

export function commentaryRequest(reel: HighlightReel): HighlightCommentaryRequest {
  return {
    language: reel.language,
    clips: reel.clips.map((clip) => ({
      id: clip.id,
      keyEventId: clip.keyEventId,
      kind: clip.kind,
      startSecond: clip.startSecond,
      endSecond: clip.endSecond,
      ...(clip.storylineId ? { storylineId: clip.storylineId } : {}),
    })),
  };
}

export function commentarySignature(request: HighlightCommentaryRequest): string {
  return [request.language, ...request.clips.map((clip) => `${clip.id}:${clip.keyEventId}:${clip.kind}:${clip.startSecond}-${clip.endSecond}:${clip.storylineId ?? ""}`)].join("|");
}

export interface CutListOptions {
  /** Seconds into the recording at which kick-off happens. */
  kickoffOffsetSeconds?: number;
  /** Real-time length of the half-time break in the recording, added to second-half timecodes. */
  halftimeBreakSeconds?: number;
  sourceFile?: string;
  /**
   * "match-clock" (default) assumes the recording runs in real match time.
   * "fit" spreads the key moments proportionally across a shorter recording (own or stock footage),
   * playing in real time and trimming every clip evenly when they would not fit.
   */
  mode?: CutListMode;
  /** Length of the recording; clips are clamped to it when known. Required for "fit". */
  recordingSeconds?: number;
  /** Length of the match in seconds; required for "fit". */
  matchSeconds?: number;
}

export type CutListMode = "match-clock" | "fit";

export interface CutListEntry {
  clipId: string;
  title: string;
  in: string;
  out: string;
  inSeconds: number;
  outSeconds: number;
  /** Match second shown at `inSeconds`; clips play in real time, so match time advances 1:1 from here. */
  matchInSeconds: number;
}

const WINDOWS: Record<HighlightKind, { pre: number; post: number; base: number }> = {
  goal: { pre: 16, post: 8, base: 100 },
  disallowed_goal: { pre: 12, post: 8, base: 75 },
  red_card: { pre: 10, post: 6, base: 80 },
  big_chance: { pre: 12, post: 5, base: 45 },
  key_save: { pre: 10, post: 5, base: 40 },
  booking: { pre: 6, post: 4, base: 12 },
  shot: { pre: 8, post: 4, base: 30 },
  chance_created: { pre: 8, post: 6, base: 35 },
  tackle: { pre: 6, post: 4, base: 22 },
  hard_pass: { pre: 6, post: 5, base: 20 }
};

/** A shot clip ("High illustrative xG shot") needs at least the shared illustrative-xG threshold. */
const BIG_CHANCE_XG = HIGH_XG_SHOT_THRESHOLD;
const STORYLINE_BONUS = 20;
const DEFAULT_MAX_CLIPS = 8;
/** A player reel can hold more moments; the commentary request accepts at most 10 clips. */
const PLAYER_MAX_CLIPS = 10;
const ASSIST_WINDOW_SECONDS = 15;
const HARD_PASS_MIN = 60;
const MUST_INCLUDE = new Set<HighlightKind>(["goal", "disallowed_goal", "red_card"]);

export function eventSecondOf(event: Pick<MatchEvent, "minute" | "second">): number {
  return event.minute * 60 + event.second;
}

/** Live views keep every revision of an event; keep only the latest revision of each id. */
export function latestRevisions(events: MatchEvent[]): MatchEvent[] {
  const byId = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = byId.get(event.id);
    if (!previous || event.revision >= previous.revision) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => eventSecondOf(a) - eventSecondOf(b));
}

function classify(event: MatchEvent, byId: Map<string, MatchEvent>, hasXg: boolean): { kind: HighlightKind; bonus: number } | null {
  if (event.type === "goal") return event.rescinded ? { kind: "disallowed_goal", bonus: 0 } : { kind: "goal", bonus: 0 };
  if (event.type === "red_card") return { kind: "red_card", bonus: 0 };
  // Video-tagged matches have no xG, so every attempt that didn't score counts as a chance.
  if (event.type === "shot") {
    if (!hasXg) return event.outcome === "success" ? null : { kind: "big_chance", bonus: 0 };
    return (event.xg ?? 0) >= BIG_CHANCE_XG ? { kind: "big_chance", bonus: Math.round((event.xg ?? 0) * 40) } : null;
  }
  if (event.type === "save") {
    const shot = event.relatedEventId ? byId.get(event.relatedEventId) : undefined;
    if (!hasXg) return { kind: "key_save", bonus: 0 };
    const xg = shot?.xg ?? 0;
    return xg >= 0.15 ? { kind: "key_save", bonus: Math.round(xg * 40) } : null;
  }
  if (event.type === "yellow_card") return { kind: "booking", bonus: 0 };
  return null;
}

function playerName(fixture: MatchFixture, playerId: string): string {
  return [...fixture.home.players, ...fixture.away.players].find((player) => player.id === playerId)?.name ?? "Unknown player";
}

function teamShort(fixture: MatchFixture, teamId: TeamId): string {
  return teamId === "home" ? fixture.home.shortName : fixture.away.shortName;
}

type Phrases = {
  title: Record<HighlightKind, string>;
  scores: (name: string, xg?: number) => string;
  ruledOut: (name: string) => string;
  sentOff: (name: string) => string;
  goesClose: (name: string, xg: number, outcome: string) => string;
  denies: (name: string, xg: number) => string;
  attempt: (name: string) => string;
  stops: (name: string) => string;
  booked: (name: string) => string;
  shoots: (name: string, outcome: string) => string;
  created: (name: string, shooter: string, scored: boolean) => string;
  tackles: (name: string) => string;
  hardPass: (name: string, difficulty: number) => string;
};

const PHRASES: Record<Language, Phrases> = {
  en: {
    title: { goal: "GOAL", disallowed_goal: "Goal ruled out", red_card: "Red card", big_chance: "High illustrative xG shot", key_save: "Key save", booking: "Booking", shot: "Shot", chance_created: "Chance created", tackle: "Tackle won", hard_pass: "Hard pass" },
    scores: (name, xg) => `${name} scores${xg !== undefined ? ` from a ${xg.toFixed(2)} xG chance` : ""}.`,
    ruledOut: (name) => `${name}'s goal is ruled out after review; the score is corrected.`,
    sentOff: (name) => `${name} is sent off.`,
    goesClose: (name, xg, outcome) => `${name} goes close: ${xg.toFixed(2)} xG, ${outcome}.`,
    denies: (name, xg) => `${name} denies a ${xg.toFixed(2)} xG chance.`,
    attempt: (name) => `${name} goes for goal.`,
    stops: (name) => `${name} keeps it out.`,
    booked: (name) => `${name} is booked.`,
    shoots: (name, outcome) => `${name} shoots: ${outcome}.`,
    created: (name, shooter, scored) => scored ? `${name} sets up ${shooter} to score.` : `${name} creates a chance for ${shooter}.`,
    tackles: (name) => `${name} wins the ball back.`,
    hardPass: (name, difficulty) => `${name} completes a difficult pass (${difficulty}/100).`
  },
  es: {
    title: { goal: "GOL", disallowed_goal: "Gol anulado", red_card: "Tarjeta roja", big_chance: "Ocasión clara", key_save: "Parada clave", booking: "Amonestación", shot: "Disparo", chance_created: "Ocasión creada", tackle: "Entrada ganada", hard_pass: "Pase difícil" },
    scores: (name, xg) => `Gol de ${name}${xg !== undefined ? ` en una ocasión de ${xg.toFixed(2)} xG` : ""}.`,
    ruledOut: (name) => `El gol de ${name} se anula tras la revisión; el marcador se corrige.`,
    sentOff: (name) => `${name} es expulsado.`,
    goesClose: (name, xg) => `${name} roza el gol: ocasión de ${xg.toFixed(2)} xG.`,
    denies: (name, xg) => `${name} detiene una ocasión de ${xg.toFixed(2)} xG.`,
    attempt: (name) => `${name} busca la portería.`,
    stops: (name) => `${name} evita el gol.`,
    booked: (name) => `${name} ve la tarjeta amarilla.`,
    shoots: (name) => `Disparo de ${name}.`,
    created: (name, shooter, scored) => scored ? `${name} asiste a ${shooter}, que marca.` : `${name} le crea una ocasión a ${shooter}.`,
    tackles: (name) => `${name} recupera el balón.`,
    hardPass: (name, difficulty) => `${name} completa un pase difícil (${difficulty}/100).`
  },
  fr: {
    title: { goal: "BUT", disallowed_goal: "But refusé", red_card: "Carton rouge", big_chance: "Grosse occasion", key_save: "Arrêt décisif", booking: "Avertissement", shot: "Frappe", chance_created: "Occasion créée", tackle: "Tacle gagné", hard_pass: "Passe difficile" },
    scores: (name, xg) => `But de ${name}${xg !== undefined ? ` sur une occasion à ${xg.toFixed(2)} xG` : ""}.`,
    ruledOut: (name) => `Le but de ${name} est refusé après vérification ; le score est corrigé.`,
    sentOff: (name) => `${name} est expulsé.`,
    goesClose: (name, xg) => `${name} passe tout près : occasion à ${xg.toFixed(2)} xG.`,
    denies: (name, xg) => `${name} repousse une occasion à ${xg.toFixed(2)} xG.`,
    attempt: (name) => `${name} tente sa chance.`,
    stops: (name) => `${name} s'interpose.`,
    booked: (name) => `${name} reçoit un carton jaune.`,
    shoots: (name) => `Frappe de ${name}.`,
    created: (name, shooter, scored) => scored ? `${name} offre le but à ${shooter}.` : `${name} crée une occasion pour ${shooter}.`,
    tackles: (name) => `${name} récupère le ballon.`,
    hardPass: (name, difficulty) => `${name} réussit une passe difficile (${difficulty}/100).`
  },
  pt: {
    title: { goal: "GOL", disallowed_goal: "Gol anulado", red_card: "Cartão vermelho", big_chance: "Chance clara", key_save: "Grande defesa", booking: "Cartão amarelo", shot: "Finalização", chance_created: "Chance criada", tackle: "Desarme", hard_pass: "Passe difícil" },
    scores: (name, xg) => `Gol de ${name}${xg !== undefined ? ` numa chance de ${xg.toFixed(2)} xG` : ""}.`,
    ruledOut: (name) => `O gol de ${name} é anulado após revisão; o placar é corrigido.`,
    sentOff: (name) => `${name} é expulso.`,
    goesClose: (name, xg) => `${name} quase marca: chance de ${xg.toFixed(2)} xG.`,
    denies: (name, xg) => `${name} impede uma chance de ${xg.toFixed(2)} xG.`,
    attempt: (name) => `${name} arrisca a finalização.`,
    stops: (name) => `${name} faz a defesa.`,
    booked: (name) => `${name} recebe cartão amarelo.`,
    shoots: (name) => `Finalização de ${name}.`,
    created: (name, shooter, scored) => scored ? `${name} dá a assistência para o gol de ${shooter}.` : `${name} cria uma chance para ${shooter}.`,
    tackles: (name) => `${name} recupera a bola.`,
    hardPass: (name, difficulty) => `${name} acerta um passe difícil (${difficulty}/100).`
  }
};

export function highlightKindLabel(kind: HighlightKind, language: Language): string {
  return PHRASES[language].title[kind];
}

/** Fixed on-screen strings for the rendered reel. */
export const REEL_TEXT: Record<Language, { intro: string; outro: string; moment: (index: number, total: number) => string; moments: (count: number) => string; matchTime: string; dataReel: string; footageReel: string }> = {
  en: { intro: "Live on Air HIGHLIGHTS", outro: "FULL REEL", moment: (i, n) => `MOMENT ${i} OF ${n}`, moments: (n) => `${n} moments · auto-selected from the verified event feed`, matchTime: "match time", dataReel: "SYNTHETIC DATA REEL", footageReel: "VIDEO RECAP · EVENTS TAGGED BY Live on Air" },
  es: { intro: "RESUMEN Live on Air", outro: "RESUMEN COMPLETO", moment: (i, n) => `JUGADA ${i} DE ${n}`, moments: (n) => `${n} jugadas · seleccionadas automáticamente de los eventos verificados`, matchTime: "tiempo de partido", dataReel: "RESUMEN CON DATOS SINTÉTICOS", footageReel: "RESUMEN EN VÍDEO · EVENTOS ETIQUETADOS POR Live on Air" },
  fr: { intro: "RÉSUMÉ Live on Air", outro: "RÉSUMÉ COMPLET", moment: (i, n) => `ACTION ${i} SUR ${n}`, moments: (n) => `${n} actions · sélectionnées automatiquement depuis les événements vérifiés`, matchTime: "temps de jeu", dataReel: "RÉSUMÉ DE DONNÉES SYNTHÉTIQUES", footageReel: "RÉSUMÉ VIDÉO · ÉVÉNEMENTS IDENTIFIÉS PAR Live on Air" },
  pt: { intro: "MELHORES MOMENTOS Live on Air", outro: "RESUMO COMPLETO", moment: (i, n) => `LANCE ${i} DE ${n}`, moments: (n) => `${n} lances · selecionados automaticamente dos eventos verificados`, matchTime: "tempo de jogo", dataReel: "RESUMO COM DADOS SINTÉTICOS", footageReel: "RESUMO EM VÍDEO · EVENTOS IDENTIFICADOS PELO Live on Air" }
};

function defaultTitle(kind: HighlightKind, minute: number, name: string, team: string, language: Language): string {
  return `${minute}' ${PHRASES[language].title[kind]} · ${name} (${team})`;
}

export interface CaptionDetail {
  shooterName?: string;
  scored?: boolean;
  difficulty?: number;
}

export function defaultCaption(kind: HighlightKind, event: MatchEvent, name: string, byId: Map<string, MatchEvent>, language: Language, detail: CaptionDetail = {}): string {
  const phrases = PHRASES[language];
  switch (kind) {
    case "goal": return phrases.scores(name, event.xg);
    case "disallowed_goal": return phrases.ruledOut(name);
    case "red_card": return phrases.sentOff(name);
    case "big_chance": return event.xg === undefined ? phrases.attempt(name) : phrases.goesClose(name, event.xg, event.outcome);
    case "key_save": {
      const shot = event.relatedEventId ? byId.get(event.relatedEventId) : undefined;
      return shot?.xg === undefined ? phrases.stops(name) : phrases.denies(name, shot.xg);
    }
    case "booking": return phrases.booked(name);
    case "shot": return phrases.shoots(name, event.outcome);
    case "chance_created": return phrases.created(name, detail.shooterName ?? "a teammate", Boolean(detail.scored));
    case "tackle": return phrases.tackles(name);
    case "hard_pass": return phrases.hardPass(name, detail.difficulty ?? 0);
  }
}

/** Storyline captions in the requested language; English is the fallback when the localizer has not produced one. */
function storylineCaption(storyline: Storyline | undefined, language: Language): { text: string; language: Language } | null {
  if (!storyline) return null;
  for (const candidate of language === "en" ? (["en"] as Language[]) : [language, "en" as Language]) {
    const text = storyline.overlay[candidate]?.trim() || storyline.headline[candidate]?.trim();
    if (text) return { text, language: candidate };
  }
  return null;
}

function scoreAt(events: MatchEvent[], second: number): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of events) {
    if (event.type === "goal" && !event.rescinded && eventSecondOf(event) <= second) score[event.teamId] += 1;
  }
  return score;
}

function onAirStorylines(storylines: Storyline[]): Storyline[] {
  return storylines.filter((storyline) => storyline.status === "approved" || storyline.status === "needs_review");
}

export function buildHighlightReel(
  fixture: MatchFixture,
  storylines: Storyline[] = [],
  options: { maxClips?: number; uptoSecond?: number; language?: Language; focus?: HighlightFocus; period?: MatchPeriod } = {}
): HighlightReel {
  const language = options.language ?? "en";
  const focus = options.focus ?? {};
  const maxClips = Math.max(1, options.maxClips ?? (focus.playerId ? PLAYER_MAX_CLIPS : DEFAULT_MAX_CLIPS));
  const upto = options.uptoSecond ?? fixture.durationSeconds;
  const events = latestRevisions(fixture.events).filter((event) => eventSecondOf(event) <= upto);
  const byId = new Map(events.map((event) => [event.id, event]));
  const boundary = periodBoundary(fixture);
  const period = options.period ?? "full";
  // A half that cannot be established yields an empty reel rather than silently showing the whole match.
  const inScope = (event: MatchEvent) => period === "full" || (boundary.available && eventPeriod(event, boundary) === (period === "first" ? 1 : 2));
  const storylineByEvent = new Map<string, Storyline>();
  for (const storyline of onAirStorylines(storylines)) {
    for (const eventId of storyline.triggerEventIds) {
      const existing = storylineByEvent.get(eventId);
      if (!existing || (existing.status !== "approved" && storyline.status === "approved")) storylineByEvent.set(eventId, storyline);
    }
  }

  type Candidate = { event: MatchEvent; kind: HighlightKind; importance: number; start: number; end: number; mustInclude: boolean; detail?: CaptionDetail };
  const candidates: Candidate[] = [];
  const hasXg = events.some((event) => event.type === "shot" && event.xg !== undefined);
  const push = (event: MatchEvent, kind: HighlightKind, bonus: number, extra: { start?: number; mustInclude?: boolean; detail?: CaptionDetail } = {}) => {
    const window = WINDOWS[kind];
    const at = eventSecondOf(event);
    const storyline = storylineByEvent.get(event.id);
    const importance = window.base + bonus + (storyline ? STORYLINE_BONUS : 0);
    // Goals, red cards, ruled-out goals and producer-approved storylines are never dropped by the clip cap.
    const mustInclude = MUST_INCLUDE.has(kind) || storyline?.status === "approved" || Boolean(extra.mustInclude);
    candidates.push({ event, kind, importance, start: Math.max(0, extra.start ?? at - window.pre), end: Math.min(fixture.durationSeconds, at + window.post), mustInclude, detail: extra.detail });
  };

  if (focus.playerId) {
    const playerId = focus.playerId;
    const metricOpts = metricOptions(fixture);
    for (const event of events) {
      if (event.playerId !== playerId || (event.rescinded && event.type !== "goal") || !inScope(event)) continue;
      const classified = classify(event, byId, hasXg);
      if (classified) { push(event, classified.kind, classified.bonus); continue; }
      if (event.type === "shot") push(event, "shot", Math.round((event.xg ?? 0) * 40));
      else if (event.type === "save") push(event, "key_save", 0);
      else if (event.type === "tackle" && event.outcome === "success") push(event, "tackle", 0);
      else if (event.type === "pass" && event.outcome === "complete") {
        const difficulty = passDifficulty(event, events, metricOpts);
        if (difficulty && difficulty.score >= HARD_PASS_MIN) push(event, "hard_pass", difficulty.score - HARD_PASS_MIN, { detail: { difficulty: difficulty.score } });
      }
    }
    // Chances the player created for a teammate: the shot's linked pass, else the team's last completed pass in the 15 s before it.
    for (const shot of events) {
      if (shot.rescinded || shot.playerId === playerId || !(shot.type === "shot" || (shot.type === "goal" && !shot.relatedEventId))) continue;
      const linked = shot.relatedEventId ? byId.get(shot.relatedEventId) : undefined;
      const at = eventSecondOf(shot);
      const creator = linked && (linked.type === "pass" || linked.type === "corner") && linked.playerId !== shot.playerId
        ? linked
        : events.filter((event) => event.type === "pass" && event.outcome === "complete" && !event.rescinded && event.teamId === shot.teamId && event.playerId !== shot.playerId
            && eventSecondOf(event) <= at && at - eventSecondOf(event) <= ASSIST_WINDOW_SECONDS && sameHalf(event, shot, boundary)).at(-1);
      if (!creator || creator.playerId !== playerId || !inScope(creator)) continue;
      const scored = shot.type === "goal" || shot.outcome === "success" || events.some((event) => event.type === "goal" && !event.rescinded && event.relatedEventId === shot.id);
      const windowStart = eventSecondOf(creator) - WINDOWS.chance_created.pre;
      push(creator, "chance_created", (scored ? 40 : 0) + Math.round((shot.xg ?? 0) * 40), {
        start: windowStart,
        mustInclude: scored,
        detail: { shooterName: playerName(fixture, shot.playerId), scored },
      });
      // Keep the shot itself inside the clip.
      const last = candidates[candidates.length - 1];
      last.end = Math.min(fixture.durationSeconds, Math.max(last.end, at + WINDOWS.chance_created.post));
    }
  } else {
    for (const event of events) {
      if (!inScope(event)) continue;
      const classified = classify(event, byId, hasXg);
      if (!classified) continue;
      // A club reel keeps the club's own moments plus both sides' goals and red cards for context.
      if (focus.teamId && event.teamId !== focus.teamId && !MUST_INCLUDE.has(classified.kind)) continue;
      push(event, classified.kind, classified.bonus);
    }
  }

  // Must-include moments first, then highest importance; ties go to the earlier moment so selection is stable.
  candidates.sort((a, b) => Number(b.mustInclude) - Number(a.mustInclude) || b.importance - a.importance || eventSecondOf(a.event) - eventSecondOf(b.event));
  const chosen: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.mustInclude && chosen.length >= maxClips) break;
    const overlapping = chosen.find((item) => candidate.start < item.end && item.start < candidate.end);
    if (overlapping) {
      // Overlapping moments become one clip anchored on the more important event.
      overlapping.start = Math.min(overlapping.start, candidate.start);
      overlapping.end = Math.max(overlapping.end, candidate.end);
      continue;
    }
    chosen.push({ ...candidate });
  }

  // Expanded windows can touch neighbours; coalesce so the reel never repeats footage.
  const ordered = chosen.sort((a, b) => a.start - b.start).reduce<Candidate[]>((merged, candidate) => {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start < previous.end) {
      const keep = candidate.importance > previous.importance ? candidate : previous;
      merged[merged.length - 1] = { ...keep, start: previous.start, end: Math.max(previous.end, candidate.end), mustInclude: previous.mustInclude || candidate.mustInclude };
      return merged;
    }
    merged.push(candidate);
    return merged;
  }, []);

  const mustIncludeEvents = candidates.filter((candidate) => candidate.mustInclude);
  const clips = ordered
    .map((candidate, index): HighlightClip => {
      const { event, kind } = candidate;
      const name = playerName(fixture, event.playerId);
      const storyline = storylineByEvent.get(event.id);
      const fromStoryline = storylineCaption(storyline, language);
      // A red card or approved moment that shares a window with a bigger moment keeps its own line in the caption.
      const alsoInClip = mustIncludeEvents
        .filter((other) => other.event.id !== event.id && eventSecondOf(other.event) >= candidate.start && eventSecondOf(other.event) <= candidate.end)
        .sort((a, b) => eventSecondOf(a.event) - eventSecondOf(b.event))
        .map((other) => storylineCaption(storylineByEvent.get(other.event.id), language)?.text
          ?? defaultCaption(other.kind, other.event, playerName(fixture, other.event.playerId), byId, language, other.detail));
      const caption = [fromStoryline?.text ?? defaultCaption(kind, event, name, byId, language, candidate.detail), ...alsoInClip].join(" ");
      const captionLanguage = fromStoryline?.language ?? language;
      return {
        id: `clip-${String(index + 1).padStart(2, "0")}`,
        kind,
        keyEventId: event.id,
        startSecond: candidate.start,
        endSecond: candidate.end,
        keySecond: eventSecondOf(event),
        eventIds:events.filter((item) => {
          const at = eventSecondOf(item);
          return at >= candidate.start && at <= candidate.end;
        }).map((item) => item.id),
        minute: event.minute,
        teamId: event.teamId,
        playerId: event.playerId,
        title: defaultTitle(kind, event.minute, name, teamShort(fixture, event.teamId), language),
        caption,
        captionLanguage,
        storylineId: storyline?.id,
        importance: candidate.importance,
        scoreAfter: scoreAt(events, candidate.end)
      };
    });

  return {
    fixtureId: fixture.id,
    language,
    clips,
    totalMatchSeconds: clips.reduce((sum, clip) => sum + (clip.endSecond - clip.startSecond), 0)
  };
}

export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Maps match time to recording time, accounting for kick-off offset and the half-time break. */
export function toRecordingSeconds(matchSecond: number, options: CutListOptions = {}): number {
  const kickoff = options.kickoffOffsetSeconds ?? 0;
  const breakSeconds = matchSecond >= 45 * 60 ? options.halftimeBreakSeconds ?? 0 : 0;
  return kickoff + matchSecond + breakSeconds;
}

function clipWindowInRecording(clip: HighlightClip, options: CutListOptions, shrink: number): [number, number, number] {
  if (options.mode !== "fit") {
    return [toRecordingSeconds(clip.startSecond, options), toRecordingSeconds(clip.endSecond, options), toRecordingSeconds(clip.keySecond, options)];
  }
  const kickoff = options.kickoffOffsetSeconds ?? 0;
  const usable = Math.max(0, (options.recordingSeconds ?? 0) - kickoff);
  const scale = options.matchSeconds && options.matchSeconds > 0 ? usable / options.matchSeconds : 1;
  const keyAt = kickoff + clip.keySecond * scale;
  return [keyAt - (clip.keySecond - clip.startSecond) * shrink, keyAt + (clip.endSecond - clip.keySecond) * shrink, keyAt];
}

/** In fit mode, clips are shortened evenly when together they would not fit in the recording. */
function fitShrink(reel: HighlightReel, options: CutListOptions): number {
  if (options.mode !== "fit" || !options.recordingSeconds) return 1;
  const usable = Math.max(0, options.recordingSeconds - (options.kickoffOffsetSeconds ?? 0));
  const total = reel.clips.reduce((sum, clip) => sum + clip.endSecond - clip.startSecond, 0);
  return total > 0 ? Math.min(1, (usable * 0.9) / total) : 1;
}

export function buildCutList(reel: HighlightReel, options: CutListOptions = {}): CutListEntry[] {
  const floor = options.kickoffOffsetSeconds ?? 0;
  const ceiling = options.recordingSeconds ?? Number.POSITIVE_INFINITY;
  const shrink = fitShrink(reel, options);
  const entries: CutListEntry[] = [];
  let previousOut = floor;
  for (const clip of reel.clips) {
    const [rawIn, rawOut, keyAt] = clipWindowInRecording(clip, options, shrink);
    // Never re-use footage from the previous clip and never run past the end of the recording.
    const inSeconds = Math.max(rawIn, previousOut, 0);
    const outSeconds = Math.min(rawOut, ceiling);
    if (outSeconds - inSeconds < 0.5) continue;
    previousOut = outSeconds;
    entries.push({ clipId: clip.id, title: clip.title, in: formatTimecode(inSeconds), out: formatTimecode(outSeconds), inSeconds, outSeconds, matchInSeconds: clip.keySecond - (keyAt - inSeconds) });
  }
  return entries;
}

export function buildFfmpegScript(reel: HighlightReel, options: CutListOptions = {}): string {
  const source = options.sourceFile ?? "match-recording.mp4";
  const entries = buildCutList(reel, options);
  const lines = [
    "#!/usr/bin/env bash",
    "# Live on Air highlight cut list. Point SOURCE at footage you own or are licensed to use.",
    options.mode === "fit"
      ? `# Fit mode: key moments spread across a ${Math.round(options.recordingSeconds ?? 0)}s recording, kick-off offset ${options.kickoffOffsetSeconds ?? 0}s.`
      : `# Kick-off offset: ${options.kickoffOffsetSeconds ?? 0}s, half-time break: ${options.halftimeBreakSeconds ?? 0}s.`,
    "set -euo pipefail",
    `SOURCE="\${1:-${source}}"`,
    ": > clips.txt"
  ];
  for (const entry of entries) {
    lines.push(`# ${entry.title.replaceAll("\n", " ")}`);
    lines.push(`ffmpeg -y -ss ${entry.in} -to ${entry.out} -i "$SOURCE" -c:v libx264 -c:a aac ${entry.clipId}.mp4`);
    lines.push(`echo "file '${entry.clipId}.mp4'" >> clips.txt`);
  }
  lines.push("ffmpeg -y -f concat -safe 0 -i clips.txt -c copy highlights.mp4");
  return `${lines.join("\n")}\n`;
}
