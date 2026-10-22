import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Express matches routes case-insensitively and ignores a trailing slash.
 * The raw request path does not, so compare a normalized path or the guard misses `/API/LIVE/STOP`.
 */
export function normalizeAuthPath(path: string): string {
  const pathname = path.split("?")[0] ?? "/";
  return (pathname.replace(/\/+$/u, "") || "/").toLowerCase();
}

/**
 * Producer surfaces that need the studio token when one is configured.
 * Fan reads, overlay, tracking, health, narration and `/api/studio/auth-required` stay public.
 * The studio-role live stream is not rejected here: a missing token falls back to the fan projection.
 */
export function requiresStudioAuth(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const pathname = normalizeAuthPath(path);
  if (pathname === "/api/studio/auth-required") return false;
  if (pathname === "/api/studio" || pathname.startsWith("/api/studio/")) return true;
  if (!MUTATING.has(verb)) return false;
  if (pathname === "/api/live/start" || pathname === "/api/live/stop" || pathname === "/api/live/correction") return true;
  if (pathname.startsWith("/api/video")) return true;
  if (pathname.startsWith("/api/player-cam")) return true;
  if (pathname === "/api/matchlab/generate") return true;
  return false;
}

export function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
  return match?.[1] ?? "";
}

/** Constant-time compare. A length mismatch still touches the expected secret and returns false. */
export function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Open when no token is configured. Otherwise only the Authorization bearer may match.
 * The long-lived studio token is never read from the query string.
 */
export function studioAccessGranted(authorization: string | undefined, expected: string | undefined): boolean {
  const secret = expected?.trim() ?? "";
  if (!secret) return true;
  const fromHeader = bearerToken(authorization);
  return fromHeader.length > 0 && tokensMatch(fromHeader, secret);
}

function rejectStudio(response: { setHeader(name: string, value: string): void; status(code: number): { json(body: unknown): void } }): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="studio"');
  response.status(401).json({ error: "Studio authorization required" });
}

/** Path-agnostic guard. Mount it on the producer route itself so Express's case-insensitive match is the boundary. */
export function requireStudioToken(token: string | undefined): RequestHandler {
  const expected = token?.trim() ?? "";
  return (request, response, next) => {
    if (studioAccessGranted(request.header("authorization"), expected)) {
      next();
      return;
    }
    rejectStudio(response);
  };
}

export function createStudioAuth(token: string | undefined): RequestHandler {
  const expected = token?.trim() ?? "";
  const required = expected.length > 0;
  return (request, response, next) => {
    if (!required || !requiresStudioAuth(request.method, request.path)) {
      next();
      return;
    }
    if (!studioAccessGranted(request.header("authorization"), expected)) {
      rejectStudio(response);
      return;
    }
    next();
  };
}

export function studioAuthRequired(token: string | undefined): boolean {
  return Boolean(token?.trim());
}
