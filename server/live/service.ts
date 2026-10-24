import type { MatchEvent, MatchFixture } from "../../shared/types.js";
import type {
  LiveEnvelope,
  LiveFeedSource,
  LiveStatus,
  StartLiveRequest,
  StressFeedItem,
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
import { roundTripCanonicalEvent } from "../ingest/opta/adapter.js";
import { HttpError } from "../validation.js";

type SchedulerHandle = unknown;

export interface LiveScheduler {
  setTimeout(callback: () => void, delayMs: number, options?: { unref?: boolean }): SchedulerHandle;
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
  /** Default keeps the current canonical publish path. */
  liveSource?: "canonical" | "opta-format";
  /** Idle minutes before a synthetic demo starts. 0 disables. Defaults to 0 so tests do not auto-start. */
  watchdogMinutes?: number;
};

const DEMO_SPEED = 20;
const DEMO_SEED = 20261027;
/**
 * A published envelope that has not come back from the transport within this
 * wall time is treated as lost, so one dropped Eventstream message cannot
 * freeze the received watermark for the rest of the match.
 */
const RECEIPT_TIMEOUT_MS = 10_000;
/** Longest synchronous slice of the full-time backlog drain before yielding to the event loop. */
const DRAIN_SLICE_MS = 25;
/** Keeps the watermark strictly below the first outstanding due second. */
const WATERMARK_EPSILON_SECONDS = 0.001;

function defaultScheduler(): LiveScheduler {
  return {
    setTimeout(callback, delayMs, options) {
      const handle = globalThis.setTimeout(callback, delayMs);
      if (options?.unref && typeof handle.unref === "function") handle.unref();
      return handle;
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
  const fixture = cloneFixture(view.fixture);
  // Synthetic tracking is attached up front; never expose samples beyond the live clock.
  if (fixture.tracking) fixture.tracking = { ...fixture.tracking, samples: fixture.tracking.samples.filter((sample) => sample.second <= view.clockSecond) };
  return {
    matchId: view.matchId,
    fixture,
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
  const liveSource = options.liveSource ?? "canonical";
  const watchdogMinutes = options.watchdogMinutes ?? 0;

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
  let progressive = false;
  let analyzedThrough = 0;
  let progressiveCompleted = false;
  let ending = false;
  let endReceived = false;
  let generation = 0;
  /** Closed pauses, in service-clock milliseconds. Subtracted from the wall clock so a pause does not jump the match. */
  let pausedAccumulatedMs = 0;
  /** Service-clock instant the current pause began. Undefined unless state is paused. */
  let pauseStartedAt: number | undefined;
  /** Frozen match second. Undefined unless state is paused. */
  let pausedAtSecond: number | undefined;
  /** Latest progressive analysis held while paused. Flushed on resume so events are not skipped or republished. */
  let deferredProgressive: { fixture: MatchFixture; watermark: number } | undefined;
  type FeedEntry = StressFeedItem & {
    published: boolean;
    /** Revision key of the envelope this entry produced; null when it produced none. */
    deliveredKey?: string | null;
    /** Service-clock time at which the publish call started. A send that never settles times out from here. */
    publishStartedAt?: number;
    /** Service-clock time at which the publish call settled (resolved or failed). */
    publishSettledAt?: number;
  };
  let feedPlan: FeedEntry[] = [];
  /** Feed-plan entries before this index are all received; see publishedThroughSecond(). */
  let receivedCursor = 0;
  let operationQueue: Promise<unknown> = Promise.resolve();
  const pendingEnvelopes: Array<{ envelope: LiveEnvelope; receivedAt: number }> = [];
  const publishedEvents = new Map<string, MatchEvent>();
  const manualRescissions = new Map<string, MatchEvent>();
  const acceptedRevisions = new Set<string>();
  const listeners = new Set<LiveListener>();
  const tickListeners = new Set<(view: LiveMatchView | undefined) => void>();
  const scheduledPublishes = new Set<SchedulerHandle>();
  let tickerHandle: SchedulerHandle | undefined;
  let watchdogHandle: SchedulerHandle | undefined;
  let stopConsumerPromise: Promise<() => Promise<void>> | undefined;

  const ensureSubscribed = () => {
    stopConsumerPromise ??= transport.subscribe((envelope, receivedAt) => {
      try {
        handleEnvelope(envelope, receivedAt);
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          transport: transport.name,
          reason: "Live envelope handling failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }));
      }
    });
    return stopConsumerPromise;
  };

  // The same subscription rejection is surfaced to start(), without an unhandled rejection.
  void ensureSubscribed().catch(() => undefined);

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  function matchInProgress(): boolean {
    return state === "running" || state === "paused";
  }

  function requireProgressive(fixtureId: string, matchId: string | undefined): void {
    if (!progressive || !matchInProgress() || ending || !matchId
      || currentMatchId !== matchId || activeFixture?.id !== fixtureId) {
      throw new HttpError(409, "No matching progressive live match is running");
    }
  }

  function pausedOffsetMs(): number {
    const open = pauseStartedAt === undefined ? 0 : Math.max(0, now() - pauseStartedAt);
    return pausedAccumulatedMs + open;
  }

  function clearPauseBookkeeping(): void {
    pausedAccumulatedMs = 0;
    pauseStartedAt = undefined;
    pausedAtSecond = undefined;
    deferredProgressive = undefined;
    feedPlan = [];
    receivedCursor = 0;
  }

  function revisionKey(event: MatchEvent): string {
    return `${event.id}@${event.revision}`;
  }

  function entryReceived(entry: FeedEntry): boolean {
    // A duplicate, or an envelope that arrived before its own timer fired.
    if (acceptedRevisions.has(revisionKey(entry.event))) return true;
    if (entry.publishSettledAt === undefined) {
      // A send that never resolves or rejects must not freeze the watermark.
      return entry.publishStartedAt !== undefined && now() - entry.publishStartedAt >= RECEIPT_TIMEOUT_MS;
    }
    if (entry.deliveredKey === null) return true;
    if (entry.deliveredKey !== undefined && acceptedRevisions.has(entry.deliveredKey)) return true;
    return now() - entry.publishSettledAt >= RECEIPT_TIMEOUT_MS;
  }

  /**
   * Received-event watermark for scheduled feeds. Every feed-plan entry due at
   * or before the returned second (by publishAtSecond, the feed's own due
   * time) has come back through the transport subscription, so consumers see
   * the same events a full replay would. This is receipt-based for both the
   * local bus and Eventstream: an envelope counts once the consumer accepted
   * it, and only a publish that has not been received within
   * RECEIPT_TIMEOUT_MS is skipped as lost. Stress items that are deliberately
   * late are tracked at their late due second, so they correct the future
   * rather than hold the whole overlay back. The plan is kept after the match
   * ends so the final events are received before tracking drains to "ended".
   * Without a feed plan (progressive video) the service clock is the watermark.
   */
  function publishedThroughSecond(): number {
    const duration = activeFixture?.durationSeconds ?? currentView?.fixture.durationSeconds ?? 0;
    if (!currentView) return 0;
    if (feedPlan.length === 0) return currentView.clockSecond;
    while (receivedCursor < feedPlan.length && entryReceived(feedPlan[receivedCursor]!)) receivedCursor += 1;
    if (receivedCursor >= feedPlan.length) return duration;
    return Math.max(0, Math.min(duration, feedPlan[receivedCursor]!.publishAtSecond - WATERMARK_EPSILON_SECONDS));
  }

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
    if (state === "paused" && pausedAtSecond !== undefined) {
      return Math.min(duration, pausedAtSecond);
    }
    if (progressive) {
      return Math.min(duration, analyzedThrough);
    }
    if (matchStartReceivedAt === undefined) {
      return Math.min(duration, minimumSecond);
    }
    // Pause wall time is not match time. Subtract it or resume jumps by pauseDuration * speed.
    const activeMs = Math.max(0, now() - matchStartReceivedAt - pausedOffsetMs());
    const elapsed = Math.floor((activeMs / 1000) * Math.max(currentSpeed, 0));
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

  function activeSource(): LiveFeedSource {
    if (progressive) return "video-vision";
    if (liveSource === "opta-format") return "opta-format-synthetic";
    return "synthetic";
  }

  function readFallbackReason(): string | null {
    return typeof transport.fallbackReason === "string" && transport.fallbackReason.length > 0
      ? transport.fallbackReason
      : null;
  }

  function makeStatus(): LiveStatus {
    return {
      state,
      transport: transport.name,
      transportConfigured: transport.configured,
      fallbackReason: readFallbackReason(),
      source: activeSource(),
      ...currentFixtureStatus(),
      clockSecond: state === "paused" && pausedAtSecond !== undefined
        ? pausedAtSecond
        : currentView?.clockSecond ?? computeClock(0),
      ...(state === "paused" && pausedAtSecond !== undefined ? { pausedAtSecond } : {}),
      speed: currentSpeed,
      eventsReceived,
      duplicatesIgnored,
      lastEventAt,
      lagMs,
      stress: currentStress,
    };
  }

  function clearWatchdog(): void {
    if (watchdogHandle !== undefined) {
      scheduler.clearTimeout(watchdogHandle);
      watchdogHandle = undefined;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    if (watchdogMinutes <= 0) return;
    watchdogHandle = scheduler.setTimeout(() => {
      watchdogHandle = undefined;
      void serialize(async () => {
        if (matchInProgress()) return;
        try {
          console.info(JSON.stringify({
            level: "info",
            event: "demo_watchdog",
            reason: "No live match; starting synthetic demo",
            idleMinutes: watchdogMinutes,
          }));
          await startBody({ generate: { scenario: "late_winner", seed: DEMO_SEED }, speed: DEMO_SPEED });
        } catch (error) {
          console.error(JSON.stringify({
            level: "error",
            event: "demo_watchdog",
            reason: "Synthetic demo failed to start",
            message: error instanceof Error ? error.message : "Unknown error",
          }));
          armWatchdog();
        }
      });
    }, watchdogMinutes * 60_000, { unref: true });
  }

  async function publishEnvelope(kind: LiveEnvelope["kind"], extra: Omit<LiveEnvelope, "kind" | "matchId" | "sequence" | "publishedAt" | "source"> = {}) {
    if (!currentMatchId) {
      throw new HttpError(409, "No live match is active");
    }
    const envelope: LiveEnvelope = {
      kind,
      matchId: currentMatchId,
      sequence,
      publishedAt: new Date(now()).toISOString(),
      ...extra,
      source: activeSource(),
    };
    sequence += 1;
    await transport.publish(envelope);
  }

  async function publishRescission(eventId: string): Promise<string | null> {
    const known = [
      ...(activeFixture?.events ?? []),
      ...(currentView?.fixture.events ?? []),
      ...publishedEvents.values(),
    ].filter((event) => event.id === eventId);
    const latest = known.sort((left, right) => right.revision - left.revision)[0];
    if (!latest) {
      console.warn(JSON.stringify({
        level: "warn",
        component: "opta-adapter",
        reason: "Deleted event did not match a published event",
        eventId,
      }));
      return null;
    }
    const correction = latest.rescinded
      ? latest
      : { ...latest, revision: latest.revision + 1, rescinded: true };
    const key = `${correction.id}@${correction.revision}`;
    if (publishedEvents.has(key) || acceptedRevisions.has(key)) return null;
    await publishEnvelope("match_event", { event: correction });
    return key;
  }

  /** Returns the revision key that was published, or null when nothing was. */
  async function publishFeedEvent(event: MatchEvent): Promise<string | null> {
    if (liveSource !== "opta-format") {
      await publishEnvelope("match_event", { event });
      return revisionKey(event);
    }
    const adapted = roundTripCanonicalEvent(event);
    if (adapted.kind === "correction") {
      return publishRescission(adapted.eventId);
    }
    if (adapted.kind === "ignored") {
      console.warn(JSON.stringify({
        level: "warn",
        component: "opta-adapter",
        reason: adapted.reason,
        typeId: adapted.typeId,
      }));
      return null;
    }
    await publishEnvelope("match_event", { event: adapted.event });
    return revisionKey(adapted.event);
  }

  /**
   * Publishes one feed-plan entry. The send is raced against RECEIPT_TIMEOUT_MS
   * from when it started, so a publish that never settles is skipped as lost
   * and neither the serialized queue nor the watermark freezes behind it.
   */
  async function publishPlanEntry(entry: FeedEntry): Promise<void> {
    entry.published = true;
    entry.publishStartedAt = now();
    let timer: SchedulerHandle | undefined;
    const send = publishFeedEvent(entry.event);
    try {
      const outcome = await new Promise<{ timedOut: true } | { timedOut: false; key: string | null }>((resolve, reject) => {
        timer = scheduler.setTimeout(() => resolve({ timedOut: true }), RECEIPT_TIMEOUT_MS, { unref: true });
        send.then((key) => resolve({ timedOut: false, key }), reject);
      });
      if (outcome.timedOut) {
        // Counted from the start of the send; a late resolution or rejection changes nothing.
        entry.deliveredKey = revisionKey(entry.event);
        entry.publishSettledAt = entry.publishStartedAt;
        console.warn(JSON.stringify({
          level: "warn",
          transport: transport.name,
          reason: "Live publish did not settle; skipped after receipt timeout",
          eventId: entry.event.id,
          timeoutMs: RECEIPT_TIMEOUT_MS,
        }));
        return;
      }
      entry.deliveredKey = outcome.key;
      entry.publishSettledAt = now();
    } catch (error) {
      entry.published = false;
      // Not received; the receipt timeout releases the watermark if no retry delivers it.
      entry.deliveredKey = revisionKey(entry.event);
      entry.publishSettledAt = now();
      throw error;
    } finally {
      if (timer !== undefined) scheduler.clearTimeout(timer);
    }
  }

  async function finishActiveMatch(complete = false, drainFeed = false): Promise<void> {
    clearPublishTimers();
    stopTicker();
    const previousWatermark = analyzedThrough;
    const previousState = state;
    const previousPauseStartedAt = pauseStartedAt;
    const previousPausedAtSecond = pausedAtSecond;
    ending = true;
    if (progressive && complete) {
      progressiveCompleted = true;
      analyzedThrough = activeFixture!.durationSeconds;
    }
    try {
      if (drainFeed && !progressive && currentMatchId) {
        // Full time: publish what is still due (full_time, late goals, late stress items) before match_end.
        // A backlog is drained in time-boxed slices so health probes are served between them.
        let sliceStartedAt = performance.now();
        for (const entry of feedPlan) {
          if (entry.published) continue;
          if (performance.now() - sliceStartedAt >= DRAIN_SLICE_MS) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            sliceStartedAt = performance.now();
          }
          try {
            await publishPlanEntry(entry);
          } catch (error) {
            console.error(JSON.stringify({
              level: "error",
              transport: transport.name,
              reason: "Final live event publish failed",
              eventId: entry.event.id,
              message: error instanceof Error ? error.message : "Unknown error",
            }));
          }
        }
      }
      if (currentMatchId) {
        await publishEnvelope("match_end");
      }
      state = "finished";
      pauseStartedAt = undefined;
      pausedAtSecond = undefined;
      deferredProgressive = undefined;
      // Keep sent entries so the watermark (and the tracking drain) waits for their receipt.
      // Entries that will never be sent (manual stop) must not hold it back.
      feedPlan = feedPlan.filter((entry) => entry.publishStartedAt !== undefined);
      receivedCursor = 0;
      if (progressive && !complete) {
        pendingEnvelopes.length = 0;
      }
      if (progressive && currentView) {
        currentView.clockSecond = computeClock();
      }
      notifyTick();
      armWatchdog();
    } catch (error) {
      progressiveCompleted = false;
      analyzedThrough = previousWatermark;
      endReceived = false;
      state = previousState === "paused" ? "paused" : "running";
      pauseStartedAt = previousPauseStartedAt;
      pausedAtSecond = previousPausedAtSecond;
      if (progressive && currentView) {
        currentView.clockSecond = computeClock();
      } else if (!progressive && state === "running" && currentMatchId) {
        beginTicker(currentMatchId);
      }
      throw error;
    } finally {
      ending = false;
    }
  }

  function handleEnvelope(envelope: LiveEnvelope, receivedAt: number): void {
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
      if (progressive && (currentView || (!progressiveCompleted && state !== "running"))) {
        return;
      }

      const registered = cloneFixture(registry.getFixture(activeFixture.id));
      registered.events = [];
      currentView = {
        matchId: envelope.matchId,
        fixture: registered,
        clockSecond: progressive ? computeClock() : 0,
      };
      // Follow the service clock, not the transport's Date.now(). An injected clock and the pause offset then share one timeline.
      matchStartReceivedAt = now();
      if (!progressiveCompleted && state !== "paused") {
        state = "running";
      }
      if (!progressive && state === "running") {
        beginTicker(envelope.matchId);
      }
      const snapshot = cloneView(currentView);
      for (const listener of listeners) {
        listener.onMatchStart?.(snapshot);
      }
      notifyTick();
      const pending = pendingEnvelopes.splice(0).sort((left, right) => left.envelope.sequence - right.envelope.sequence);
      for (const received of pending) {
        handleEnvelope(received.envelope, received.receivedAt);
      }
      return;
    }

    // Fabric may deliver different partitions out of order. Receipt still gates visibility.
    if (progressive && !currentView) {
      if (matchInProgress() || progressiveCompleted) {
        pendingEnvelopes.push({ envelope, receivedAt });
      }
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

    if (progressive && (endReceived || (!ending && matchInProgress()))) {
      return;
    }
    endReceived = true;
    stopTicker();
    currentView.clockSecond = progressive ? computeClock() : currentView.fixture.durationSeconds;
    state = "finished";
    const snapshot = cloneView(currentView);
    for (const listener of listeners) {
      listener.onMatchEnd?.(snapshot);
    }
    notifyTick();
  }

  async function startFixture(fixture: MatchFixture, speed: number, stress: boolean, isProgressive: boolean): Promise<void> {
    clearPublishTimers();
    stopTicker();
    activeFixture = cloneFixture(fixture);
    currentView = undefined;
    currentMatchId = `${fixture.id}-${now()}-${++generation}`;
    currentSpeed = speed;
    currentStress = stress;
    clearWatchdog();
    progressive = isProgressive;
    analyzedThrough = 0;
    progressiveCompleted = false;
    ending = false;
    endReceived = false;
    state = "running";
    sequence = 1;
    eventsReceived = 0;
    duplicatesIgnored = 0;
    lastEventAt = undefined;
    lagMs = undefined;
    matchStartReceivedAt = undefined;
    clearPauseBookkeeping();
    acceptedRevisions.clear();
    publishedEvents.clear();
    manualRescissions.clear();
    pendingEnvelopes.length = 0;

    try {
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
    } catch (error) {
      stopTicker();
      state = "idle";
      currentView = undefined;
      currentMatchId = undefined;
      activeFixture = undefined;
      pendingEnvelopes.length = 0;
      armWatchdog();
      throw error;
    }
  }

  async function startBody(request: StartLiveRequest): Promise<LiveStatus> {
    await ensureSubscribed();

    if (state === "paused") {
      throw new HttpError(409, "Live match is paused");
    }
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

    clearWatchdog();
    await startFixture(fixture, speed, Boolean(request.stress), false);

    feedPlan = buildFeedPlan(fixture, Boolean(request.stress))
      .map((item) => ({ ...item, event: { ...item.event }, published: false }))
      .sort((left, right) => left.publishAtSecond - right.publishAtSecond);
    receivedCursor = 0;
    scheduleRemaining(currentMatchId);

    return makeStatus();
  }

  function scheduleRemaining(matchId: string | undefined): void {
    clearPublishTimers();
    if (state !== "running" || !activeFixture || !matchId || currentSpeed < 1) return;
    const originSecond = Math.floor(currentView?.clockSecond ?? computeClock(0));
    for (const entry of feedPlan) {
      if (entry.published) continue;
      const delayMs = Math.max(0, Math.floor(((entry.publishAtSecond - originSecond) * 1_000) / currentSpeed));
      const timeoutHandle = scheduler.setTimeout(() => {
        scheduledPublishes.delete(timeoutHandle);
        void serialize(async () => {
          if (state !== "running" || currentMatchId !== matchId || entry.published) return;
          await publishPlanEntry(entry);
        });
      }, delayMs);
      scheduledPublishes.add(timeoutHandle);
    }

    const endDelayMs = Math.max(0, Math.floor(((activeFixture.durationSeconds - originSecond) * 1_000) / currentSpeed));
    const endHandle = scheduler.setTimeout(() => {
      scheduledPublishes.delete(endHandle);
      void serialize(async () => {
        if (state === "running" && currentMatchId === matchId) {
          await finishActiveMatch(false, true);
        }
      });
    }, endDelayMs);
    scheduledPublishes.add(endHandle);
  }

  function notifyControl(kind: "pause" | "resume"): void {
    const snapshot = currentView ? cloneView(currentView) : undefined;
    for (const listener of listeners) {
      if (kind === "pause") listener.onPause?.(snapshot);
      else listener.onResume?.(snapshot);
    }
    notifyTick();
  }

  function assertProgressiveWatermark(supplied: MatchFixture, watermark: number): void {
    const floor = Math.max(analyzedThrough, deferredProgressive?.watermark ?? 0);
    if (!Number.isFinite(watermark) || watermark < floor || watermark < 0
      || !Number.isFinite(supplied.durationSeconds) || supplied.durationSeconds <= 0
      || watermark > supplied.durationSeconds) {
      throw new HttpError(400, "Analysis watermark must be finite, monotonic, and within the fixture duration");
    }
  }

  async function applyProgressiveUpdate(supplied: MatchFixture, watermark: number, matchId: string): Promise<void> {
    supplied.events = supplied.events.filter((event) => !manualRescissions.has(event.id));
    supplied.events.push(...[...manualRescissions.values()].map((event) => ({ ...event })));
    registry.registerFixture(supplied);
    activeFixture = cloneFixture(supplied);
    analyzedThrough = watermark;
    if (currentView) {
      currentView.fixture = { ...cloneFixture(supplied), events: currentView.fixture.events };
      currentView.clockSecond = computeClock();
    }

    for (const event of supplied.events) {
      requireProgressive(supplied.id, matchId);
      const key = `${event.id}@${event.revision}`;
      if (publishedEvents.has(key) || acceptedRevisions.has(key)) {
        continue;
      }
      await publishEnvelope("match_event", { event });
      publishedEvents.set(key, { ...event });
    }
    notifyTick();
  }

  function freezeClock(): number {
    if (currentView && !progressive) {
      currentView.clockSecond = computeClock(Math.floor(currentView.clockSecond));
    }
    const frozen = Math.floor(currentView?.clockSecond ?? computeClock(0));
    if (currentView) currentView.clockSecond = frozen;
    return frozen;
  }

  async function pauseBody(): Promise<LiveStatus> {
    if (state === "paused") return makeStatus();
    if (state !== "running" || !currentMatchId) {
      throw new HttpError(409, "Live match is not running");
    }
    pausedAtSecond = freezeClock();
    pauseStartedAt = now();
    state = "paused";
    clearPublishTimers();
    stopTicker();
    console.info(JSON.stringify({
      level: "info",
      event: "live.pause",
      matchId: currentMatchId,
      pausedAtSecond,
      transport: transport.name,
    }));
    notifyControl("pause");
    return makeStatus();
  }

  async function resumeBody(): Promise<LiveStatus> {
    if (state !== "paused" || !currentMatchId) {
      throw new HttpError(409, "Live match is not paused");
    }
    if (pauseStartedAt !== undefined) {
      pausedAccumulatedMs += Math.max(0, now() - pauseStartedAt);
      pauseStartedAt = undefined;
    }
    const frozen = pausedAtSecond ?? Math.floor(currentView?.clockSecond ?? 0);
    pausedAtSecond = undefined;
    state = "running";
    if (currentView) {
      currentView.clockSecond = progressive ? computeClock() : computeClock(frozen);
    }
    const matchId = currentMatchId;
    const deferred = deferredProgressive;
    deferredProgressive = undefined;
    if (!progressive) {
      scheduleRemaining(matchId);
      beginTicker(matchId);
    } else if (deferred) {
      await applyProgressiveUpdate(deferred.fixture, deferred.watermark, matchId);
    }
    console.info(JSON.stringify({
      level: "info",
      event: "live.resume",
      matchId,
      clockSecond: currentView?.clockSecond ?? frozen,
      transport: transport.name,
    }));
    notifyControl("resume");
    return makeStatus();
  }

  armWatchdog();

  return {
    status() {
      return makeStatus();
    },
    current() {
      return currentView ? cloneView(currentView) : undefined;
    },
    publishedThroughSecond() {
      return publishedThroughSecond();
    },
    start(request) {
      return serialize(() => startBody(request));
    },
    startProgressive(fixture) {
      const supplied = cloneFixture(fixture);
      return serialize(async () => {
        await ensureSubscribed();
        if (state === "paused") {
          throw new HttpError(409, "Live match is paused");
        }
        if (state === "running") {
          throw new HttpError(409, "Live match already running");
        }
        if (!Number.isFinite(supplied.durationSeconds) || supplied.durationSeconds <= 0) {
          throw new HttpError(400, "durationSeconds must be finite and positive");
        }
        registry.registerFixture(supplied);
        await startFixture(supplied, 0, false, true);
        return makeStatus();
      });
    },
    appendProgressive(fixture, watermark) {
      const matchId = currentMatchId;
      const supplied = cloneFixture(fixture);
      return serialize(async () => {
        requireProgressive(supplied.id, matchId);
        assertProgressiveWatermark(supplied, watermark);
        if (state === "paused") {
          deferredProgressive = { fixture: supplied, watermark };
          return makeStatus();
        }
        await applyProgressiveUpdate(supplied, watermark, matchId!);
        return makeStatus();
      });
    },
    completeProgressive(fixtureId) {
      const matchId = currentMatchId;
      return serialize(async () => {
        requireProgressive(fixtureId, matchId);
        await finishActiveMatch(true);
        return makeStatus();
      });
    },
    stop() {
      const matchId = currentMatchId;
      return serialize(async () => {
        if (!matchInProgress() || currentMatchId !== matchId) {
          return makeStatus();
        }
        await finishActiveMatch();
        return makeStatus();
      });
    },
    pause() {
      return serialize(() => pauseBody());
    },
    resume() {
      return serialize(() => resumeBody());
    },
    publishCorrection(eventId) {
      const matchId = currentMatchId;
      return serialize(async () => {
        if (!currentView || !currentMatchId) {
          throw new HttpError(404, "Live match not found");
        }
        if (matchId !== currentMatchId) {
          throw new HttpError(409, "Live match has changed");
        }

        const currentGoal = currentGoalRevision([
          ...currentView.fixture.events,
          ...publishedEvents.values(),
        ], eventId);
        if (!currentGoal) {
          throw new HttpError(404, "Goal event not found");
        }
        if (currentGoal.rescinded) {
          throw new HttpError(409, "Goal has already been rescinded");
        }

        const correction = { ...currentGoal, revision: currentGoal.revision + 1, rescinded: true };
        await publishEnvelope("match_event", { event: correction });
        if (progressive) {
          publishedEvents.set(`${eventId}@${correction.revision}`, correction);
          manualRescissions.set(eventId, correction);
          if (activeFixture) {
            activeFixture.events = activeFixture.events.filter((event) => event.id !== eventId);
            activeFixture.events.push(correction);
            registry.registerFixture(activeFixture);
          }
        }
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
    close() {
      return serialize(async () => {
        clearWatchdog();
        clearPublishTimers();
        stopTicker();
        state = "finished";
        currentMatchId = undefined;
        pendingEnvelopes.length = 0;
        const stopConsumer = stopConsumerPromise ? await stopConsumerPromise : undefined;
        if (stopConsumer) {
          await stopConsumer();
        }
        if (isClosableTransport(transport)) {
          await transport.close();
        }
      });
    },
  };
}
