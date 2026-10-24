import type { HighlightClip, HighlightReel } from "../shared/highlights.js";
import { eventSecondOf, highlightKindLabel, latestRevisions, REEL_TEXT } from "../shared/highlights.js";
import type { MatchEvent, MatchFixture, TeamId } from "../shared/types.js";

export const REEL_WIDTH = 1280;
export const REEL_HEIGHT = 720;

const INTRO_SECONDS = 2.6;
const CARD_SECONDS = 1.1;
const HOLD_SECONDS = 2.6;
const OUTRO_SECONDS = 2.4;
/** Match seconds played per reel second during a clip. */
const PLAYBACK_RATE = 3.5;

export type Segment =
  | { kind: "intro"; start: number; end: number }
  | { kind: "card"; start: number; end: number; clip: HighlightClip; index: number }
  | { kind: "play"; start: number; end: number; clip: HighlightClip; index: number }
  | { kind: "hold"; start: number; end: number; clip: HighlightClip; index: number }
  | { kind: "outro"; start: number; end: number };

export interface ReelTimeline {
  segments: Segment[];
  duration: number;
  clipStarts: number[];
}

/**
 * `voiceSeconds` (keyed "intro", "outro" or clip id) stretches segments so each commentary line
 * finishes before the reel moves on.
 */
export function buildTimeline(reel: HighlightReel, keySeconds: Map<string, number>, voiceSeconds: Map<string, number> = new Map()): ReelTimeline {
  const segments: Segment[] = [];
  const clipStarts: number[] = [];
  const voice = (key: string) => (voiceSeconds.get(key) ?? 0) + 0.5;
  let cursor = 0;
  segments.push({ kind: "intro", start: cursor, end: (cursor += Math.max(INTRO_SECONDS, voice("intro"))) });
  reel.clips.forEach((clip, index) => {
    clipStarts.push(cursor);
    segments.push({ kind: "card", start: cursor, end: (cursor += CARD_SECONDS), clip, index });
    const keyAt = keyEventSecond(clip, keySeconds);
    const playSeconds= Math.max(1.5, (keyAt - clip.startSecond) / PLAYBACK_RATE);
    segments.push({ kind: "play", start: cursor, end: (cursor += playSeconds), clip, index });
    const holdSeconds = Math.max(HOLD_SECONDS, voice(clip.id) - CARD_SECONDS - playSeconds);
    segments.push({ kind: "hold", start: cursor, end: (cursor += holdSeconds), clip, index });
  });
  segments.push({ kind: "outro", start: cursor, end: (cursor += Math.max(OUTRO_SECONDS, voice("outro"))) });
  return { segments, duration: cursor, clipStarts };
}

function keyEventSecond(clip: HighlightClip, keySeconds: Map<string, number>): number {
  return keySeconds.get(clip.keyEventId) ?? clip.startSecond + (clip.endSecond - clip.startSecond) * 0.65;
}

export interface Palette {
  bg: string;
  surface: string;
  surfaceSoft: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  accentFg: string;
  home: string;
  away: string;
  success: string;
  danger: string;
}

export function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--cp-bg", "#09090b"),
    surface: read("--cp-surface-solid", "#18181b"),
    surfaceSoft: read("--cp-surface-soft", "rgba(255,255,255,0.04)"),
    border: read("--cp-border", "rgba(255,255,255,0.09)"),
    borderStrong: read("--cp-border-strong", "rgba(255,255,255,0.2)"),
    text: read("--cp-text", "#fafafa"),
    textMuted: read("--cp-text-muted", "#a1a1aa"),
    accent: read("--cp-accent", "#6d28d9"),
    accentText: read("--cp-accent-text", "#c4b5fd"),
    accentFg: read("--cp-accent-fg", "#ffffff"),
    home: read("--team-home", "#4f9fec"),
    away: read("--team-away", "#f59e0b"),
    success: read("--cp-success", "#10b981"),
    danger: read("--cp-danger", "#ef4444")
  };
}

export interface ReelModel {
  fixture: MatchFixture;
  reel: HighlightReel;
  timeline: ReelTimeline;
  events: Map<string, MatchEvent>;
  players: Map<string, string>;
  keySeconds: Map<string, number>;
  palette: Palette;
  /** Replaces the footage-reel strapline, e.g. for Video Lab reels tagged by a pundit. */
  subtitle?: string;
}

