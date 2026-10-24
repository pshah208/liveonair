import type { AnalysisRequest, Language, MatchEvent, MatchFixture, Persona, StoryCard, StoryMetric, TeamId } from "../shared/types.js";
import {
  fastestShot,
  metricOptions,
  passQualities,
  playerTags,
  SHOT_SPEED_THRESHOLD_KMH,
  TOP_SPEED_THRESHOLD_KMH,
  DISTANCE_MILESTONE_M,
  HARD_PASS_THRESHOLD,
  type DifficultyFactor,
  type PlayerTag,
} from "../shared/metrics.js";

/**
 * Story cards for ball and player metrics (hardest pass, fastest shot, threshold crossings). Every card is scoped
 * to the events and clock window it is given, so a half-scoped snapshot only ever reports that half.
 */

type Localized = Record<Language, string>;
const L = (en: string, es: string, fr: string, pt: string): Localized => ({ en, es, fr, pt });

const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const RECENT_WINDOW_SECONDS = 8 * 60;

function titleFor(language: Language, base: string): string {
  if (language === "es") return `Resumen: ${base}`;
  if (language === "fr") return `Synthèse: ${base}`;
  if (language === "pt") return `Resumo: ${base}`;
  return base;
}

function pick(persona: Persona, analyst: Localized, casual: Localized, player: Localized, language: Language): string {
  return (persona === "casual" ? casual : persona === "player" ? player : analyst)[language];
}

function scopeLabel(period: AnalysisRequest["period"], language: Language): string {
  const labels: Record<"full" | "first" | "second", Localized> = {
    full: L("so far", "hasta ahora", "jusqu'ici", "até aqui"),
    first: L("in the first half", "en la primera parte", "en première période", "no primeiro tempo"),
    second: L("in the second half", "en la segunda parte", "en seconde période", "no segundo tempo"),
  };
  return labels[period ?? "full"][language];
}

const FACTOR_LABEL: Record<DifficultyFactor["key"], Localized> = {
  distance: L("distance", "distancia", "distance", "distância"),
  forward: L("forward progress", "avance vertical", "progression", "progressão"),
  final_third: L("final third", "último tercio", "dernier tiers", "terço final"),
  box: L("into the box", "al área", "dans la surface", "na área"),
  pressure: L("under pressure", "bajo presión", "sous pression", "sob pressão"),
  switch: L("switch of play", "cambio de orientación", "renversement", "inversão de jogo"),
  cross: L("cross", "centro", "centre", "cruzamento"),
  set_piece: L("set piece", "balón parado", "coup de pied arrêté", "bola parada"),
};

function card(id: string, request: AnalysisRequest, importance: number, title: Localized, summary: string, why: string,
  evidenceIds: string[], metrics: StoryMetric[], window: { start: number; end: number }, teamId: TeamId | undefined, confidence: StoryCard["confidence"]): StoryCard {
  return {
    id,
    kind: "player",
    title: titleFor(request.language, title[request.language]),
    summary,
    whyItMatters: why,
    evidenceIds,
    metrics,
    confidence,
    importance,
    windowStart: window.start,
    windowEnd: window.end,
    ...(teamId ? { teamId } : {}),
  };
}

export function tagText(tag: PlayerTag, language: Language): string {
  const minute = `${Math.floor(tag.atSecond / 60)}'`;
  switch (tag.metric) {
    case "shot_speed":
      return L(`${tag.name}: ${tag.value} km/h shot (${minute})`, `${tag.name}: tiro a ${tag.value} km/h (${minute})`, `${tag.name} : frappe à ${tag.value} km/h (${minute})`, `${tag.name}: chute a ${tag.value} km/h (${minute})`)[language];
    case "top_speed":
      return L(`${tag.name}: top speed ${tag.value} km/h (${minute})`, `${tag.name}: velocidad punta ${tag.value} km/h (${minute})`, `${tag.name} : pointe à ${tag.value} km/h (${minute})`, `${tag.name}: velocidade máxima ${tag.value} km/h (${minute})`)[language];
    case "distance":
      return L(`${tag.name}: passed ${tag.value} km (${minute})`, `${tag.name}: superó ${tag.value} km (${minute})`, `${tag.name} : a dépassé ${tag.value} km (${minute})`, `${tag.name}: passou de ${tag.value} km (${minute})`)[language];
    case "pass_difficulty":
      return L(`${tag.name}: completed a ${tag.value}/100 pass (${minute})`, `${tag.name}: completó un pase de dificultad ${tag.value}/100 (${minute})`, `${tag.name} : passe réussie de difficulté ${tag.value}/100 (${minute})`, `${tag.name}: acertou passe de dificuldade ${tag.value}/100 (${minute})`)[language];
  }
}

