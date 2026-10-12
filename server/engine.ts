import { createHash } from "node:crypto";
import type {
  AnalysisRequest,
  CorrectionNotice,
  Language,
  MatchEvent,
  MatchSnapshot,
  MatchFixture,
  Persona,
  StoryCard,
  StoryMetric,
  Team,
  TeamId,
  TeamStats
} from "../shared/types.js";
import { getFixture } from "./fixtures.js";

type TranslationKey =
  | "correctionNotice"
  | "metricShots"
  | "metricShotsPrevious"
  | "metricShotsCurrent"
  | "metricPressure"
  | "metricPressureHome"
  | "metricPressureAway"
  | "metricPassAccuracy"
  | "metricPassesHome"
  | "metricPassesAway"
  | "metricSetPieces"
  | "metricSetPieceLinks"
  | "metricSetPieceLinksHome"
  | "metricSetPieceLinksAway"
  | "metricScoreEvents"
  | "metricGoals"
  | "metricCards"
  | "metricTouches";

const translations: Record<Language, Record<TranslationKey, string>> = {
  en: {
    correctionNotice: "Video review update: previous goal has been rescinded.",
    metricShots: "Shots (last 8m)",
    metricShotsPrevious: "Shots (previous 8m)",
    metricShotsCurrent: "Shots (current 8m)",
    metricPressure: "Pressure actions (last 8m)",
    metricPressureHome: "Home pressure (last 8m)",
    metricPressureAway: "Away pressure (last 8m)",
    metricPassAccuracy: "Pass accuracy",
    metricPassesHome: "Home completed/attempted passes (last 8m)",
    metricPassesAway: "Away completed/attempted passes (last 8m)",
    metricSetPieces: "Set pieces",
    metricSetPieceLinks: "Corner-shot links (last 8m)",
    metricSetPieceLinksHome: "Home corner-shot links (last 8m)",
    metricSetPieceLinksAway: "Away corner-shot links (last 8m)",
    metricScoreEvents: "Score-changing moments",
    metricGoals: "Active goals",
    metricCards: "Cards",
    metricTouches: "Involved events"
  },
  es: {
    correctionNotice: "Actualización de revisión: el gol previo fue anulado.",
    metricShots: "Tiros (últimos 8 min)",
    metricShotsPrevious: "Tiros (8 min previos)",
    metricShotsCurrent: "Tiros (8 min actuales)",
    metricPressure: "Acciones de presión (últimos 8 min)",
    metricPressureHome: "Presiones local (últimos 8 min)",
    metricPressureAway: "Presiones visitante (últimos 8 min)",
    metricPassAccuracy: "Precisión de pase",
    metricPassesHome: "Pases local completos/intentados (últimos 8 min)",
    metricPassesAway: "Pases visitante completos/intentados (últimos 8 min)",
    metricSetPieces: "Balones parados",
    metricSetPieceLinks: "Enlaces córner-tiro (últimos 8 min)",
    metricSetPieceLinksHome: "Enlaces córner-tiro local (últimos 8 min)",
    metricSetPieceLinksAway: "Enlaces córner-tiro visitante (últimos 8 min)",
    metricScoreEvents: "Momentos que cambiaron el marcador",
    metricGoals: "Goles vigentes",
    metricCards: "Tarjetas",
    metricTouches: "Eventos con participación"
  },
  fr: {
    correctionNotice: "Mise à jour vidéo: le but précédent a été annulé.",
    metricShots: "Tirs (8 dernières min)",
    metricShotsPrevious: "Tirs (8 min précédentes)",
    metricShotsCurrent: "Tirs (8 min actuelles)",
    metricPressure: "Actions de pressing (8 dernières min)",
    metricPressureHome: "Pressings domicile (8 dernières min)",
    metricPressureAway: "Pressings extérieur (8 dernières min)",
    metricPassAccuracy: "Précision de passe",
    metricPassesHome: "Passes domicile réussies/tentées (8 dernières min)",
    metricPassesAway: "Passes extérieur réussies/tentées (8 dernières min)",
    metricSetPieces: "Phases arrêtées",
    metricSetPieceLinks: "Liens corner-tir (8 dernières min)",
    metricSetPieceLinksHome: "Liens corner-tir domicile (8 dernières min)",
    metricSetPieceLinksAway: "Liens corner-tir extérieur (8 dernières min)",
    metricScoreEvents: "Moments qui changent le score",
    metricGoals: "Buts actifs",
    metricCards: "Cartons",
    metricTouches: "Actions impliquées"
  },
  pt: {
    correctionNotice: "Atualização do vídeo: o gol anterior foi anulado.",
    metricShots: "Finalizações (últimos 8 min)",
    metricShotsPrevious: "Finalizações (8 min anteriores)",
    metricShotsCurrent: "Finalizações (8 min atuais)",
    metricPressure: "Ações de pressão (últimos 8 min)",
    metricPressureHome: "Pressão do mandante (últimos 8 min)",
    metricPressureAway: "Pressão do visitante (últimos 8 min)",
    metricPassAccuracy: "Precisão de passe",
    metricPassesHome: "Passes certos/tentados do mandante (últimos 8 min)",
    metricPassesAway: "Passes certos/tentados do visitante (últimos 8 min)",
    metricSetPieces: "Bolas paradas",
    metricSetPieceLinks: "Escanteios que viraram finalização (últimos 8 min)",
    metricSetPieceLinksHome: "Escanteio-finalização do mandante (últimos 8 min)",
    metricSetPieceLinksAway: "Escanteio-finalização do visitante (últimos 8 min)",
    metricScoreEvents: "Momentos que mudaram o placar",
    metricGoals: "Gols válidos",
    metricCards: "Cartões",
    metricTouches: "Lances com participação"
  }
};

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function sortEventsStable(events: MatchEvent[]): MatchEvent[] {
  return [...events].sort((a, b) => {
    return eventSecond(a) - eventSecond(b) || a.id.localeCompare(b.id) || a.revision - b.revision;
  });
}

