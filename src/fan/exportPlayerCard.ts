// "Save as picture": draws the Player card on a <canvas> (no dependencies) and shares or downloads the PNG.
import { playerCardFileName, rankText, SYNTHETIC_FOOTER, shirtStyle, type PlayerCardModel } from "../../shared/fanCards.js";
import type { Language } from "../../shared/types.js";
import { SHIRT_PATH } from "./ShirtGraphic.js";

export interface PlayerCardExportMeta {
  matchId: string;
  matchTitle: string;
  chip: string | null;
  minute: number;
  language: Language;
}

const WIDTH = 1080;
const ROW_H = 96;

function medalFill(rank: number | null): string {
  return rank === 1 ? "#f5c542" : rank === 2 ? "#cfd3d9" : rank === 3 ? "#d9a066" : "#e7e5e4";
}

export function drawPlayerCard(ctx: CanvasRenderingContext2D, model: PlayerCardModel, meta: PlayerCardExportMeta, height: number): void {
  const font = '"IBM Plex Sans", "Segoe UI", sans-serif';
  const mono = '"IBM Plex Mono", Consolas, monospace';
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = "#111114";
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 72px ${font}`;
  ctx.fillText(model.title.toUpperCase(), 56, 120, 640);
  ctx.font = `600 26px ${mono}`;
  ctx.fillStyle = "#3f3f46";
  ctx.fillText(model.subtitle.toUpperCase().slice(0, 60), 56, 170, 640);

  // Shirt silhouette on the right.
  const kit = shirtStyle(model.teamId);
  ctx.save();
  ctx.translate(740, 40);
  ctx.scale(3.1, 3.1);
  const path = new Path2D(SHIRT_PATH);
  ctx.fillStyle = kit.fill;
  ctx.fill(path);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#09090b";
  ctx.stroke(path);
  ctx.font = `800 30px ${font}`;
  ctx.textAlign = "center";
  if (kit.outline) {
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = kit.number === "#ffffff" ? "#09090b" : "#ffffff";
    ctx.strokeText(String(model.player.number), 50, 66);
  }
  ctx.fillStyle = kit.number;
  ctx.fillText(String(model.player.number), 50, 66);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.fillStyle = "#3f3f46";
  ctx.font = `500 20px ${font}`;
  ctx.fillText("Illustrative graphic", 770, 372);

  let y = 420;
  ctx.fillStyle = "#3f3f46";
  ctx.font = `700 20px ${mono}`;
  ctx.fillText("STAT", 56, y);
  ctx.fillText("RANKING", 560, y);
  ctx.textAlign = "right";
  ctx.fillText("VALUE", WIDTH - 56, y);
  ctx.textAlign = "left";
  y += 24;
  for (const row of model.rows) {
    ctx.fillStyle = "rgba(17,17,20,0.18)";
    ctx.fillRect(56, y, WIDTH - 112, 2);
    ctx.fillStyle = "#111114";
    ctx.font = `700 32px ${font}`;
    ctx.fillText(row.label, 56, y + 60, 470);
    // Rank pill (ordinal text is always drawn; medal colour is decoration).
    ctx.fillStyle = medalFill(row.rank);
    ctx.beginPath();
    ctx.roundRect(560, y + 20, 150, 54, 27);
    ctx.fill();
    ctx.fillStyle = "#111114";
    ctx.font = `800 28px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText(rankText(row, meta.language), 635, y + 58);
    ctx.textAlign = "right";
    ctx.font = `900 52px ${font}`;
    ctx.fillText(row.display, WIDTH - 56, y + 64);
    ctx.textAlign = "left";
    y += ROW_H;
  }
  ctx.fillStyle = "rgba(17,17,20,0.18)";
  ctx.fillRect(56, y, WIDTH - 112, 2);
  y += 56;
  ctx.fillStyle = "#3f3f46";
  ctx.font = `500 22px ${font}`;
  ctx.fillText(`${SYNTHETIC_FOOTER} · ${meta.matchTitle}`.slice(0, 80), 56, y, WIDTH - 112 - 160);
  if (meta.chip) {
    ctx.font = `700 22px ${mono}`;
    ctx.textAlign = "right";
    ctx.fillText(meta.chip, WIDTH - 56, y);
    ctx.textAlign = "left";
  }
}

export type ExportResult = "shared" | "downloaded" | "cancelled" | "unsupported";

export async function exportPlayerCard(model: PlayerCardModel, meta: PlayerCardExportMeta): Promise<ExportResult> {
  if (typeof document === "undefined") return "unsupported";
  if (document.fonts?.ready) await document.fonts.ready;
  const height = 420 + 24 + model.rows.length * ROW_H + 130;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "unsupported";
  drawPlayerCard(ctx, model, meta, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return "unsupported";
  const name = playerCardFileName(model.player.id, meta.matchId, meta.minute);
  const file = new File([blob], name, { type: "image/png" });
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${model.player.name} · ${model.title}` });
      return "shared";
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // Fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
