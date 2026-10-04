import type { MatchEvent, MatchFixture } from "../../shared/types.js";
import type {
  LiveEnvelope,
  LiveStatus,
  StartLiveRequest,
} from "../../shared/platform.js";
import type {
  BuildFeedPlan,
  FixtureRegistry,
  GenerateMatch,
  LiveListener,
  LiveMatchView,
  LiveService,
  LiveTransportClient,
} from "../contracts.js";
import { HttpError } from "../validation.js";

type SchedulerHandle = unknown;

export interface LiveScheduler {
  setTimeout(callback: () => void, delayMs: number): SchedulerHandle;
  clearTimeout(handle: SchedulerHandle): void;
  setInterval(callback: () => void, intervalMs: number): SchedulerHandle;
  clearInterval(handle: SchedulerHandle): void;
}

export interface TickSource {
  subscribeTicks(listener: (view: LiveMatchView | undefined) => void): () => void;
}

type CreateLiveServiceOptions = {
  transport: LiveTransportClient;
  registry: FixtureRegistry;
  generateMatch: GenerateMatch;
  buildFeedPlan: BuildFeedPlan;
  now?: () => number;
  scheduler?: LiveScheduler;
};

function defaultScheduler(): LiveScheduler {
  return {
    setTimeout(callback, delayMs) {
      return globalThis.setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    },
    setInterval(callback, intervalMs) {
      return globalThis.setInterval(callback, intervalMs);
    },
    clearInterval(handle) {
      clearInterval(handle as NodeJS.Timeout);
    },
  };
}

function cloneFixture(fixture: MatchFixture): MatchFixture {
  return {
    ...fixture,
    home: { ...fixture.home, players: fixture.home.players.map((player) => ({ ...player })) },
    away: { ...fixture.away, players: fixture.away.players.map((player) => ({ ...player })) },
    events: fixture.events.map((event) => ({ ...event })),
  };
}

function cloneView(view: LiveMatchView): LiveMatchView {
  return {
    matchId: view.matchId,
    fixture: cloneFixture(view.fixture),
    clockSecond: view.clockSecond,
  };
}

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function insertSorted(events: MatchEvent[], event: MatchEvent): void {
  events.push({ ...event });
  events.sort((left, right) => {
    return eventSecond(left) - eventSecond(right)
      || left.id.localeCompare(right.id)
      || left.revision - right.revision;
  });
}

function currentGoalRevision(events: MatchEvent[], eventId: string): MatchEvent | undefined {
  return events
    .filter((event) => event.id === eventId && event.type === "goal")
    .sort((left, right) => right.revision - left.revision)[0];
}

function isClosableTransport(transport: LiveTransportClient): transport is LiveTransportClient & { close(): Promise<void> } {
  return "close" in transport && typeof transport.close === "function";
}