export function reconcileEvents(
  ingestedEvents: MatchEvent[],
  fixture: MatchFixture,
  atSecond: number,
  correctionEnabled: boolean
): { activeEvents: MatchEvent[]; corrections: CorrectionNotice[] } {
  const byId = new Map<string, MatchEvent>();
  const sorted = sortEventsStable(ingestedEvents);
  for (const event of sorted) {
    const prev = byId.get(event.id);
    if (!prev || event.revision >= prev.revision) {
      byId.set(event.id, { ...event });
    }
  }

  const corrections: CorrectionNotice[] = [];
  if (correctionEnabled && atSecond >= fixture.correctionAvailableAt) {
    const target = byId.get(fixture.correctionEventId);
    if (target && target.type === "goal" && !target.rescinded) {
      const revised: MatchEvent = { ...target, revision: target.revision + 1, rescinded: true };
      byId.set(target.id, revised);
      corrections.push({
        eventId: target.id,
        message: "",
        previousRevision: target.revision,
        revision: revised.revision
      });
    }
  }

  return { activeEvents: sortEventsStable([...byId.values()]), corrections };
}

function assertRequest(request: AnalysisRequest, fixture: MatchFixture): void {
  if (request.fixtureId !== fixture.id) {
    throw new RangeError(`fixtureId ${request.fixtureId} does not match fixture ${fixture.id}`);
  }
  if (!Number.isInteger(request.atSecond) || request.atSecond < 0 || request.atSecond > fixture.durationSeconds) {
    throw new RangeError(`atSecond must be between 0 and ${fixture.durationSeconds}`);
  }
  if (request.favoritePlayerId) {
    const players = new Set([...fixture.home.players, ...fixture.away.players].map((p) => p.id));
    if (!players.has(request.favoritePlayerId)) {
      throw new RangeError(`Unknown favorite player: ${request.favoritePlayerId}`);
    }
  }
}

function emptyStats(): TeamStats {
  return {
    goals: 0,
    shots: 0,
    passes: 0,
    completedPasses: 0,
    passAccuracy: 0,
    corners: 0,
    tackles: 0,
    pressureEvents: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0,
    illustrativeXg: 0
  };
}

function computeStats(activeEvents: MatchEvent[]): { home: TeamStats; away: TeamStats; score: { home: number; away: number } } {
  const home = emptyStats();
  const away = emptyStats();
  for (const evt of activeEvents) {
    const teamStats = evt.teamId === "home" ? home : away;
    if (evt.type === "goal" && !evt.rescinded) teamStats.goals += 1;
    if (evt.type === "shot") {
      teamStats.shots += 1;
      if (typeof evt.xg === "number" && Number.isFinite(evt.xg)) {
        teamStats.illustrativeXg += evt.xg;
      }
    }
    if (evt.type === "pass") {
      teamStats.passes += 1;
      if (evt.outcome === "complete") teamStats.completedPasses += 1;
    }
    if (evt.type === "corner") teamStats.corners += 1;
    if (evt.type === "tackle") teamStats.tackles += 1;
    if (evt.type === "pressure") teamStats.pressureEvents += 1;
    if (evt.type === "foul") teamStats.fouls += 1;
    if (evt.type === "yellow_card") teamStats.yellowCards += 1;
    if (evt.type === "red_card") teamStats.redCards += 1;
  }
  for (const stats of [home, away]) {
    stats.passAccuracy = stats.passes > 0 ? Number(((stats.completedPasses / stats.passes) * 100).toFixed(2)) : 0;
    stats.illustrativeXg = Number(stats.illustrativeXg.toFixed(3));
  }
  return {
    home,
    away,
    score: { home: home.goals, away: away.goals }
  };
}

function tr(language: Language, key: TranslationKey): string {
  return translations[language][key];
}

function formatTitle(language: Language, base: string): string {
  if (language === "es") return `Resumen: ${base}`;
  if (language === "fr") return `Synthèse: ${base}`;
  if (language === "pt") return `Resumo: ${base}`;
  return base;
}

function personaText(persona: Persona, analyst: string, casual: string, player: string): string {
  if (persona === "casual") return casual;
  if (persona === "player") return player;
  return analyst;
}

function localizedStory(
  id: string,
  kind: StoryCard["kind"],
  language: Language,
  persona: Persona,
  importance: number,
  evidenceIds: string[],
  metrics: StoryMetric[],
  windowStart: number,
  windowEnd: number,
  teamId: TeamId | undefined,
  text: {
    en: { title: string; analyst: string; casual: string; player: string; whyA: string; whyC: string; whyP: string };
    es: { title: string; analyst: string; casual: string; player: string; whyA: string; whyC: string; whyP: string };
    fr: { title: string; analyst: string; casual: string; player: string; whyA: string; whyC: string; whyP: string };
    pt: { title: string; analyst: string; casual: string; player: string; whyA: string; whyC: string; whyP: string };
  },
  confidence: "observed" | "inferred"
): StoryCard {
  const selected = text[language];
  return {
    id,
    kind,
    title: formatTitle(language, selected.title),
    summary: personaText(persona, selected.analyst, selected.casual, selected.player),
    whyItMatters: personaText(persona, selected.whyA, selected.whyC, selected.whyP),
    evidenceIds,
    metrics,
    confidence,
    importance,
    windowStart,
    windowEnd,
    teamId
  };
}

