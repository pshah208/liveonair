import { Buffer } from "node:buffer";

import {
  EventHubConsumerClient,
  EventHubProducerClient,
  type EventPosition,
} from "@azure/event-hubs";
import { z } from "zod";

import type { LiveEnvelope } from "../../shared/platform.js";
import type { FixtureSummary, MatchEvent, Team } from "../../shared/types.js";
import type { LiveTransportClient } from "../contracts.js";

const teamIdSchema = z.enum(["home", "away"]);
const eventTypeSchema = z.enum([
  "pass",
  "shot",
  "goal",
  "save",
  "tackle",
  "pressure",
  "corner",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "kickoff",
  "halftime",
  "fulltime",
]);
const outcomeSchema = z.enum(["success", "fail", "miss", "blocked", "saved", "complete", "incomplete", "none"]);

const playerSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  number: z.number().int(),
  position: z.string().trim().min(1),
  teamId: teamIdSchema,
  archiveId: z.string().trim().min(1).optional(),
}).strict();

const teamSchema: z.ZodType<Team> = z.object({
  id: teamIdSchema,
  name: z.string().trim().min(1),
  shortName: z.string().trim().min(1),
  players: z.array(playerSchema),
  archiveClubId: z.string().trim().min(1).optional(),
}).strict();

const fixtureSummarySchema: z.ZodType<FixtureSummary> = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string(),
  home: teamSchema,
  away: teamSchema,
  durationSeconds: z.number().int().min(1),
  eventCount: z.number().int().min(0),
  correctionAvailableAt: z.number().int().min(0),
}).strict();

const matchEventSchema: z.ZodType<MatchEvent> = z.object({
  id: z.string().trim().min(1),
  revision: z.number().int().min(1),
  minute: z.number().int().min(0),
  second: z.number().int().min(0).max(59),
  type: eventTypeSchema,
  teamId: teamIdSchema,
  playerId: z.string().trim().min(1),
  outcome: outcomeSchema,
  x: z.number(),
  y: z.number(),
  endX: z.number().optional(),
  endY: z.number().optional(),
  xg: z.number().optional(),
  relatedEventId: z.string().trim().min(1).optional(),
  rescinded: z.boolean().optional(),
  period: z.union([z.literal(1), z.literal(2)]).optional(),
  flightMs: z.number().positive().max(60_000).optional(),
  speedKmh: z.number().positive().max(250).optional(),
}).strict();

const liveEnvelopeBaseSchema = z.object({
  matchId: z.string().trim().min(1),
  sequence: z.number().int().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  source: z.enum(["synthetic", "opta-format-synthetic", "video-vision"]).optional(),
}).strict();

export const liveEnvelopeSchema = z.discriminatedUnion("kind", [
  liveEnvelopeBaseSchema.extend({
    kind: z.literal("match_start"),
    fixture: fixtureSummarySchema,
  }).strict(),
  liveEnvelopeBaseSchema.extend({
    kind: z.literal("match_event"),
    event: matchEventSchema,
  }).strict(),
  liveEnvelopeBaseSchema.extend({
    kind: z.literal("match_end"),
  }).strict(),
]);

export function parseLiveEnvelope(payload: unknown): LiveEnvelope {
  return liveEnvelopeSchema.parse(payload);
}

type ClosableTransport = LiveTransportClient & { close(): Promise<void> };

type EventstreamTransportOptions = {
  sourceConnectionString: string;
  destinationConnectionString: string;
  consumerGroup: string;
};

function cloneEnvelope(envelope: LiveEnvelope): LiveEnvelope {
  return structuredClone(envelope);
}

function eventHubBodyToUnknown(body: unknown): unknown {
  if (typeof body === "string") {
    return JSON.parse(body) as unknown;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  }
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString("utf8")) as unknown;
  }
  return body;
}

export function createLocalTransport(): ClosableTransport {
  const subscribers = new Set<(envelope: LiveEnvelope, receivedAt: number) => void>();

  return {
    name: "local",
    configured: false,
    async publish(envelope) {
      queueMicrotask(() => {
        const receivedAt = Date.now();
        for (const subscriber of subscribers) {
          try {
            subscriber(cloneEnvelope(envelope), receivedAt);
          } catch (error) {
            console.error(JSON.stringify({
              level: "error",
              transport: "local",
              reason: "Live subscriber failed",
              message: error instanceof Error ? error.message : "Unknown error",
            }));
          }
        }
      });
    },
    async subscribe(onEnvelope) {
      subscribers.add(onEnvelope);
      return async () => {
        subscribers.delete(onEnvelope);
      };
    },
    async close() {
      subscribers.clear();
    },
  };
}

