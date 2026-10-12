import { getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";
import { z } from "zod";

import { DETECTABLE_EVENT_TYPES, type VideoJobRequest, type VisionDetection } from "../../shared/video.js";
import { getAzureCredential } from "../azure/credential.js";
import { createWithRateLimitRetry } from "../desk/runner.js";

export interface VisionFrameInput {
  index: number;
  timestampSeconds: number;
  jpegBase64: string;
}

export interface VisionBatchResult {
  footageCheck: { realFootballFootage: boolean; reason: string; category?: "match" | "broadcast_graphics" | "unsupported" };
  kits: { home: string; away: string };
  detections: VisionDetection[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface VisionAnalyzer {
  configured: boolean;
  model: string;
  analyzeBatch(input: { frames: VisionFrameInput[]; request: VideoJobRequest; knownKits?: { home: string; away: string }; intervalSeconds: number }): Promise<VisionBatchResult>;
}

const OUTCOMES = ["success", "miss", "blocked", "saved", "complete", "incomplete", "none"] as const;
const BATCH_DEADLINE_MS = 120_000;

const detectionSchema = z.object({
  frameIndex: z.number().int(),
  type: z.enum(DETECTABLE_EVENT_TYPES),
  team: z.enum(["home", "away", "unknown"]),
  shirtNumber: z.number().int().min(0).max(99).nullable(),
  outcome: z.enum(OUTCOMES),
  x: z.number(),
  y: z.number(),
  confidence: z.number().min(0).max(1),
  description: z.string(),
});

const batchSchema = z.object({
  footageCheck: z.object({
    realFootballFootage: z.boolean(),
    reason: z.string(),
    category: z.enum(["match", "broadcast_graphics", "unsupported"]).optional(),
  }).refine((check) => check.category === undefined || check.realFootballFootage === (check.category === "match"), {
    message: "Footage category contradicts realFootballFootage",
  }),
  kits: z.object({ home: z.string(), away: z.string() }),
  detections: z.array(detectionSchema),
});

export const VISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["footageCheck", "kits", "detections"],
  properties: {
    footageCheck: {
      type: "object",
      additionalProperties: false,
      required: ["realFootballFootage", "reason", "category"],
      properties: {
        realFootballFootage: { type: "boolean" },
        reason: { type: "string" },
        category: { type: "string", enum: ["match", "broadcast_graphics", "unsupported"] },
      },
    },
    kits: {
      type: "object",
      additionalProperties: false,
      required: ["home", "away"],
      properties: { home: { type: "string" }, away: { type: "string" } },
    },
    detections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frameIndex", "type", "team", "shirtNumber", "outcome", "x", "y", "confidence", "description"],
        properties: {
          frameIndex: { type: "integer" },
          type: { type: "string", enum: [...DETECTABLE_EVENT_TYPES] },
          team: { type: "string", enum: ["home", "away", "unknown"] },
          shirtNumber: { type: ["integer", "null"] },
          outcome: { type: "string", enum: [...OUTCOMES] },
          x: { type: "number" },
          y: { type: "number" },
          confidence: { type: "number" },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export const VISION_INSTRUCTIONS = [
  "You tag football (soccer) match events from still frames sampled from a short video clip.",
  "Report only what is clearly visible. Never guess events between frames and never invent players.",
  "Event types: pass (ball clearly played between team-mates), shot, goal (ball in the net or an unmistakable goal celebration), save, tackle, foul, corner, yellow_card, red_card.",
  "Use at most 3 detections per frame. Skip a frame if nothing clear happens in it.",
  "team: home or away by kit colour, using the kit descriptions given; unknown if you cannot tell.",
  "shirtNumber: only if the number is legible in that frame, otherwise null.",
  "x, y: where the action happens in the visible frame, 0-100 from left to right and top to bottom.",
  "confidence: 0-1, how sure you are that the event happened as described.",
  "description: one short factual sentence about what the frame shows. No names.",
  "footageCheck.category: match for real camera footage of a football match; broadcast_graphics for legitimate football broadcast intros/interstitials such as team logos, lineups, title graphics or football studio coverage without match footage; unsupported for unrelated content, test patterns, video games (even football games), standalone animations, diagrams or screenshots.",
  "footageCheck.realFootballFootage: true only when category is match; false for broadcast_graphics or unsupported. If any frame contains unsupported content, classify the batch as unsupported.",
  "For a batch mixing genuine match frames and football broadcast graphics, use match and detect events ONLY on the genuine match frames, never on graphics or studio coverage. Logos, lineup portraits and scoreboard graphics are not evidence of goals, shots or other events.",
  "For broadcast_graphics or unsupported, return no detections and empty kit descriptions.",
  "kits: one short description of each team's kit as seen in genuine match frames (e.g. 'red shirts, white shorts'), never inferred from logos, graphics or studio clothing.",
].join("\n");

function describeTeams(request: VideoJobRequest, knownKits?: { home: string; away: string }): string {
  const kit = (side: "home" | "away") => request[side].kit.trim() || knownKits?.[side] || "";
  const home = kit("home");
  const away = kit("away");
  const lines = [`Home team: ${request.home.name}${home ? `, wearing ${home}` : ""}.`, `Away team: ${request.away.name}${away ? `, wearing ${away}` : ""}.`];
  if (!home && !away) lines.push("Kits are not known yet: call the first team whose kit you can describe 'home' and the other 'away', and report both kits.");
  return lines.join(" ");
}

export function buildVisionMessages(input: Parameters<VisionAnalyzer["analyzeBatch"]>[0]) {
  const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } })[] = [
    { type: "text", text: `${describeTeams(input.request, input.knownKits)} Frames are sampled about every ${input.intervalSeconds} s. Each image is preceded by its frameIndex and time.` },
  ];
  for (const frame of input.frames) {
    content.push({ type: "text", text: `frameIndex ${frame.index} at ${frame.timestampSeconds.toFixed(1)} s` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.jpegBase64}`, detail: "high" } });
  }
  return [
    { role: "system" as const, content: VISION_INSTRUCTIONS },
    { role: "user" as const, content },
  ];
}

/** Keeps only detections that cite a frame from this batch, so a model cannot point at frames it never saw. */
export function parseVisionResult(raw: unknown, frameIndexes: Set<number>): Omit<VisionBatchResult, "usage"> {
  const parsed = batchSchema.parse(raw);
  return {
    footageCheck: parsed.footageCheck,
    kits: parsed.kits,
    detections: parsed.detections.filter((detection) => frameIndexes.has(detection.frameIndex)).map((detection) => ({ ...detection, description: detection.description.trim() })),
  };
}

/** One strict-JSON chat completion with images; shared by the event tagger and Player cam. */
export interface VisionCaller {
  configured: boolean;
  model: string;
  call(messages: unknown[], schemaName: string, schema: object): Promise<{ content: unknown; usage: { inputTokens: number; outputTokens: number } }>;
}

export function createVisionCallerFromEnv(env: NodeJS.ProcessEnv = process.env): VisionCaller {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const deployment = env.AZURE_OPENAI_DEPLOYMENT?.trim() || "matchlens-narrator";
  if (!endpoint) {
    return {
      configured: false,
      model: deployment,
      async call() {
        throw new Error("Video analysis needs AZURE_OPENAI_ENDPOINT to be configured.");
      },
    };
  }
  const tokenProvider = getBearerTokenProvider(getAzureCredential(env), "https://cognitiveservices.azure.com/.default");
  const client = new AzureOpenAI({ endpoint, deployment, apiVersion: env.AZURE_OPENAI_API_VERSION?.trim() || "2024-10-21", azureADTokenProvider: tokenProvider, maxRetries: 0 });
  return {
    configured: true,
    model: deployment,
    async call(messages, schemaName, schema) {
      const startedAt = Date.now();
      const body = {
        model: deployment,
        temperature: 0,
        messages,
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      };
      const response = await createWithRateLimitRetry(
        (requestBody, options) => client.chat.completions.create(requestBody as never, options as never) as unknown as Promise<Record<string, unknown>>,
        body,
        BATCH_DEADLINE_MS,
        startedAt,
      ) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const message = response.choices?.[0]?.message;
      if (!message?.content) throw new Error(message?.refusal ? `The model declined: ${message.refusal}` : "The model returned no content.");
      return { content: JSON.parse(message.content), usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 } };
    },
  };
}

export function createVisionAnalyzerFromEnv(env: NodeJS.ProcessEnv = process.env, caller: VisionCaller = createVisionCallerFromEnv(env)): VisionAnalyzer {
  return {
    configured: caller.configured,
    model: caller.model,
    async analyzeBatch(input) {
      const { content, usage } = await caller.call(buildVisionMessages(input), "video_events", VISION_JSON_SCHEMA);
      return { ...parseVisionResult(content, new Set(input.frames.map((frame) => frame.index))), usage };
    },
  };
}