export function createReelModel(fixture: MatchFixture, reel: HighlightReel, palette: Palette, voiceSeconds?: Map<string, number>): ReelModel {
  const events = new Map(latestRevisions(fixture.events).map((event) => [event.id, event]));
  const keySeconds = new Map<string, number>();
  for (const clip of reel.clips) {
    const key = events.get(clip.keyEventId);
    if (key) keySeconds.set(clip.keyEventId, eventSecondOf(key));
  }
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player.name]));
  return { fixture, reel, timeline: buildTimeline(reel, keySeconds, voiceSeconds), events, players, keySeconds, palette };
}

// ------------------------------------------------------------------ geometry

const PITCH = { x: 190, y: 92, w: 900, h: 612 };

function toCanvas(x: number, y: number): [number, number] {
  return [PITCH.x + (x / 100) * PITCH.w, PITCH.y + (y / 100) * PITCH.h];
}

function teamColor(model: ReelModel, teamId: TeamId): string {
  return teamId === "home" ? model.palette.home : model.palette.away;
}

function ease(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

type Keyframe = { t: number; x: number; y: number; event: MatchEvent };

function keyframes(model: ReelModel, clip: HighlightClip): Keyframe[] {
  const frames: Keyframe[] = [];
  const clipEvents = clip.eventIds.map((id) => model.events.get(id)).filter((event): event is MatchEvent => Boolean(event));
  clipEvents.forEach((event, index) => {
    const at = eventSecondOf(event);
    frames.push({ t: at, x: event.x, y: event.y, event });
    const next = clipEvents[index + 1];
    if (event.endX !== undefined && event.endY !== undefined) {
      const arrive = next ? Math.min(at + 1.6, eventSecondOf(next) - 0.05) : at + 1.6;
      if (arrive > at) frames.push({ t: arrive, x: event.endX, y: event.endY, event });
    }
  });
  return frames;
}

function ballAt(frames: Keyframe[], second: number): { x: number; y: number; event: MatchEvent | null } {
  if (frames.length === 0) return { x: 50, y: 50, event: null };
  if (second <= frames[0].t) return { x: frames[0].x, y: frames[0].y, event: frames[0].event };
  for (let index = 0; index < frames.length - 1; index += 1) {
    const a = frames[index];
    const b = frames[index + 1];
    if (second >= a.t && second <= b.t) {
      const progress = b.t === a.t ? 1 : ease((second - a.t) / (b.t - a.t));
      return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress, event: a.event };
    }
  }
  const last = frames[frames.length - 1];
  return { x: last.x, y: last.y, event: last.event };
}

function scoreAt(model: ReelModel, second: number): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of model.events.values()) {
    if (event.type === "goal" && !event.rescinded && eventSecondOf(event) <= second) score[event.teamId] += 1;
  }
  return score;
}