function rollingWindow(events: MatchEvent[], atSecond: number, duration = 8 * 60): MatchEvent[] {
  const start = Math.max(0, atSecond - duration);
  return events.filter((evt) => {
    const sec = eventSecond(evt);
    return sec >= start && sec <= atSecond;
  });
}

function eventsInRange(events: MatchEvent[], startSecond: number, endSecond: number): MatchEvent[] {
  return events.filter((evt) => {
    const sec = eventSecond(evt);
    return sec >= startSecond && sec <= endSecond;
  });
}

function formatWindowLabel(startSecond: number, endSecond: number): string {
  return `${Math.floor(startSecond / 60)}:${String(startSecond % 60).padStart(2, "0")}-${Math.floor(endSecond / 60)}:${String(endSecond % 60).padStart(2, "0")}`;
}

function mapTeamName(team: Team, language: Language): string {
  if (language === "es") return `${team.name}`;
  if (language === "fr") return `${team.name}`;
  return team.name;
}

function buildStories(
  fixture: MatchFixture,
  activeEvents: MatchEvent[],
  request: AnalysisRequest,
  stats: { home: TeamStats; away: TeamStats; score: { home: number; away: number } }
): StoryCard[] {
  const atSecond = request.atSecond;
  const currentWindowStart = Math.max(0, atSecond - 8 * 60);
  const currentWindowEnd = atSecond;
  const currentWindowLabel = formatWindowLabel(currentWindowStart, currentWindowEnd);
  const previousWindowEnd = currentWindowStart - 1;
  const previousWindowStart = Math.max(0, previousWindowEnd - 8 * 60 + 1);
  const currentWindowEvents = rollingWindow(activeEvents, atSecond);
  const previousWindowEvents = previousWindowEnd >= 0 ? eventsInRange(activeEvents, previousWindowStart, previousWindowEnd) : [];
  const activeById = new Map(activeEvents.map((event) => [event.id, event]));
  const homeName = mapTeamName(fixture.home, request.language);
  const awayName = mapTeamName(fixture.away, request.language);
  const stories: StoryCard[] = [];
  const passEvents = currentWindowEvents.filter((e) => e.type === "pass");
  if (passEvents.length > 0) {
    const homePasses = passEvents.filter((e) => e.teamId === "home");
    const awayPasses = passEvents.filter((e) => e.teamId === "away");
    const homeCompleted = homePasses.filter((e) => e.outcome === "complete").length;
    const awayCompleted = awayPasses.filter((e) => e.outcome === "complete").length;
    const homeAccuracy = homePasses.length > 0 ? Number(((homeCompleted / homePasses.length) * 100).toFixed(2)) : 0;
    const awayAccuracy = awayPasses.length > 0 ? Number(((awayCompleted / awayPasses.length) * 100).toFixed(2)) : 0;
    const teamId = homeAccuracy === awayAccuracy ? undefined : (homeAccuracy > awayAccuracy ? "home" : "away");
    const enAnalyst = `Window ${currentWindowLabel}: ${homeName} completed ${homeCompleted}/${homePasses.length} (${homeAccuracy}%), ${awayName} completed ${awayCompleted}/${awayPasses.length} (${awayAccuracy}%)${homeAccuracy === awayAccuracy ? " (tied accuracy)." : "."}`;
    const esAnalyst = `Ventana ${currentWindowLabel}: ${homeName} completó ${homeCompleted}/${homePasses.length} (${homeAccuracy}%), ${awayName} completó ${awayCompleted}/${awayPasses.length} (${awayAccuracy}%)${homeAccuracy === awayAccuracy ? " (empate de precisión)." : "."}`;
    const frAnalyst = `Fenêtre ${currentWindowLabel} : ${homeName} a réussi ${homeCompleted}/${homePasses.length} (${homeAccuracy} %), ${awayName} a réussi ${awayCompleted}/${awayPasses.length} (${awayAccuracy} %)${homeAccuracy === awayAccuracy ? " (égalité de précision)." : "."}`;
    const ptAnalyst = `Janela ${currentWindowLabel}: ${homeName} acertou ${homeCompleted}/${homePasses.length} (${homeAccuracy}%), ${awayName} acertou ${awayCompleted}/${awayPasses.length} (${awayAccuracy}%)${homeAccuracy === awayAccuracy ? " (precisão empatada)." : "."}`;
    stories.push(
      localizedStory(
        "passing-window",
        "rhythm",
        request.language,
        request.persona,
        90,
        passEvents.map((e) => e.id),
        [
          { label: tr(request.language, "metricPassesHome"), value: homeCompleted, unit: `/${homePasses.length}` },
          { label: tr(request.language, "metricPassesAway"), value: awayCompleted, unit: `/${awayPasses.length}` },
          { label: `${homeName} ${tr(request.language, "metricPassAccuracy")}`, value: homeAccuracy, unit: "%" },
          { label: `${awayName} ${tr(request.language, "metricPassAccuracy")}`, value: awayAccuracy, unit: "%" }
        ],
        currentWindowStart,
        currentWindowEnd,
        teamId,
        {
          en: {
            title: "Passing completion in current window",
            analyst: enAnalyst,
            casual: enAnalyst,
            player: enAnalyst,
            whyA: "Counts are direct pass outcomes in the stated window.",
            whyC: "This only reports observed completion volume and ratio.",
            whyP: "Use these counts as feed facts, not tactical inference."
          },
          es: {
            title: "Completitud de pase en ventana actual",
            analyst: esAnalyst,
            casual: esAnalyst,
            player: esAnalyst,
            whyA: "Los conteos salen de resultados directos de pase en la ventana indicada.",
            whyC: "Solo reporta volumen y ratio observados.",
            whyP: "Úsalo como dato del feed, no como inferencia táctica."
          },
          fr: {
            title: "Réussite de passe sur la fenêtre actuelle",
            analyst: frAnalyst,
            casual: frAnalyst,
            player: frAnalyst,
            whyA: "Les comptes proviennent des issues de passe dans la fenêtre indiquée.",
            whyC: "Cela décrit uniquement volume et ratio observés.",
            whyP: "À utiliser comme fait du flux, sans hypothèse tactique."
          },
          pt: {
            title: "Acerto de passe na janela atual",
            analyst: ptAnalyst,
            casual: ptAnalyst,
            player: ptAnalyst,
            whyA: "As contagens vêm direto do resultado dos passes na janela indicada.",
            whyC: "Mostra apenas volume e percentual observados.",
            whyP: "Use como dado do feed, não como leitura tática."
          }
        },
        "observed"
      )
    );
  }

  const pressureHome = currentWindowEvents.filter((e) => e.type === "pressure" && e.teamId === "home");
  const pressureAway = currentWindowEvents.filter((e) => e.type === "pressure" && e.teamId === "away");
  const pressureEvents = [...pressureHome, ...pressureAway];
  if (pressureEvents.length > 0) {
    const pressureSummaryEn =
      pressureHome.length === pressureAway.length
        ? `Window ${currentWindowLabel}: pressure events are tied ${pressureHome.length}-${pressureAway.length}.`
        : `Window ${currentWindowLabel}: pressure events are ${pressureHome.length}-${pressureAway.length} (${homeName}-${awayName}).`;
    const pressureSummaryEs =
      pressureHome.length === pressureAway.length
        ? `Ventana ${currentWindowLabel}: presión empatada ${pressureHome.length}-${pressureAway.length}.`
        : `Ventana ${currentWindowLabel}: presión ${pressureHome.length}-${pressureAway.length} (${homeName}-${awayName}).`;
    const pressureSummaryFr =
      pressureHome.length === pressureAway.length
        ? `Fenêtre ${currentWindowLabel} : pressing à égalité ${pressureHome.length}-${pressureAway.length}.`
        : `Fenêtre ${currentWindowLabel} : pressing ${pressureHome.length}-${pressureAway.length} (${homeName}-${awayName}).`;
    const pressureSummaryPt =
      pressureHome.length === pressureAway.length
        ? `Janela ${currentWindowLabel}: pressão empatada em ${pressureHome.length}-${pressureAway.length}.`
        : `Janela ${currentWindowLabel}: pressão ${pressureHome.length}-${pressureAway.length} (${homeName}-${awayName}).`;
    stories.push(
      localizedStory(
        "pressure-window",
        "pressure",
        request.language,
        request.persona,
        86,
        pressureEvents.map((e) => e.id),
        [
          { label: tr(request.language, "metricPressureHome"), value: pressureHome.length, unit: "events" },
          { label: tr(request.language, "metricPressureAway"), value: pressureAway.length, unit: "events" },
          { label: tr(request.language, "metricPressure"), value: pressureEvents.length, unit: "events" }
        ],
        currentWindowStart,
        currentWindowEnd,
        undefined,
        {
          en: {
            title: "Pressure counts in current window",
            analyst: pressureSummaryEn,
            casual: pressureSummaryEn,
            player: pressureSummaryEn,
            whyA: "Only pressure-type events are counted.",
            whyC: "This separates pressure from passes and shots.",
            whyP: "Treat as event-count context in the same time slice."
          },
          es: {
            title: "Conteo de presión en ventana actual",
            analyst: pressureSummaryEs,
            casual: pressureSummaryEs,
            player: pressureSummaryEs,
            whyA: "Solo se cuentan eventos de tipo presión.",
            whyC: "Esto separa presión de pases y tiros.",
            whyP: "Tómalo como contexto de conteo en la misma ventana."
          },
          fr: {
            title: "Comptage du pressing sur la fenêtre actuelle",
            analyst: pressureSummaryFr,
            casual: pressureSummaryFr,
            player: pressureSummaryFr,
            whyA: "Seuls les événements de type pressing sont comptés.",
            whyC: "Le pressing est séparé des passes et tirs.",
            whyP: "À lire comme contexte de comptage sur la même fenêtre."
          },
          pt: {
            title: "Contagem de pressão na janela atual",
            analyst: pressureSummaryPt,
            casual: pressureSummaryPt,
            player: pressureSummaryPt,
            whyA: "Só entram eventos do tipo pressão.",
            whyC: "Isso separa a pressão dos passes e finalizações.",
            whyP: "Leia como contexto de contagem na mesma janela."
          }
        },
        "observed"
      )
    );
  }

  const allSetPiecePairs = activeEvents
    .filter((e) => e.type === "shot" && e.relatedEventId)
    .map((shot) => ({ shot, corner: activeById.get(shot.relatedEventId ?? "") }))
    .filter((pair): pair is { shot: MatchEvent; corner: MatchEvent } => Boolean(pair.corner && pair.corner.type === "corner"))
    .filter((pair) => {
      const cornerSecond = eventSecond(pair.corner);
      return cornerSecond <= atSecond;
    });
  const setPiecePairs = allSetPiecePairs.filter((pair) => {
    const cornerSecond = eventSecond(pair.corner);
    return cornerSecond >= currentWindowStart && cornerSecond <= currentWindowEnd;
  });
  if (setPiecePairs.length > 0) {
    const homeLinks = setPiecePairs.filter((pair) => pair.shot.teamId === "home").length;
    const awayLinks = setPiecePairs.filter((pair) => pair.shot.teamId === "away").length;
    const evidenceIds = new Set(setPiecePairs.flatMap((pair) => [pair.corner.id, pair.shot.id]));
    const homeLinksSoFar = allSetPiecePairs.filter((pair) => pair.shot.teamId === "home");
    const awayLinksSoFar = allSetPiecePairs.filter((pair) => pair.shot.teamId === "away");
    const homeCornersSoFar = activeEvents.filter((event) => event.type === "corner" && event.teamId === "home").length;
    const awayCornersSoFar = activeEvents.filter((event) => event.type === "corner" && event.teamId === "away").length;
    let radarCueEn = "";
    let radarCueEs = "";
    let radarCueFr = "";
    let radarCuePt = "";
    const radarTeamId = homeLinksSoFar.length >= 2 && homeLinksSoFar.length >= awayLinksSoFar.length
      ? "home"
      : awayLinksSoFar.length >= 2 ? "away" : undefined;
    if (radarTeamId) {
      const radarPairs = radarTeamId === "home" ? homeLinksSoFar : awayLinksSoFar;
      const cornerCount = radarTeamId === "home" ? homeCornersSoFar : awayCornersSoFar;
      const teamName = radarTeamId === "home" ? homeName : awayName;
      radarCueEn = ` Watch ${teamName}'s next corner: ${radarPairs.length} of their ${cornerCount} corners so far led directly to a shot.`;
      radarCueEs = ` Vigila el próximo córner de ${teamName}: ${radarPairs.length} de sus ${cornerCount} córners hasta ahora terminaron directamente en un tiro.`;
      radarCueFr = ` Surveillez le prochain corner de ${teamName} : ${radarPairs.length} de leurs ${cornerCount} corners jusque-là ont mené directement à un tir.`;
      radarCuePt = ` Fique de olho no próximo escanteio do ${teamName}: ${radarPairs.length} dos ${cornerCount} escanteios até aqui terminaram direto em finalização.`;
      for (const pair of radarPairs) {
        evidenceIds.add(pair.corner.id);
        evidenceIds.add(pair.shot.id);
      }
    }
    const setPieceSummaryEn =
      homeLinks === awayLinks
        ? `Window ${currentWindowLabel}: corner-shot links are tied at ${homeLinks}-${awayLinks}.${radarCueEn}`
        : `Window ${currentWindowLabel}: corner-shot links are ${homeLinks}-${awayLinks} (${homeName}-${awayName}).${radarCueEn}`;
    const setPieceSummaryEs =
      homeLinks === awayLinks
        ? `Ventana ${currentWindowLabel}: enlaces córner-tiro empatados ${homeLinks}-${awayLinks}.${radarCueEs}`
        : `Ventana ${currentWindowLabel}: enlaces córner-tiro ${homeLinks}-${awayLinks} (${homeName}-${awayName}).${radarCueEs}`;
    const setPieceSummaryFr =
      homeLinks === awayLinks
        ? `Fenêtre ${currentWindowLabel} : liens corner-tir à égalité ${homeLinks}-${awayLinks}.${radarCueFr}`
        : `Fenêtre ${currentWindowLabel} : liens corner-tir ${homeLinks}-${awayLinks} (${homeName}-${awayName}).${radarCueFr}`;
    const setPieceSummaryPt =
      homeLinks === awayLinks
        ? `Janela ${currentWindowLabel}: escanteios que viraram finalização empatados em ${homeLinks}-${awayLinks}.${radarCuePt}`
        : `Janela ${currentWindowLabel}: escanteios que viraram finalização ${homeLinks}-${awayLinks} (${homeName}-${awayName}).${radarCuePt}`;
    stories.push(
      localizedStory(
        "setpiece-pattern",
        "set_piece",
        request.language,
        request.persona,
        80,
        [...evidenceIds],
        [
          { label: tr(request.language, "metricSetPieceLinksHome"), value: homeLinks, unit: "links" },
          { label: tr(request.language, "metricSetPieceLinksAway"), value: awayLinks, unit: "links" },
          { label: tr(request.language, "metricSetPieceLinks"), value: setPiecePairs.length, unit: "links" },
          { label: tr(request.language, "metricSetPieces"), value: setPiecePairs.length, unit: "corners" }
        ],
        currentWindowStart,
        currentWindowEnd,
        undefined,
        {
          en: {
            title: "Corner to shot links in current window",
            analyst: setPieceSummaryEn,
            casual: setPieceSummaryEn,
            player: setPieceSummaryEn,
            whyA: "Evidence includes both the corner and its directly linked shot.",
            whyC: "Only links inside the declared window are counted.",
            whyP: "This card reports observed restart-to-shot sequences only."
          },
          es: {
            title: "Enlaces córner a tiro en ventana actual",
            analyst: setPieceSummaryEs,
            casual: setPieceSummaryEs,
            player: setPieceSummaryEs,
            whyA: "La evidencia incluye córner y tiro enlazado de forma directa.",
            whyC: "Solo se cuentan enlaces dentro de la ventana declarada.",
            whyP: "La tarjeta reporta secuencias observadas córner→tiro."
          },
          fr: {
            title: "Liens corner vers tir sur la fenêtre actuelle",
            analyst: setPieceSummaryFr,
            casual: setPieceSummaryFr,
            player: setPieceSummaryFr,
            whyA: "La preuve contient le corner et le tir directement lié.",
            whyC: "Seuls les liens dans la fenêtre déclarée sont comptés.",
            whyP: "Cette carte décrit uniquement des séquences corner→tir observées."
          },
          pt: {
            title: "Escanteio para finalização na janela atual",
            analyst: setPieceSummaryPt,
            casual: setPieceSummaryPt,
            player: setPieceSummaryPt,
            whyA: "A evidência inclui o escanteio e a finalização ligada a ele.",
            whyC: "Só contam ligações dentro da janela declarada.",
            whyP: "O card mostra apenas sequências escanteio→finalização observadas."
          }
        },
        "observed"
      )
    );
  }

  const turningPoints = activeEvents.filter((e) => (e.type === "goal" && !e.rescinded) || e.type === "red_card");
  if (turningPoints.length > 0) {
    const goals = turningPoints.filter((e) => e.type === "goal").length;
    const reds = turningPoints.filter((e) => e.type === "red_card").length;
    const turningSummaryEn = `By ${formatWindowLabel(0, atSecond)}, active goals: ${goals}, red cards: ${reds}, score ${stats.score.home}-${stats.score.away}.`;
    const turningSummaryEs = `Hasta ${formatWindowLabel(0, atSecond)}, goles vigentes: ${goals}, rojas: ${reds}, marcador ${stats.score.home}-${stats.score.away}.`;
    const turningSummaryFr = `À ${formatWindowLabel(0, atSecond)}, buts actifs : ${goals}, rouges : ${reds}, score ${stats.score.home}-${stats.score.away}.`;
    const turningSummaryPt = `Até ${formatWindowLabel(0, atSecond)}, gols válidos: ${goals}, cartões vermelhos: ${reds}, placar ${stats.score.home}-${stats.score.away}.`;
    stories.push(
      localizedStory(
        "turning-points",
        "turning_point",
        request.language,
        request.persona,
        84,
        turningPoints.map((e) => e.id),
        [
          { label: tr(request.language, "metricGoals"), value: goals, unit: "goals" },
          { label: tr(request.language, "metricCards"), value: reds, unit: "reds" },
          { label: tr(request.language, "metricScoreEvents"), value: turningPoints.length, unit: "events" }
        ],
        0,
        atSecond,
        undefined,
        {
          en: {
            title: "Goals and red cards ledger",
            analyst: turningSummaryEn,
            casual: turningSummaryEn,
            player: turningSummaryEn,
            whyA: "This list includes only active goals and red cards.",
            whyC: "It is a factual state ledger with explicit counts.",
            whyP: "Use it to verify state changes already recorded."
          },
          es: {
            title: "Registro de goles y rojas",
            analyst: turningSummaryEs,
            casual: turningSummaryEs,
            player: turningSummaryEs,
            whyA: "La lista incluye solo goles vigentes y rojas.",
            whyC: "Es un registro factual con conteos explícitos.",
            whyP: "Sirve para verificar cambios ya registrados."
          },
          fr: {
            title: "Registre des buts et rouges",
            analyst: turningSummaryFr,
            casual: turningSummaryFr,
            player: turningSummaryFr,
            whyA: "La liste contient uniquement buts actifs et rouges.",
            whyC: "C'est un registre factuel avec comptes explicites.",
            whyP: "Utile pour vérifier les changements déjà actés."
          },
          pt: {
            title: "Registro de gols e cartões vermelhos",
            analyst: turningSummaryPt,
            casual: turningSummaryPt,
            player: turningSummaryPt,
            whyA: "A lista inclui apenas gols válidos e cartões vermelhos.",
            whyC: "É um registro factual com contagens explícitas.",
            whyP: "Serve para conferir mudanças já registradas."
          }
        },
        "observed"
      )
    );
  }

  const favoriteId = request.favoritePlayerId;
  const fallbackPlayer = activeEvents.filter((e) => e.type === "shot" || e.type === "pass").slice(-1)[0];
  const playerId = favoriteId ?? fallbackPlayer?.playerId;
  if (playerId) {
    const player = [...fixture.home.players, ...fixture.away.players].find((entry) => entry.id === playerId);
    if (!player) throw new Error("Fixture event references an unknown player");
    const playerWindow = formatWindowLabel(0, atSecond);
    const playerEvents = activeEvents.filter((e) =>
      e.playerId === playerId && !["kickoff", "halftime", "fulltime"].includes(e.type));
    const playerTeamId = playerEvents[0]?.teamId;
    stories.push(
      localizedStory(
        "player-focus",
        "player",
        request.language,
        request.persona,
        78,
        playerEvents.map((e) => e.id),
        [{ label: tr(request.language, "metricTouches"), value: playerEvents.length, unit: "events" }],
        0,
        atSecond,
        playerTeamId,
        {
          en: {
            title: favoriteId ? "Favorite player involvement" : "Player involvement spotlight",
            analyst: `${player.name} has ${playerEvents.length} logged actions in ${playerWindow}.`,
            casual: `${player.name} has appeared in ${playerEvents.length} match events so far.`,
            player: `Following ${player.name}: ${playerEvents.length} directly recorded actions so far.`,
            whyA: "Only direct event participation is counted.",
            whyC: "This avoids claims about movement that is not observed.",
            whyP: "Use it as a concrete involvement check."
          },
          es: {
            title: "Participación del jugador favorito",
            analyst: `${player.name}: ${playerEvents.length} acciones registradas en ${playerWindow}.`,
            casual: `${player.name} aparece en ${playerEvents.length} eventos del partido.`,
            player: `Siguiendo a ${player.name}: ${playerEvents.length} acciones registradas.`,
            whyA: "Solo se cuenta participación directa en eventos.",
            whyC: "Así se evita inferir movimientos no observados.",
            whyP: "Úsalo como control concreto de participación."
          },
          fr: {
            title: "Implication du joueur suivi",
            analyst: `${player.name} : ${playerEvents.length} actions enregistrées entre ${playerWindow}.`,
            casual: `${player.name} apparaît dans ${playerEvents.length} événements du match.`,
            player: `Suivi de ${player.name} : ${playerEvents.length} actions enregistrées.`,
            whyA: "Seules les participations directes sont comptées.",
            whyC: "On évite ainsi les hypothèses hors observation.",
            whyP: "Utilise-le comme vérification concrète d'implication."
          },
          pt: {
            title: favoriteId ? "Participação do jogador favorito" : "Destaque de participação",
            analyst: `${player.name}: ${playerEvents.length} ações registradas em ${playerWindow}.`,
            casual: `${player.name} já apareceu em ${playerEvents.length} lances da partida.`,
            player: `Acompanhando ${player.name}: ${playerEvents.length} ações registradas até agora.`,
            whyA: "Só conta participação direta nos eventos.",
            whyC: "Assim evitamos afirmar movimentos não observados.",
            whyP: "Use como checagem concreta de participação."
          }
        },
        "observed"
      )
    );
  }

  const currentShots = currentWindowEvents.filter((e) => e.type === "shot");
  const previousShots = previousWindowEvents.filter((e) => e.type === "shot");
  if (previousWindowEnd >= 0 && currentShots.length !== previousShots.length) {
    const directionKey = currentShots.length > previousShots.length ? "increase" : "decrease";
    const trendSummaryEn = `Shots ${directionKey}: previous window ${previousShots.length}, current window ${currentShots.length}.`;
    const trendSummaryEs = `Tiros en ${directionKey === "increase" ? "aumento" : "descenso"}: ventana previa ${previousShots.length}, ventana actual ${currentShots.length}.`;
    const trendSummaryFr = `Tirs en ${directionKey === "increase" ? "hausse" : "baisse"} : fenêtre précédente ${previousShots.length}, fenêtre actuelle ${currentShots.length}.`;
    const trendSummaryPt = `Finalizações em ${directionKey === "increase" ? "alta" : "queda"}: janela anterior ${previousShots.length}, janela atual ${currentShots.length}.`;
    stories.push(
      localizedStory(
        "shot-rhythm-delta",
        "rhythm",
        request.language,
        request.persona,
        74,
        [...previousShots, ...currentShots].map((e) => e.id),
        [
          { label: tr(request.language, "metricShotsPrevious"), value: previousShots.length, unit: "shots" },
          { label: tr(request.language, "metricShotsCurrent"), value: currentShots.length, unit: "shots" }
        ],
        previousWindowStart,
        currentWindowEnd,
        undefined,
        {
          en: {
            title: "Shot count change across adjacent windows",
            analyst: trendSummaryEn,
            casual: trendSummaryEn,
            player: trendSummaryEn,
            whyA: "This is inferred from count comparison between two adjacent 8-minute windows.",
            whyC: "No causal mechanism is asserted.",
            whyP: "Use as a directional signal only."
          },
          es: {
            title: "Cambio de tiros entre ventanas contiguas",
            analyst: trendSummaryEs,
            casual: trendSummaryEs,
            player: trendSummaryEs,
            whyA: "Se infiere por comparación de conteos entre dos ventanas de 8 minutos.",
            whyC: "No se afirma mecanismo causal.",
            whyP: "Úsalo solo como señal direccional."
          },
          fr: {
            title: "Variation des tirs entre fenêtres adjacentes",
            analyst: trendSummaryFr,
            casual: trendSummaryFr,
            player: trendSummaryFr,
            whyA: "L'inférence vient d'une comparaison de comptes sur deux fenêtres de 8 minutes.",
            whyC: "Aucun mécanisme causal n'est affirmé.",
            whyP: "À utiliser comme signal directionnel uniquement."
          },
          pt: {
            title: "Variação de finalizações entre janelas vizinhas",
            analyst: trendSummaryPt,
            casual: trendSummaryPt,
            player: trendSummaryPt,
            whyA: "Inferido pela comparação de contagens entre duas janelas de 8 minutos.",
            whyC: "Nenhuma causa é afirmada.",
            whyP: "Use apenas como sinal de direção."
          }
        },
        "inferred"
      )
    );
  }

  const attackingEvidence = activeEvents.filter((e) => e.type === "shot" || e.type === "goal" || e.type === "corner");
  if (stories.length === 0 || attackingEvidence.length === 0) {
    const kickoffEvidence = activeEvents.filter((e) => e.type === "kickoff").map((e) => e.id);
    const neutralSummaryEn = kickoffEvidence.length > 0 ? "Kickoff logged; no attacking evidence in the feed yet." : "Feed started; no attacking evidence in the feed yet.";
    const neutralSummaryEs = kickoffEvidence.length > 0 ? "Saque inicial registrado; sin evidencia de ataque todavía." : "Feed iniciado; sin evidencia de ataque todavía.";
    const neutralSummaryFr = kickoffEvidence.length > 0 ? "Coup d'envoi enregistré ; aucune preuve d'attaque pour l'instant." : "Flux démarré ; aucune preuve d'attaque pour l'instant.";
    const neutralSummaryPt = kickoffEvidence.length > 0 ? "Pontapé inicial registrado; ainda sem lances de ataque no feed." : "Feed iniciado; ainda sem lances de ataque no feed.";
    stories.push(
      localizedStory(
        "early-feed",
        "turning_point",
        request.language,
        request.persona,
        70,
        kickoffEvidence,
        [],
        0,
        atSecond,
        undefined,
        {
          en: {
            title: "Neutral early-state check",
            analyst: neutralSummaryEn,
            casual: neutralSummaryEn,
            player: neutralSummaryEn,
            whyA: "No attacking events are available to support stronger claims.",
            whyC: "This prevents unsupported superiority narratives.",
            whyP: "Wait for attacking evidence before drawing trend conclusions."
          },
          es: {
            title: "Chequeo neutral de estado temprano",
            analyst: neutralSummaryEs,
            casual: neutralSummaryEs,
            player: neutralSummaryEs,
            whyA: "No hay eventos de ataque para sostener afirmaciones más fuertes.",
            whyC: "Evita narrativas de superioridad no respaldadas.",
            whyP: "Espera evidencia de ataque antes de concluir tendencias."
          },
          fr: {
            title: "Contrôle neutre d'état précoce",
            analyst: neutralSummaryFr,
            casual: neutralSummaryFr,
            player: neutralSummaryFr,
            whyA: "Aucun événement offensif ne permet d'étayer des affirmations plus fortes.",
            whyC: "Cela évite les récits de supériorité non prouvés.",
            whyP: "Attendre des preuves offensives avant d'inférer une tendance."
          },
          pt: {
            title: "Checagem neutra do início",
            analyst: neutralSummaryPt,
            casual: neutralSummaryPt,
            player: neutralSummaryPt,
            whyA: "Não há lances de ataque para sustentar afirmações mais fortes.",
            whyC: "Isso evita narrativas de superioridade sem base.",
            whyP: "Espere evidência de ataque antes de tirar conclusões."
          }
        },
        "observed"
      )
    );
  }

  return stories
    .filter((story) => story.evidenceIds.every((id) => activeById.has(id)))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 7);
}

