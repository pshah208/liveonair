import { ZodError } from "zod";

/** Failure classes the director re-routes on. Anything unrecognised is treated as the agent being unavailable. */
export type ErrorClass = "timeout" | "rate_limit" | "schema_invalid" | "guard_reject" | "unavailable";

export type RecoveryAction = "retry" | "retry_with_feedback" | "skip_optional" | "english_only" | "escalate_review" | "policy_fallback" | "fail";

export class AgentTimeoutError extends Error {
  constructor(agent: string, timeoutMs: number) {
    super(`${agent} timed out after ${timeoutMs} ms`);
    this.name = "AgentTimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(agent: string, readonly retryAt: number) {
    super(`${agent} circuit is open`);
    this.name = "CircuitOpenError";
  }
}

export class GuardRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRejectError";
  }
}

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof GuardRejectError) return "guard_reject";
  if (error instanceof CircuitOpenError) return "unavailable";
  if (error instanceof AgentTimeoutError) return "timeout";
  if (error instanceof ZodError || error instanceof SyntaxError) return "schema_invalid";
  const status = (error as { status?: unknown } | undefined)?.status;
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|timed out|AbortError/iu.test(name) || /timed out|timeout|deadline/iu.test(message)) return "timeout";
  if (/rate limit|too many requests/iu.test(message)) return "rate_limit";
  if (/schema|invalid json|unexpected token|did not complete|exceeded tool-call budget/iu.test(message)) return "schema_invalid";
  return "unavailable";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown agent error";
}

type BreakerState = { failures: number; openUntil: number };

export type CircuitBreakerOptions = {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
};

/**
 * Per-agent circuit breaker: after `threshold` consecutive failures the agent is skipped for `cooldownMs`,
 * then one trial call is allowed (half-open); a success closes it, a failure re-opens it.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, BreakerState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  private stateFor(agent: string): BreakerState {
    let state = this.states.get(agent);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      this.states.set(agent, state);
    }
    return state;
  }

  status(agent: string): "closed" | "open" | "half_open" {
    const state = this.stateFor(agent);
    if (state.failures < this.threshold) return "closed";
    return this.now() < state.openUntil ? "open" : "half_open";
  }

  canCall(agent: string): boolean {
    return this.status(agent) !== "open";
  }

  /** Throws CircuitOpenError while the agent's circuit is open. */
  assertCanCall(agent: string): void {
    if (!this.canCall(agent)) {
      throw new CircuitOpenError(agent, this.stateFor(agent).openUntil);
    }
  }

  recordSuccess(agent: string): void {
    const state = this.stateFor(agent);
    state.failures = 0;
    state.openUntil = 0;
  }

  recordFailure(agent: string): void {
    const state = this.stateFor(agent);
    state.failures += 1;
    if (state.failures >= this.threshold) {
      state.openUntil = this.now() + this.cooldownMs;
    }
  }

  snapshot(): Record<string, "closed" | "open" | "half_open"> {
    return Object.fromEntries([...this.states.keys()].map((agent) => [agent, this.status(agent)]));
  }
}

/** Races an agent call against a timeout so a hung model call cannot stall the desk queue. */
export async function withTimeout<T>(agent: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentTimeoutError(agent, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether a failed call of this class is worth one more attempt before re-routing. */
export function isRetryable(errorClass: ErrorClass): boolean {
  return errorClass === "timeout" || errorClass === "rate_limit" || errorClass === "schema_invalid";
}
