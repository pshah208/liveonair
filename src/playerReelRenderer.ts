import type { PlayerBox, PlayerMoment } from "../shared/playercam.js";
import { ACTION_LABEL } from "../shared/playercam.js";
import type { Palette } from "./highlightRenderer.js";

export type PlayerReelFormat = "landscape" | "vertical";

export const PLAYER_REEL_SIZE: Record<PlayerReelFormat, { width: number; height: number }> = {
  landscape: { width: 1280, height: 720 },
  vertical: { width: 720, height: 1280 }
};

export interface PlayerReelFrame {
  moment: PlayerMoment;
  index: number;
  total: number;
  /** Clip second being shown. */
  second: number;
  /** 0–1 through the whole reel. */
  progress: number;
  box?: PlayerBox;
}

const FONT = `"IBM Plex Sans", "Segoe UI", sans-serif`;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, color: string, align: "left" | "center" = "left") {
  ctx.font = `700 ${size}px ${FONT}`;
  const width = ctx.measureText(text).width + size * 1.6;
  const height = size * 2.2;
  const left = align === "center" ? x - width / 2 : x;
  roundRect(ctx, left, y, width, height, size * 0.6);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + size * 0.8, y + height / 2 + 1);
  return { width, height };
}

/**
 * Where the video lands on the canvas. Landscape covers the frame; vertical fills the height and pans
 * horizontally so the player stays in shot (focusX is the smoothed player centre, 0–1 across the video).
 */
export function videoRect(format: PlayerReelFormat, videoWidth: number, videoHeight: number, focusX: number) {
  const { width, height } = PLAYER_REEL_SIZE[format];
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale;
  const h = videoHeight * scale;
  if (format === "landscape") return { x: (width - w) / 2, y: (height - h) / 2, w, h };
  const x = Math.min(0, Math.max(width - w, width / 2 - focusX * w));
  return { x, y: (height - h) / 2, w, h };
}

export function renderPlayerFrame(
  ctx: CanvasRenderingContext2D,
  format: PlayerReelFormat,
  video: HTMLVideoElement | null,
  frame: PlayerReelFrame | null,
  label: string,
  palette: Palette,
  focusX: number
) {
  const { width, height } = PLAYER_REEL_SIZE[format];
  const unit = Math.min(width, height) / 720;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);
  if (video && video.videoWidth && video.videoHeight) {
    const rect = videoRect(format, video.videoWidth, video.videoHeight, focusX);
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
    if (frame?.box) {
      const box = frame.box;
      const cx = rect.x + ((box.x + box.w / 2) / 100) * rect.w;
      const feet = rect.y + ((box.y + box.h) / 100) * rect.h;
      const top = rect.y + (box.y / 100) * rect.h;
      const ringW = Math.max(28 * unit, (box.w / 100) * rect.w * 1.3);
      // Broadcast-style spotlight: a glowing ring at the player's feet and a name tag over their head.
      ctx.save();
      ctx.shadowColor = palette.accent;
      ctx.shadowBlur = 18 * unit;
      ctx.strokeStyle = palette.accentText;
      ctx.lineWidth = 4 * unit;
      ctx.beginPath();
      ctx.ellipse(cx, feet, ringW / 2, ringW / 6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.font = `700 ${14 * unit}px ${FONT}`;
      const tagW = ctx.measureText(label).width + 22 * unit;
      const tagH = 28 * unit;
      const tagY = Math.max(8 * unit, top - tagH - 14 * unit);
      const tagX = Math.min(width - tagW - 8 * unit, Math.max(8 * unit, cx - tagW / 2));
      roundRect(ctx, tagX, tagY, tagW, tagH, 6 * unit);
      ctx.fillStyle = palette.accent;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - 7 * unit, tagY + tagH);
      ctx.lineTo(cx + 7 * unit, tagY + tagH);
      ctx.lineTo(cx, tagY + tagH + 9 * unit);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = palette.accentFg;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(label, tagX + 11 * unit, tagY + tagH / 2 + 1);
    }
  }

  pill(ctx, "PLAYER CAM · MATCHLENS", 20 * unit, 20 * unit, 13 * unit, "rgba(9, 9, 11, 0.78)", palette.accentText);
  if (!frame) return;

  const chip = `MOMENT ${frame.index + 1} OF ${frame.total} · ${ACTION_LABEL[frame.moment.action].toUpperCase()}`;
  pill(ctx, chip, format === "landscape" ? width / 2 : 20 * unit, format === "landscape" ? 20 * unit : 70 * unit, 13 * unit, "rgba(9, 9, 11, 0.78)", palette.text, format === "landscape" ? "center" : "left");

  // Lower third with the player's name and what the model saw at the peak of the moment.
  const panelH = 92 * unit;
  const panelY = height - panelH - 28 * unit;
  const panelX = 20 * unit;
  const panelW = width - 40 * unit;
  roundRect(ctx, panelX, panelY, panelW, panelH, 10 * unit);
  ctx.fillStyle = "rgba(9, 9, 11, 0.82)";
  ctx.fill();
  ctx.fillStyle = palette.accent;
  ctx.fillRect(panelX, panelY, 6 * unit, panelH);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = palette.text;
  ctx.font = `700 ${26 * unit}px ${FONT}`;
  ctx.fillText(frame.moment.caption, panelX + 22 * unit, panelY + 40 * unit, panelW - 44 * unit);
  ctx.fillStyle = palette.textMuted;
  ctx.font = `500 ${16 * unit}px ${FONT}`;
  ctx.fillText(frame.moment.description, panelX + 22 * unit, panelY + 70 * unit, panelW - 44 * unit);

  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
  ctx.fillRect(0, height - 6 * unit, width, 6 * unit);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, height - 6 * unit, Math.min(1, Math.max(0, frame.progress)) * width, 6 * unit);
}
