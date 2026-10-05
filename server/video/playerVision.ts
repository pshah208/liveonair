import { z } from "zod";

import { PLAYER_ACTIONS, type PlayerCamRequest, type PlayerSighting } from "../../shared/playercam.js";
import type { VisionCaller, VisionFrameInput } from "./vision.js";

export interface PlayerVisionResult {
  footageCheck: { realFootballFootage: boolean; reason: string };
  sightings: PlayerSighting[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface PlayerVisionAnalyzer {
  configured: boolean;
  model: string;
  analyzeBatch(input: { frames: VisionFrameInput[]; request: PlayerCamRequest; referenceJpegBase64?: string; intervalSeconds: number }): Promise<PlayerVisionResult>;
}

const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const resultSchema = z.object({
  footageCheck: z.object({ realFootballFootage: z.boolean(), reason: z.string() }),
  sightings: z.array(z.object({
    frameIndex: z.number().int(),
    visible: z.boolean(),
    box: boxSchema,
    action: z.enum(PLAYER_ACTIONS),
    confidence: z.number().min(0).max(1),
    description: z.string(),
  })),
});

export const PLAYER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["footageCheck", "sightings"],
  properties: {
    footageCheck: {
      type: "object",
      additionalProperties: false,
      required: ["realFootballFootage", "reason"],
      properties: { realFootballFootage: { type: "boolean" }, reason: { type: "string" } },
    },
    sightings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frameIndex", "visible", "box", "action", "confidence", "description"],
        properties: {
          frameIndex: { type: "integer" },
          visible: { type: "boolean" },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          },
          action: { type: "string", enum: [...PLAYER_ACTIONS] },
          confidence: { type: "number" },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export const PLAYER_INSTRUCTIONS = [
  "You follow ONE football (soccer) player through still frames sampled from a short clip.",
  "Identify the target from the kit, the shirt number when legible and, if given, the reference crop where the target is the player at the centre.",
  "Return exactly one sighting per frame, in frame order.",
  "visible: true only if you are reasonably sure the target is in the frame. Never pick a different player just to have someone; prefer visible=false.",
  "box: the target's bounding box in the frame, 0-100 from the left and top (x, y = top-left corner; w, h = size). Use 0,0,0,0 when not visible.",
  "action: what the target is doing: shot, header, save, dribble (running with the ball past or at opponents), tackle, pass, on_ball (in possession or receiving), celebration, off_ball (visible but not involved).",
  "confidence: 0-1, how sure you are that this is the target AND the action is right.",
  "description: one short factual sentence about the target in that frame. Do not use the player's name.",
  "footageCheck.realFootballFootage: true only for real camera footage of football. False for test patterns, animations, diagrams, video games or screenshots.",
].join("\n");

export function buildPlayerMessages(input: Parameters<PlayerVisionAnalyzer["analyzeBatch"]>[0]) {
  const { request } = input;
  const target = [
    `Target player: shirt ${request.number !== null ? `number ${request.number}` : "number unknown"}`,
    request.kit.trim() ? `wearing ${request.kit.trim()}` : "kit not described",
  ].join(", ");
  const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" | "low" } })[] = [
    { type: "text", text: `${target}. Frames are sampled about every ${input.intervalSeconds} s. Each image is preceded by its frameIndex and time.` },
  ];
  if (input.referenceJpegBase64) {
    content.push({ type: "text", text: "REFERENCE crop: the target is the player inside the yellow box. Use their kit, build and number to recognise them in the frames (the yellow box is not in the frames)." });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.referenceJpegBase64}`, detail: "high" } });
  }
  for (const frame of input.frames) {
    content.push({ type: "text", text: `frameIndex ${frame.index} at ${frame.timestampSeconds.toFixed(1)} s` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.jpegBase64}`, detail: "high" } });
  }
  return [
    { role: "system" as const, content: PLAYER_INSTRUCTIONS },
    { role: "user" as const, content },
  ];
}

const clamp = (value: number) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** Keeps one sighting per frame of this batch; boxes are clamped to the frame and dropped when not visible. */
export function parsePlayerResult(raw: unknown, frameIndexes: Set<number>): Omit<PlayerVisionResult, "usage"> {
  const parsed = resultSchema.parse(raw);
  const byFrame = new Map<number, PlayerSighting>();
  for (const sighting of parsed.sightings) {
    if (!frameIndexes.has(sighting.frameIndex) || byFrame.has(sighting.frameIndex)) continue;
    const x = clamp(sighting.box.x);
    const y = clamp(sighting.box.y);
    const box = { x, y, w: Math.min(100 - x, clamp(sighting.box.w)), h: Math.min(100 - y, clamp(sighting.box.h)) };
    const hasBox = box.w > 0.5 && box.h > 0.5;
    const visible = sighting.visible && hasBox;
    byFrame.set(sighting.frameIndex, {
      frameIndex: sighting.frameIndex,
      visible,
      box: visible ? box : null,
      action: visible ? sighting.action : "off_ball",
      confidence: visible ? sighting.confidence : 0,
      description: sighting.description.trim().slice(0, 240),
    });
  }
  return { footageCheck: parsed.footageCheck, sightings: [...byFrame.values()].sort((a, b) => a.frameIndex - b.frameIndex) };
}

export function createPlayerVisionAnalyzer(caller: VisionCaller): PlayerVisionAnalyzer {
  return {
    configured: caller.configured,
    model: caller.model,
    async analyzeBatch(input) {
      const { content, usage } = await caller.call(buildPlayerMessages(input), "player_sightings", PLAYER_JSON_SCHEMA);
      return { ...parsePlayerResult(content, new Set(input.frames.map((frame) => frame.index))), usage };
    },
  };
}