function buildEvidence(activeEvents: MatchEvent[]): Record<string, MatchEvent> {
  const out: Record<string, MatchEvent> = {};
  for (const evt of activeEvents) out[evt.id] = { ...evt };
  return out;
}

function computeStateVersion(events: MatchEvent[], request: AnalysisRequest): string {
  const canonical = events.map((evt) => `${evt.id}@${evt.revision}${evt.rescinded ? ":x" : ""}`).join("|");
  const payload = `${canonical}::${request.atSecond}::${request.persona}::${request.language}::${request.favoritePlayerId ?? ""}::${request.correction ? "1" : "0"}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function analyzeFixture(fixture: MatchFixture, request: AnalysisRequest): MatchSnapshot {
  assertRequest(request, fixture);
  const ingested = fixture.events.filter((evt) => eventSecond(evt) <= request.atSecond);
  const { activeEvents, corrections } = reconcileEvents(ingested, fixture, request.atSecond, Boolean(request.correction));

  const localizedCorrections = corrections.map((c) => ({
    ...c,
    message: `${tr(request.language, "correctionNotice")} (${c.eventId})`
  }));
  const stats = computeStats(activeEvents);
  const stories = buildStories(fixture, activeEvents, request, stats);
  const recentEvents = sortEventsStable(activeEvents).filter((evt) => !evt.rescinded).slice(-20).map((evt) => ({ ...evt }));
  const evidence = buildEvidence(activeEvents);
  const allStoryRefs = stories.flatMap((story) => story.evidenceIds);
  const validStoryRefs = allStoryRefs.filter((id) => {
    const event = evidence[id];
    return Boolean(event && !event.rescinded);
  });
  const evidenceCoverage = allStoryRefs.length === 0 ? 0 : Number(((validStoryRefs.length / allStoryRefs.length) * 100).toFixed(2));

  return {
    fixtureId: fixture.id,
    atSecond: request.atSecond,
    stateVersion: computeStateVersion(activeEvents, request),
    persona: request.persona,
    language: request.language,
    score: stats.score,
    stats: { home: stats.home, away: stats.away },
    stories,
    recentEvents,
    evidence,
    corrections: localizedCorrections,
    eventCount: activeEvents.length,
    evidenceCoverage,
    synthetic: true
  };
}

export function analyzeMatch(request: AnalysisRequest): MatchSnapshot {
  const fixture = getFixture(request.fixtureId);
  return analyzeFixture(fixture, request);
}