export function createLiveService(options: CreateLiveServiceOptions): LiveService & TickSource {
  const transport = options.transport;
  const registry = options.registry;
  const generateMatch = options.generateMatch;
  const buildFeedPlan = options.buildFeedPlan;
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler();

  let state: LiveStatus["state"] = "idle";
  let activeFixture: MatchFixture | undefined;
  let currentView: LiveMatchView | undefined;
  let currentMatchId: string | undefined;
  let currentSpeed = 0;
  let currentStress = false;
  let sequence = 1;
  let eventsReceived = 0;
  let duplicatesIgnored = 0;
  let lastEventAt: string | undefined;
  let lagMs: number | undefined;
  let matchStartReceivedAt: number | undefined;
  const acceptedRevisions = new Set<string>();
  const listeners = new Set<LiveListener>();
  const tickListeners = new Set<(view: LiveMatchView | undefined) => void>();
  const scheduledPublishes = new Set<SchedulerHandle>();
  let tickerHandle: SchedulerHandle | undefined;
  let stopConsumerPromise: Promise<() => Promise<void>> | undefined;

  const ensureSubscribed = () => {
    stopConsumerPromise ??= transport.subscribe((envelope, receivedAt) => {
      void handleEnvelope(envelope, receivedAt).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          transport: transport.name,
          reason: "Live envelope handling failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }));
      });
    });
    return stopConsumerPromise;
  };

  void ensureSubscribed();

  function clearPublishTimers(): void {
    for (const handle of scheduledPublishes) {
      scheduler.clearTimeout(handle);
    }
    scheduledPublishes.clear();
  }

  function stopTicker(): void {
    if (tickerHandle !== undefined) {
      scheduler.clearInterval(tickerHandle);
      tickerHandle = undefined;
    }
  }

  function computeClock(minimumSecond = 0): number {
    const duration = activeFixture?.durationSeconds ?? currentView?.fixture.durationSeconds ?? 0;
    if (matchStartReceivedAt === undefined) {
      return Math.min(duration, minimumSecond);
    }
    const elapsed = Math.floor(((now() - matchStartReceivedAt) / 1000) * Math.max(currentSpeed, 0));
    return Math.min(duration, Math.max(minimumSecond, elapsed));
  }

  function notifyTick(): void {
    const snapshot = currentView ? cloneView(currentView) : undefined;
    for (const listener of tickListeners) {
      listener(snapshot);
    }
  }

  function beginTicker(matchId: string): void {
    stopTicker();
    tickerHandle = scheduler.setInterval(() => {
      if (state !== "running" || !currentView || currentView.matchId !== matchId) {
        return;
      }
      currentView.clockSecond = computeClock(Math.floor(currentView.clockSecond));
      notifyTick();
    }, 1_000);
  }

  function currentFixtureStatus(): Pick<LiveStatus, "fixtureId" | "title" | "matchId"> {
    return {
      fixtureId: activeFixture?.id ?? currentView?.fixture.id,
      title: activeFixture?.title ?? currentView?.fixture.title,
      matchId: currentMatchId,
    };
  }

  function makeStatus(): LiveStatus {
    return {
      state,
      transport: transport.name,
      transportConfigured: transport.configured,
      ...currentFixtureStatus(),
      clockSecond: currentView?.clockSecond ?? computeClock(0),
      speed: currentSpeed,
      eventsReceived,
      duplicatesIgnored,
      lastEventAt,
      lagMs,
      stress: currentStress,
    };
  }

  async function publishEnvelope(kind: LiveEnvelope["kind"], extra: Omit<LiveEnvelope, "kind" | "matchId" | "sequence" | "publishedAt"> = {}) {
    if (!currentMatchId) {
      throw new HttpError(409, "No live match is active");
    }
    const envelope: LiveEnvelope = {
      kind,
      matchId: currentMatchId,
      sequence,
      publishedAt: new Date(now()).toISOString(),
      ...extra,
    };
    sequence += 1;
    await transport.publish(envelope);
  }

  async function finishActiveMatch(): Promise<void> {
    clearPublishTimers();
    stopTicker();
    state = "finished";
    if (currentMatchId) {
      await publishEnvelope("match_end");
    }
  }

  async function handleEnvelope(envelope: LiveEnvelope, receivedAt: number): Promise<void> {
    if (envelope.kind !== "match_start" && envelope.matchId !== currentMatchId) {
      return;
    }
    if (envelope.kind === "match_start" && currentMatchId !== envelope.matchId) {
      return;
    }

    lagMs = Math.max(0, receivedAt - Date.parse(envelope.publishedAt));

    if (envelope.kind === "match_start") {
      if (!activeFixture) {
        return;
      }

      const registered = cloneFixture(registry.getFixture(activeFixture.id));
      registered.events = [];
      currentView = {
        matchId: envelope.matchId,
        fixture: registered,
        clockSecond: 0,
      };
      matchStartReceivedAt = receivedAt;
      state = "running";
      beginTicker(envelope.matchId);
      const snapshot = cloneView(currentView);
      for (const listener of listeners) {
        listener.onMatchStart?.(snapshot);
      }
      notifyTick();
      return;
    }

    if (envelope.kind === "match_event") {
      if (!currentView) {
        return;
      }
      const event = envelope.event;
      if (!event) {
        return;
      }

      lastEventAt = new Date(receivedAt).toISOString();
      const key = `${event.id}@${event.revision}`;
      if (acceptedRevisions.has(key)) {
        duplicatesIgnored += 1;
        return;
      }

      acceptedRevisions.add(key);
      eventsReceived += 1;
      insertSorted(currentView.fixture.events, event);
      currentView.clockSecond = computeClock(eventSecond(event));

      const snapshot = cloneView(currentView);
      for (const listener of listeners) {
        listener.onEvent(snapshot, { ...event });
      }
      return;
    }

    if (!currentView) {
      return;
    }

    stopTicker();
    currentView.clockSecond = currentView.fixture.durationSeconds;
    state = "finished";
    const snapshot = cloneView(currentView);
    for (const listener of listeners) {
      listener.onMatchEnd?.(snapshot);
    }
    notifyTick();
  }

  return {
    status() {
      return makeStatus();
    },
    current() {
      return currentView ? cloneView(currentView) : undefined;
    },
    async start(request) {
      await ensureSubscribed();

      if (state === "running") {
        throw new HttpError(409, "Live match already running");
      }

      const speed = Math.floor(request.speed);
      if (!Number.isInteger(speed) || speed < 1 || speed > 60) {
        throw new HttpError(400, "speed must be an integer between 1 and 60");
      }

      const fixture = request.fixtureId
        ? (() => {
          try {
            return registry.getFixture(request.fixtureId as string);
          } catch (error) {
            if (error instanceof RangeError) {
              throw new HttpError(404, "Fixture not found");
            }
            throw error;
          }
        })()
        : (() => {
          if (!request.generate) {
            throw new HttpError(400, "Exactly one of fixtureId or generate is required");
          }
          const generated = generateMatch(request.generate);
          registry.registerFixture(generated);
          return generated;
        })();

      clearPublishTimers();
      stopTicker();
      activeFixture = cloneFixture(fixture);
      currentView = undefined;
      currentMatchId = `${fixture.id}-${now()}`;
      currentSpeed = speed;
      currentStress = Boolean(request.stress);
      state = "running";
      sequence = 1;
      eventsReceived = 0;
      duplicatesIgnored = 0;
      lastEventAt = undefined;
      lagMs = undefined;
      matchStartReceivedAt = undefined;
      acceptedRevisions.clear();

      await publishEnvelope("match_start", {
        fixture: {
          id: fixture.id,
          title: fixture.title,
          description: fixture.description,
          home: fixture.home,
          away: fixture.away,
          durationSeconds: fixture.durationSeconds,
          eventCount: fixture.events.length,
          correctionAvailableAt: fixture.correctionAvailableAt,
        },
      });

      const matchId = currentMatchId;
      for (const item of buildFeedPlan(fixture, Boolean(request.stress))) {
        const timeoutHandle = scheduler.setTimeout(() => {
          scheduledPublishes.delete(timeoutHandle);
          if (state !== "running" || currentMatchId !== matchId) {
            return;
          }
          void publishEnvelope("match_event", { event: item.event });
        }, Math.max(0, Math.floor((item.publishAtSecond * 1_000) / speed)));
        scheduledPublishes.add(timeoutHandle);
      }

      const endHandle = scheduler.setTimeout(() => {
        scheduledPublishes.delete(endHandle);
        if (state !== "running" || currentMatchId !== matchId) {
          return;
        }
        void finishActiveMatch();
      }, Math.max(0, Math.floor((fixture.durationSeconds * 1_000) / speed)));
      scheduledPublishes.add(endHandle);

      return makeStatus();
    },
    async stop() {
      if (state !== "running") {
        return makeStatus();
      }
      await finishActiveMatch();
      return makeStatus();
    },
    async publishCorrection(eventId) {
      if (!currentView || !currentMatchId) {
        throw new HttpError(404, "Live match not found");
      }

      const currentGoal = currentGoalRevision(currentView.fixture.events, eventId);
      if (!currentGoal) {
        throw new HttpError(404, "Goal event not found");
      }
      if (currentGoal.rescinded) {
        throw new HttpError(409, "Goal has already been rescinded");
      }

      await publishEnvelope("match_event", {
        event: {
          ...currentGoal,
          revision: currentGoal.revision + 1,
          rescinded: true,
        },
      });
    },
    addListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeTicks(listener) {
      tickListeners.add(listener);
      return () => {
        tickListeners.delete(listener);
      };
    },
    async close() {
      clearPublishTimers();
      stopTicker();
      const stopConsumer = stopConsumerPromise ? await stopConsumerPromise : undefined;
      if (stopConsumer) {
        await stopConsumer();
      }
      if (isClosableTransport(transport)) {
        await transport.close();
      }
    },
  };
}
