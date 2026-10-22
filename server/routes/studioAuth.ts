import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * State-changing producer surfaces. Fan View and every GET stay public.
 * Live control is start/stop/correction only. Narration and analysis stay on their own limiters.
 */
export function requiresStudioAuth(method: string, path: string): boolean {
  if (!MUTATING.has(method.toUpperCase())) return false;
  const pathname = path.split("?")[0]?.replace(/\/+$/u, "") || "/";
  if (pathname.startsWith("/api/studio")) return true;
  if (pathname === "/api/live/start" || pathname === "/api/live/stop" || pathname === "/api/live/correction") return true;
  if (pathname.startsWith("/api/video")) return true;
  if (pathname.startsWith("/api/player-cam")) return true;
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

export function createStudioAuth(token: string | undefined): RequestHandler {
  const expected = token?.trim() ?? "";
  const required = expected.length > 0;
  return (request, response, next) => {
    if (!required || !requiresStudioAuth(request.method, request.path)) {
      next();
      return;
    }
    if (!tokensMatch(bearerToken(request.header("authorization")), expected)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="studio"');
      response.status(401).json({ error: "Studio authorization required" });
      return;
    }
    next();
  };
}

export function studioAuthRequired(token: string | undefined): boolean {
  return Boolean(token?.trim());
}