export function createEventstreamTransport(options: EventstreamTransportOptions): ClosableTransport {
  const producer = new EventHubProducerClient(options.sourceConnectionString);
  const consumer = new EventHubConsumerClient(options.consumerGroup, options.destinationConnectionString);
  const subscriptions = new Set<{ close(): Promise<void> }>();
  let malformedMessages = 0;

  return {
    name: "fabric-eventstream",
    configured: true,
    async publish(envelope) {
      const batch = await producer.createBatch();
      const payload = JSON.stringify(envelope);
      if (!batch.tryAdd({ body: payload, contentType: "application/json" })) {
        throw new Error("Live envelope exceeds Event Hubs batch size");
      }
      await producer.sendBatch(batch);
    },
    async subscribe(onEnvelope) {
      const startPosition: EventPosition = { enqueuedOn: new Date() };
      const subscription = consumer.subscribe({
        async processEvents(events) {
          for (const event of events) {
            try {
              const envelope = parseLiveEnvelope(eventHubBodyToUnknown(event.body));
              onEnvelope(envelope, Date.now());
            } catch (error) {
              malformedMessages += 1;
              console.warn(JSON.stringify({
                level: "warn",
                transport: "fabric-eventstream",
                reason: "Malformed live envelope discarded",
                malformedMessages,
                message: error instanceof Error ? error.message : "Unknown error",
              }));
            }
          }
        },
        async processError(error, context) {
          console.error(JSON.stringify({
            level: "error",
            transport: "fabric-eventstream",
            reason: "Live consumer error",
            partitionId: context.partitionId,
            message: error.message,
          }));
        },
      }, {
        startPosition,
        maxBatchSize: 25,
        maxWaitTimeInSeconds: 1,
      });

      subscriptions.add(subscription);
      return async () => {
        subscriptions.delete(subscription);
        await subscription.close();
      };
    },
    async close() {
      for (const subscription of subscriptions) {
        await subscription.close();
      }
      subscriptions.clear();
      await Promise.all([producer.close(), consumer.close()]);
    },
  };
}

function sanitizeTransportError(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message : "Eventstream publish failed";
  return message
    .replace(/SharedAccessKey=[^;\s]+/giu, "SharedAccessKey=[redacted]")
    .replace(/Endpoint=sb:\/\/[^;\s]+/giu, "Endpoint=[redacted]")
    .slice(0, 240);
}

/**
 * Publishes to Eventstream until a publish fails, then stays on the local bus.
 * Subscribers are attached to both, so the failed event is delivered locally and
 * any envelope already accepted by Eventstream can still arrive. The switch is logged once.
 */
export function createFallbackTransport(
  primary: ClosableTransport,
  fallback: ClosableTransport = createLocalTransport(),
  log: (entry: Record<string, unknown>) => void = (entry) => console.warn(JSON.stringify(entry)),
): ClosableTransport {
  let usingFallback = false;
  let fallbackReason: string | null = null;
  const subscribers = new Set<(envelope: LiveEnvelope, receivedAt: number) => void>();
  let primaryStop: (() => Promise<void>) | undefined;
  let fallbackStop: (() => Promise<void>) | undefined;
  let subscribePromise: Promise<void> | undefined;

  const fanOut = (envelope: LiveEnvelope, receivedAt: number) => {
    for (const subscriber of subscribers) {
      try {
        subscriber(cloneEnvelope(envelope), receivedAt);
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          transport: usingFallback ? "local" : "eventstream",
          reason: "Live subscriber failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }));
      }
    }
  };

  const ensureSubscribed = () => {
    subscribePromise ??= (async () => {
      primaryStop = await primary.subscribe(fanOut);
      fallbackStop = await fallback.subscribe(fanOut);
    })();
    return subscribePromise;
  };

  return {
    get name() {
      return usingFallback ? "local" as const : "eventstream" as const;
    },
    get configured() {
      return primary.configured;
    },
    get fallbackReason() {
      return fallbackReason;
    },
    async publish(envelope) {
      await ensureSubscribed();
      if (!usingFallback) {
        try {
          await primary.publish(envelope);
          return;
        } catch (error) {
          const reason = sanitizeTransportError(error);
          await fallback.publish(envelope);
          usingFallback = true;
          fallbackReason = reason;
          log({
            level: "warn",
            transport: "eventstream",
            reason: "Eventstream publish failed; switching to local bus",
            fallbackReason: reason,
          });
          return;
        }
      }
      await fallback.publish(envelope);
    },
    async subscribe(onEnvelope) {
      await ensureSubscribed();
      subscribers.add(onEnvelope);
      return async () => {
        subscribers.delete(onEnvelope);
      };
    },
    async close() {
      subscribers.clear();
      if (primaryStop) await primaryStop();
      if (fallbackStop) await fallbackStop();
      await Promise.all([primary.close(), fallback.close()]);
    },
  };
}

export function createTransportFromEnv(env: NodeJS.ProcessEnv): ClosableTransport {
  const sourceConnectionString = env.EVENTSTREAM_SOURCE_CONNECTION_STRING?.trim();
  const destinationConnectionString = env.EVENTSTREAM_DESTINATION_CONNECTION_STRING?.trim();

  if (!sourceConnectionString || !destinationConnectionString) {
    return createLocalTransport();
  }

  return createFallbackTransport(createEventstreamTransport({
    sourceConnectionString,
    destinationConnectionString,
    consumerGroup: env.EVENTSTREAM_CONSUMER_GROUP?.trim() || "$Default",
  }));
}