// ------------------------------------------------------------------ drawing

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawPitch(ctx: CanvasRenderingContext2D, model: ReelModel) {
  const { palette } = model;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  roundRect(ctx, PITCH.x, PITCH.y, PITCH.w, PITCH.h, 18);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = palette.borderStrong;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.borderStrong;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const [ax, ay] = toCanvas(x1, y1);
    const [bx, by] = toCanvas(x2, y2);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  line(50, 0, 50, 100);
  const [cx, cy] = toCanvas(50, 50);
  ctx.beginPath();
  ctx.arc(cx, cy, PITCH.h * 0.14, 0, Math.PI * 2);
  ctx.stroke();
  for (const [x, w] of [[0, 16], [84, 16]] as const) {
    const [bx, by] = toCanvas(x, 26.5);
    ctx.strokeRect(bx, by, (w / 100) * PITCH.w, 0.47 * PITCH.h);
  }
  for (const [x, w] of [[0, 5.5], [94.5, 5.5]] as const) {
    const [bx, by] = toCanvas(x, 38);
    ctx.strokeRect(bx, by, (w / 100) * PITCH.w, 0.24 * PITCH.h);
  }
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, weight = 600, align: CanvasTextAlign = "left") {
  ctx.font = `${weight} ${size}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight = 500): string[] {
  ctx.font = `${weight} ${size}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function drawScorebug(ctx: CanvasRenderingContext2D, model: ReelModel, second: number) {
  const { palette, fixture } = model;
  const score = scoreAt(model, second);
  roundRect(ctx, 24, 20, 360, 52, 10);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = palette.accent;
  ctx.fillRect(24, 20, 6, 52);
  drawText(ctx, fixture.home.shortName, 48, 55, 22, palette.text, 700);
  drawText(ctx, `${score.home} – ${score.away}`, 180, 55, 26, palette.text, 700, "center");
  drawText(ctx, fixture.away.shortName, 236, 55, 22, palette.text, 700);
  drawText(ctx, `${Math.floor(second / 60)}'`, 368, 55, 20, palette.textMuted, 700, "right");
}

function drawBrand(ctx: CanvasRenderingContext2D, model: ReelModel, subtitle = REEL_TEXT[model.reel.language].dataReel) {
  const { palette } = model;
  drawText(ctx, "Live on Air", REEL_WIDTH - 24, 46, 24, palette.text, 700, "right");
  drawText(ctx, subtitle, REEL_WIDTH - 24, 68, 12, palette.textMuted, 700, "right");
}

function drawTrail(ctx: CanvasRenderingContext2D, model: ReelModel, clip: HighlightClip, second: number) {
  const played = clip.eventIds.map((id) => model.events.get(id)).filter((event): event is MatchEvent => Boolean(event) && eventSecondOf(event!) <= second);
  played.forEach((event, index) => {
    const alpha = 0.25 + (0.6 * (index + 1)) / Math.max(1, played.length);
    ctx.globalAlpha = event.rescinded ? alpha * 0.4 : alpha;
    const [x, y] = toCanvas(event.x, event.y);
    if (event.endX !== undefined && event.endY !== undefined) {
      const [ex, ey] = toCanvas(event.endX, event.endY);
      ctx.setLineDash(event.type === "pass" || event.type === "corner" ? [10, 8] : []);
      ctx.strokeStyle = teamColor(model, event.teamId);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = teamColor(model, event.teamId);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function actionLabel(event: MatchEvent): string {
  const xg = event.xg !== undefined && (event.type === "shot" || event.type === "goal") ? ` · ${event.xg.toFixed(2)} illustrative xG` : "";
  return `${event.type.replaceAll("_", " ")}${xg}`;
}

function drawBall(ctx: CanvasRenderingContext2D, model: ReelModel, ball: { x: number; y: number; event: MatchEvent | null }) {
  const { palette } = model;
  const [x, y] = toCanvas(ball.x, ball.y);
  ctx.fillStyle = palette.text;
  ctx.strokeStyle = palette.bg;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (!ball.event) return;
  const name = model.players.get(ball.event.playerId) ?? "";
  const label = `${name} · ${actionLabel(ball.event)}`;
  ctx.font = `600 18px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const width = ctx.measureText(label).width + 20;
  const lx = Math.min(Math.max(x - width / 2, PITCH.x + 8), PITCH.x + PITCH.w - width - 8);
  const ly = y - 46 < PITCH.y + 8 ? y + 22 : y - 46;
  roundRect(ctx, lx, ly, width, 30, 8);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  ctx.strokeStyle = teamColor(model, ball.event.teamId);
  ctx.lineWidth = 2;
  ctx.stroke();
  drawText(ctx, label, lx + 10, ly + 21, 18, palette.text, 600);
}

function drawBurst(ctx: CanvasRenderingContext2D, model: ReelModel, clip: HighlightClip, progress: number) {
  const event = model.events.get(clip.keyEventId);
  if (!event) return;
  const [x, y] = toCanvas(event.endX ?? event.x, event.endY ?? event.y);
  const color = clip.kind === "disallowed_goal" || clip.kind === "red_card" ? model.palette.danger : teamColor(model, clip.teamId);
  for (let ring = 0; ring < 3; ring += 1) {
    const local = (progress * 1.6 + ring * 0.22) % 1;
    ctx.globalAlpha = 1 - local;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 14 + local * 70, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** UI wording for a "big chance" clip; the shared highlight builder keeps its own kind and title. */
export const BIG_CHANCE_LABEL = "High illustrative xG shot";

/** Display title for a clip, replacing the shared English "Big chance" title with the illustrative-xG wording. */
export function clipTitle(clip: Pick<HighlightClip, "kind" | "title">): string {
  return clip.kind === "big_chance" && clip.title === "Big chance" ? BIG_CHANCE_LABEL : clip.title;
}

function kindLabel(clip: HighlightClip, model: ReelModel): string {
  const base = clip.label ?? (clip.kind === "big_chance" && model.reel.language === "en" ? BIG_CHANCE_LABEL : highlightKindLabel(clip.kind, model.reel.language));
  return base.toUpperCase();
}

function text(model: ReelModel) {
  return REEL_TEXT[model.reel.language];
}

function drawLowerThird(ctx: CanvasRenderingContext2D, model: ReelModel, clip: HighlightClip, appear: number) {
  const { palette } = model;
  const offset = (1 - ease(Math.min(1, appear))) * 40;
  const x = 120;
  const width = REEL_WIDTH - 240;
  const lines = wrap(ctx, clip.caption, width - 48, 24);
  const height = 74 + lines.length * 32;
  const y = REEL_HEIGHT - height - 26 + offset;
  ctx.globalAlpha = Math.min(1, appear * 1.5);
  roundRect(ctx, x, y, width, height, 14);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = clip.kind === "disallowed_goal" || clip.kind === "red_card" ? palette.danger : palette.accent;
  ctx.fillRect(x, y, 8, height);
  drawText(ctx, clipTitle(clip), x + 28, y + 40, 26, palette.text, 700);
  lines.forEach((line, index) => drawText(ctx, line, x + 28, y + 76 + index * 32, 24, palette.textMuted, 500));
  ctx.globalAlpha = 1;
}

function drawCenterCard(ctx: CanvasRenderingContext2D, model: ReelModel, eyebrow: string, title: string, subtitle: string, appear: number) {
  const { palette } = model;
  ctx.globalAlpha = 0.86 * Math.min(1, appear * 2);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  ctx.globalAlpha = Math.min(1, appear * 2);
  drawText(ctx, eyebrow, REEL_WIDTH / 2, REEL_HEIGHT / 2 - 64, 18, palette.accentText, 700, "center");
  drawText(ctx, title, REEL_WIDTH / 2, REEL_HEIGHT / 2, 44, palette.text, 700, "center");
  drawText(ctx, subtitle, REEL_WIDTH / 2, REEL_HEIGHT / 2 + 48, 22, palette.textMuted, 500, "center");
  ctx.globalAlpha = 1;
}

function drawProgress(ctx: CanvasRenderingContext2D, model: ReelModel, time: number) {
  const { palette, timeline } = model;
  const y = REEL_HEIGHT - 6;
  ctx.fillStyle = palette.border;
  ctx.fillRect(0, y, REEL_WIDTH, 6);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, y, (time / timeline.duration) * REEL_WIDTH, 6);
  ctx.fillStyle = palette.text;
  for (const start of timeline.clipStarts) ctx.fillRect((start / timeline.duration) * REEL_WIDTH - 1, y, 2, 6);
}

export function segmentAt(timeline: ReelTimeline, time: number): Segment {
  return timeline.segments.find((segment) => time >= segment.start && time < segment.end) ?? timeline.segments[timeline.segments.length - 1];
}

export function renderReelFrame(ctx: CanvasRenderingContext2D, model: ReelModel, time: number) {
  const segment = segmentAt(model.timeline, time);
  const local = (time - segment.start) / Math.max(0.001, segment.end - segment.start);
  const { fixture, reel } = model;
  drawPitch(ctx, model);
  drawBrand(ctx, model);

  if (segment.kind === "intro" || segment.kind === "outro") {
    const finalScore = scoreAt(model, segment.kind === "intro" ? fixture.durationSeconds : reel.clips[reel.clips.length - 1]?.endSecond ?? fixture.durationSeconds);
    if (segment.kind === "intro") {
      drawCenterCard(ctx, model, text(model).intro, `${fixture.home.name} ${finalScore.home} – ${finalScore.away} ${fixture.away.name}`, text(model).moments(reel.clips.length), local);
    } else {
      drawCenterCard(ctx, model, text(model).outro, `${fixture.home.shortName} ${finalScore.home} – ${finalScore.away} ${fixture.away.shortName}`, "Fabric Eventstream · Foundry agents", local);
    }
    drawProgress(ctx, model, time);
    return;
  }

  const { clip } = segment;
  const keyAt = keyEventSecond(clip, model.keySeconds);
  const frames= keyframes(model, clip);
  let second = clip.startSecond;
  if (segment.kind === "play") second = clip.startSecond + (keyAt - clip.startSecond) * local;
  if (segment.kind === "hold") second = keyAt + Math.min(1.6, local * 2);

  drawScorebug(ctx, model, segment.kind === "card" ? clip.startSecond : second);
  drawTrail(ctx, model, clip, second);
  if (segment.kind === "hold") drawBurst(ctx, model, clip, local);
  drawBall(ctx, model, ballAt(frames, second));
  if (segment.kind === "hold") drawLowerThird(ctx, model, clip, local * 3);
  if (segment.kind === "card") {
    drawCenterCard(ctx, model, `${text(model).moment(segment.index + 1, reel.clips.length)} · ${kindLabel(clip, model)}`, clipTitle(clip), `${formatMinute(clip.startSecond)} – ${formatMinute(clip.endSecond)} ${text(model).matchTime}`, Math.min(1, (1 - local) * 3));
  }
  drawProgress(ctx, model, time);
}

function formatMinute(second: number): string {
  return `${Math.floor(second / 60)}'${String(Math.floor(second % 60)).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ footage mode

export interface FootageFrame {
  clip: HighlightClip;
  clipIndex: number;
  clipCount: number;
  /** Match second the current footage frame represents. */
  matchSecond: number;
  /** 0–1 progress through the whole footage reel. */
  progress: number;
}

function drawVideoCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(REEL_WIDTH / vw, REEL_HEIGHT / vh);
  const w = vw * scale;
  const h = vh * scale;
  ctx.drawImage(video, (REEL_WIDTH - w) / 2, (REEL_HEIGHT - h) / 2, w, h);
}

function drawMomentChip(ctx: CanvasRenderingContext2D, model: ReelModel, frame: FootageFrame) {
  const { palette } = model;
  const label = `${text(model).moment(frame.clipIndex + 1, frame.clipCount)} · ${kindLabel(frame.clip, model)}`;
  ctx.font = `700 14px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const width = ctx.measureText(label).width + 32;
  const x = (REEL_WIDTH - width) / 2;
  roundRect(ctx, x, 28, width, 34, 10);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  drawText(ctx, label, REEL_WIDTH / 2, 50, 14, palette.accentText, 700, "center");
}

/** Composites licensed or self-recorded footage with Live on Air overlays driven by the synthetic events. */
export function renderFootageFrame(ctx: CanvasRenderingContext2D, model: ReelModel, video: HTMLVideoElement | null, frame: FootageFrame | null) {
  const { palette } = model;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  if (video) drawVideoCover(ctx, video);
  ctx.font = `700 12px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const subtitle = model.subtitle ?? text(model).footageReel;
  const plateWidth = Math.max(180, ctx.measureText(subtitle).width + 32);
  roundRect(ctx, REEL_WIDTH - 12 - plateWidth, 20, plateWidth, 58, 10);
  ctx.fillStyle = palette.surface;
  ctx.fill();
  drawBrand(ctx, model, subtitle);
  if (!frame) return;
  drawScorebug(ctx, model, frame.matchSecond);
  drawMomentChip(ctx, model, frame);
  const appear = (frame.matchSecond - frame.clip.keySecond + 0.4) / 0.8;
  if (appear > 0) drawLowerThird(ctx, model, frame.clip, appear);
  const y = REEL_HEIGHT - 6;
  ctx.fillStyle = palette.border;
  ctx.fillRect(0, y, REEL_WIDTH, 6);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, y, Math.min(1, Math.max(0, frame.progress)) * REEL_WIDTH, 6);
}