/**
 * Builds the metric story cards for the scoped events. `window.end` is the analysed clock; tracking samples are
 * scoped by the request period.
 */
export function buildMetricStories(fixture: MatchFixture, activeEvents: MatchEvent[], request: AnalysisRequest, window: { start: number; end: number }): StoryCard[] {
  const options = metricOptions(fixture);
  if (options.camera) return [];
  const language = request.language;
  const persona = request.persona;
  const scope = scopeLabel(request.period, language);
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  const teamName = (teamId: TeamId) => (teamId === "home" ? fixture.home.name : fixture.away.name);
  const live = activeEvents.filter((event) => !event.rescinded && secondOf(event) <= window.end);
  const stories: StoryCard[] = [];

  const hardest = passQualities(live, options)
    .filter((pass) => pass.completed)
    .sort((a, b) => b.difficulty.score - a.difficulty.score || secondOf(a.event) - secondOf(b.event) || a.event.id.localeCompare(b.event.id))[0];
  if (hardest) {
    const name = players.get(hardest.event.playerId)?.name ?? hardest.event.playerId;
    const team = teamName(hardest.event.teamId);
    const score = hardest.difficulty.score;
    const metres = Math.round(hardest.distanceM);
    const expected = Math.round(hardest.expected * 100);
    const minute = `${hardest.event.minute}'`;
    const factors = hardest.difficulty.factors.map((factor) => FACTOR_LABEL[factor.key][language]).join(", ");
    stories.push(card(
      "hardest-pass", request, 77,
      L("Hardest completed pass", "Pase más difícil completado", "Passe la plus difficile réussie", "Passe mais difícil completado"),
      pick(persona,
        L(`${name} (${team}) completed the hardest pass ${scope}: difficulty ${score}/100, ${metres} m at ${minute}, expected completion ${expected}%. Factors: ${factors}.`,
          `${name} (${team}) completó el pase más difícil ${scope}: dificultad ${score}/100, ${metres} m en el ${minute}, acierto esperado ${expected}%. Factores: ${factors}.`,
          `${name} (${team}) a réussi la passe la plus difficile ${scope} : difficulté ${score}/100, ${metres} m à la ${minute}, réussite attendue ${expected} %. Facteurs : ${factors}.`,
          `${name} (${team}) acertou o passe mais difícil ${scope}: dificuldade ${score}/100, ${metres} m aos ${minute}, acerto esperado ${expected}%. Fatores: ${factors}.`),
        L(`${name}'s ${metres}-metre pass at ${minute} was the toughest one completed ${scope} (${score}/100).`,
          `El pase de ${metres} metros de ${name} en el ${minute} fue el más difícil completado ${scope} (${score}/100).`,
          `La passe de ${metres} mètres de ${name} à la ${minute} est la plus difficile réussie ${scope} (${score}/100).`,
          `O passe de ${metres} metros de ${name} aos ${minute} foi o mais difícil completado ${scope} (${score}/100).`),
        L(`${name}: hardest completed pass ${scope}, ${score}/100 over ${metres} m. It beat a ${expected}% expected completion: ${factors}.`,
          `${name}: pase más difícil completado ${scope}, ${score}/100 en ${metres} m, frente a un ${expected}% esperado: ${factors}.`,
          `${name} : passe la plus difficile réussie ${scope}, ${score}/100 sur ${metres} m, pour ${expected} % attendus : ${factors}.`,
          `${name}: passe mais difícil completado ${scope}, ${score}/100 em ${metres} m, contra ${expected}% esperado: ${factors}.`),
        language),
      pick(persona,
        L("Difficulty is a published formula (distance, forward progress, destination, pressure, switch, cross); the event's own coordinates and outcome are observed.",
          "La dificultad sigue una fórmula publicada (distancia, avance, destino, presión, cambio, centro); coordenadas y resultado son observados.",
          "La difficulté suit une formule publiée (distance, progression, destination, pression, renversement, centre) ; coordonnées et issue sont observées.",
          "A dificuldade segue uma fórmula publicada (distância, progressão, destino, pressão, inversão, cruzamento); coordenadas e resultado são observados."),
        L("Long, forward, pressured passes are the hardest to complete.", "Los pases largos, verticales y bajo presión son los más difíciles.", "Les passes longues, verticales et sous pression sont les plus dures.", "Passes longos, verticais e sob pressão são os mais difíceis."),
        L("Use it to spot who takes on risk in possession.", "Sirve para ver quién asume riesgo con balón.", "Utile pour voir qui prend des risques balle au pied.", "Mostra quem assume risco com a bola."),
        language),
      [hardest.event.id],
      [
        { label: L("Pass difficulty", "Dificultad del pase", "Difficulté de passe", "Dificuldade do passe")[language], value: score, unit: "/100" },
        { label: L("Pass distance", "Distancia del pase", "Distance de passe", "Distância do passe")[language], value: hardest.distanceM, unit: "m" },
        { label: L("Expected completion", "Acierto esperado", "Réussite attendue", "Acerto esperado")[language], value: expected, unit: "%" },
      ],
      { start: window.start, end: window.end }, hardest.event.teamId, "inferred",
    ));
  }

  const fastest = fastestShot(live, options);
  if (fastest) {
    const name = players.get(fastest.event.playerId)?.name ?? fastest.event.playerId;
    const speed = Math.round(fastest.speedKmh);
    const minute = `${fastest.event.minute}'`;
    stories.push(card(
      "fastest-shot", request, 76,
      L("Fastest shot", "Tiro más rápido", "Frappe la plus rapide", "Chute mais rápido"),
      pick(persona,
        L(`Fastest shot ${scope}: ${name} (${teamName(fastest.event.teamId)}) at ${speed} km/h, ${minute}.`,
          `Tiro más rápido ${scope}: ${name} (${teamName(fastest.event.teamId)}) a ${speed} km/h, ${minute}.`,
          `Frappe la plus rapide ${scope} : ${name} (${teamName(fastest.event.teamId)}) à ${speed} km/h, ${minute}.`,
          `Chute mais rápido ${scope}: ${name} (${teamName(fastest.event.teamId)}) a ${speed} km/h, ${minute}.`),
        L(`${name} struck the hardest shot ${scope}: ${speed} km/h.`, `${name} pegó el tiro más fuerte ${scope}: ${speed} km/h.`, `${name} a frappé le plus fort ${scope} : ${speed} km/h.`, `${name} deu o chute mais forte ${scope}: ${speed} km/h.`),
        L(`${name}: ${speed} km/h strike at ${minute}, the quickest ${scope}.`, `${name}: disparo a ${speed} km/h en el ${minute}, el más rápido ${scope}.`, `${name} : frappe à ${speed} km/h à la ${minute}, la plus rapide ${scope}.`, `${name}: chute a ${speed} km/h aos ${minute}, o mais rápido ${scope}.`),
        language),
      pick(persona,
        L("Speed uses the shot's recorded speed, or goal-distance divided by its own flight time; never the gap between events.", "La velocidad usa el valor registrado del tiro o la distancia a portería dividida por su tiempo de vuelo; nunca el intervalo entre eventos.", "La vitesse utilise la valeur enregistrée du tir ou la distance au but divisée par son temps de vol, jamais l'intervalle entre événements.", "A velocidade usa o valor registrado do chute ou a distância ao gol dividida pelo tempo de voo, nunca o intervalo entre eventos."),
        L("Pace on the ball gives keepers less time to react.", "La potencia deja al portero menos tiempo para reaccionar.", "La puissance laisse moins de temps au gardien.", "A potência dá menos tempo ao goleiro."),
        L("A reference for striking power in this scope.", "Referencia de potencia de golpeo en este tramo.", "Une référence de puissance de frappe sur cette période.", "Referência de potência de chute neste recorte."),
        language),
      [fastest.event.id],
      [{ label: L("Shot speed", "Velocidad del tiro", "Vitesse de frappe", "Velocidade do chute")[language], value: fastest.speedKmh, unit: "km/h" }],
      { start: window.start, end: window.end }, fastest.event.teamId, "observed",
    ));
  }

  const tags = playerTags(fixture, live, window.end, request.period ?? "full").filter((tag) => tag.atSecond >= window.start);
  if (tags.length > 0) {
    // Event-linked and speed alerts outrank routine distance milestones, which every outfielder reaches.
    const priority = (tag: PlayerTag) => (tag.metric === "distance" ? 1 : 0);
    const recentWindowStart = window.end - RECENT_WINDOW_SECONDS;
    const headline = tags.filter((tag) => tag.metric !== "distance");
    const recentHeadline = headline.filter((tag) => tag.atSecond >= recentWindowStart);
    const ranked = [...(recentHeadline.length > 0 ? recentHeadline : tags)]
      .sort((a, b) => priority(a) - priority(b) || b.atSecond - a.atSecond || a.playerId.localeCompare(b.playerId))
      .slice(0, 3)
      .sort((a, b) => a.atSecond - b.atSecond || a.playerId.localeCompare(b.playerId));
    const listed = ranked.map((tag) => tagText(tag, language)).join("; ");
    const count = (metric: PlayerTag["metric"]) => tags.filter((tag) => tag.metric === metric).length;
    const eventIds = [...new Set(tags.flatMap((tag) => (tag.eventId ? [tag.eventId] : [])))];
    const thresholds = `${SHOT_SPEED_THRESHOLD_KMH} km/h · ${TOP_SPEED_THRESHOLD_KMH} km/h · ${DISTANCE_MILESTONE_M / 1000} km · ${HARD_PASS_THRESHOLD}/100`;
    stories.push(card(
      "metric-thresholds", request, recentHeadline.length > 0 ? 88 : 72,
      L("Player threshold alerts", "Alertas de umbral de jugadores", "Alertes de seuil joueurs", "Alertas de limite de jogadores"),
      pick(persona,
        L(`${tags.length} threshold crossings ${scope} (${thresholds}). Highlights: ${listed}.`,
          `${tags.length} umbrales superados ${scope} (${thresholds}). Destacados: ${listed}.`,
          `${tags.length} seuils franchis ${scope} (${thresholds}). À retenir : ${listed}.`,
          `${tags.length} limites superados ${scope} (${thresholds}). Destaques: ${listed}.`),
        L(`Standout moments ${scope}: ${listed}.`, `Momentos destacados ${scope}: ${listed}.`, `Moments forts ${scope} : ${listed}.`, `Destaques ${scope}: ${listed}.`),
        L(`Benchmarks hit ${scope}: ${listed}.`, `Marcas alcanzadas ${scope}: ${listed}.`, `Repères atteints ${scope} : ${listed}.`, `Marcas atingidas ${scope}: ${listed}.`),
        language),
      pick(persona,
        L("Shot and pass thresholds cite their events; top speed and distance come from labelled synthetic tracking samples.", "Los umbrales de tiro y pase citan sus eventos; velocidad y distancia salen de tracking sintético etiquetado.", "Les seuils de tir et de passe citent leurs événements ; vitesse et distance viennent d'un tracking synthétique signalé.", "Os limites de chute e passe citam seus eventos; velocidade e distância vêm de tracking sintético identificado."),
        L("These are the moments a broadcast would flag on screen.", "Son los momentos que una retransmisión mostraría en pantalla.", "Ce sont les moments qu'une diffusion afficherait à l'écran.", "São os momentos que uma transmissão destacaria na tela."),
        L("Physical and technical benchmarks, timed to the match clock.", "Referencias físicas y técnicas, con su minuto.", "Repères physiques et techniques, horodatés.", "Referências físicas e técnicas, com o minuto."),
        language),
      eventIds,
      [
        { label: L(`Shots ≥ ${SHOT_SPEED_THRESHOLD_KMH} km/h`, `Tiros ≥ ${SHOT_SPEED_THRESHOLD_KMH} km/h`, `Frappes ≥ ${SHOT_SPEED_THRESHOLD_KMH} km/h`, `Chutes ≥ ${SHOT_SPEED_THRESHOLD_KMH} km/h`)[language], value: count("shot_speed"), unit: "shots" },
        { label: L(`Top speed ≥ ${TOP_SPEED_THRESHOLD_KMH} km/h (synthetic tracking)`, `Velocidad ≥ ${TOP_SPEED_THRESHOLD_KMH} km/h (tracking sintético)`, `Pointe ≥ ${TOP_SPEED_THRESHOLD_KMH} km/h (tracking synthétique)`, `Velocidade ≥ ${TOP_SPEED_THRESHOLD_KMH} km/h (tracking sintético)`)[language], value: count("top_speed"), unit: "alerts" },
        { label: L("Distance milestones (synthetic tracking)", "Hitos de distancia (tracking sintético)", "Paliers de distance (tracking synthétique)", "Marcos de distância (tracking sintético)")[language], value: count("distance"), unit: "alerts" },
        { label: L(`Passes ≥ ${HARD_PASS_THRESHOLD}/100 difficulty`, `Pases ≥ ${HARD_PASS_THRESHOLD}/100 de dificultad`, `Passes ≥ ${HARD_PASS_THRESHOLD}/100 de difficulté`, `Passes ≥ ${HARD_PASS_THRESHOLD}/100 de dificuldade`)[language], value: count("pass_difficulty"), unit: "passes" },
      ],
      { start: window.start, end: window.end }, undefined, "observed",
    ));
  }

  return stories;
}
