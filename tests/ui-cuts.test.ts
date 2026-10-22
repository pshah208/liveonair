import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { api, ApiError, applyStudioAuth, fetchStudioStreamTicket, getStudioToken, isStudioReadPath, PRODUCER_TOKEN_REQUIRED, setStudioToken, STUDIO_TOKEN_KEY } from "../src/api.js";
import { clipTitle, BIG_CHANCE_LABEL } from "../src/highlightRenderer.js";
import { scenarioLabel, SYNTHETIC_BADGE_TEXT, transportBadge } from "../src/utils.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function sourceFiles(dir: string): string[] {
  const root = new URL(`../${dir}`, import.meta.url);
  return readdirSync(root).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(new URL(`../${rel}`, import.meta.url)).isDirectory() ? sourceFiles(rel) : /\.(tsx?|css)$/.test(name) ? [rel] : [];
  });
}

// ---- cut surfaces -------------------------------------------------------

test("VAR Desk is gone from the app shell and its page is deleted", () => {
  assert.equal(existsSync(new URL("../src/VarDeskPage.tsx", import.meta.url)), false);
  const app = read("src/App.tsx");
  const components = read("src/components.tsx");
  for (const source of [app, components]) {
    assert.doesNotMatch(source, /VarDeskPage|VAR Desk|"var"/);
  }
});

test("removed insight panels and their components are deleted", () => {
  for (const file of ["src/ChanceInsightCard.tsx", "src/fan/ChanceBuildUpCard.tsx", "src/PlayerIdTags.tsx"]) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  }
  const fan = read("src/FanPage.tsx");
  assert.doesNotMatch(fan, /ChanceBuildUpCard|ChanceInsight/);
  assert.doesNotMatch(read("src/api.ts"), /getChanceInsights|chance-insights/);
});

test("no user-facing Premier League wording remains in src", () => {
  for (const file of sourceFiles("src")) {
    assert.doesNotMatch(read(file), /Premier League/, file);
  }
});

test("sprint counts are not rendered and tracking labels say synthetic", () => {
  const analysis = read("src/PlayerAnalysis.tsx");
  assert.doesNotMatch(analysis, /SPRINT_THRESHOLD_KMH/);
  assert.match(analysis, /Distance \(synthetic minute aggregate\)/);
  assert.match(analysis, /Top speed \(synthetic peak-speed milestone\)/);
  for (const file of sourceFiles("src").filter((name) => name.endsWith(".tsx"))) {
    assert.doesNotMatch(read(file), /"Sprints?\b|>\s*Sprints?\b/, file);
  }
});

test("metric labels use the illustrative wording", () => {
  const analysis = read("src/PlayerAnalysis.tsx");
  for (const label of ["xG assisted (inferred creator)", "Passes gaining ≥15 grid units", "Illustrative activity score", "illustrative, uncalibrated", "illustrative xG"]) {
    assert.ok(analysis.includes(label), label);
  }
  assert.doesNotMatch(analysis, /"xA"|Impact rating|Progressive passes/);
  const components = read("src/components.tsx");
  assert.match(components, /label: "illustrative xG"/);
  assert.match(components, /Completion vs heuristic \(illustrative, uncalibrated\)/);
  assert.doesNotMatch(components, /expected performance/i);
  assert.match(read("src/HighlightReel.tsx"), /High illustrative xG shot/);
});

test("Fan View and Studio Desk both show the synthetic badge", () => {
  assert.equal(SYNTHETIC_BADGE_TEXT, "Synthetic match · fictional · illustrative analytics");
  assert.match(read("src/components.tsx"), /export function SyntheticBadge/);
  assert.match(read("src/FanPage.tsx"), /<SyntheticBadge compact \/>/);
  // Studio renders BroadcastBar, which carries the compact badge and the transport badge.
  const components = read("src/components.tsx");
  assert.match(components, /export function BroadcastBar[\s\S]*<TransportSourceBadge status=\{status\} \/>[\s\S]*<SyntheticBadge compact \/>/);
  assert.match(read("src/StudioPage.tsx"), /<BroadcastBar[^>]*status=\{status\}/);
});

test("Big chance clips are relabelled in the UI without touching the shared highlight builder", () => {
  assert.equal(clipTitle({ kind: "big_chance", title: "Big chance" }), BIG_CHANCE_LABEL);
  assert.equal(clipTitle({ kind: "big_chance", title: "Gran ocasión" }), "Gran ocasión");
  assert.equal(clipTitle({ kind: "goal", title: "GOAL" }), "GOAL");
});

// ---- transport/source badge ------------------------------------------------

test("transportBadge tolerates missing fields and maps the transport names", () => {
  const none = { transport: null, source: null };
  assert.deepEqual(transportBadge(null), none);
  assert.deepEqual(transportBadge({}), none);
  assert.deepEqual(transportBadge({ state: "running" }), none);
  assert.deepEqual(transportBadge({ transport: "fabric-eventstream" }), { transport: "eventstream", source: null });
  assert.deepEqual(transportBadge({ transport: "eventstream", source: "synthetic" }), { transport: "eventstream", source: "synthetic" });
  assert.deepEqual(transportBadge({ transport: "local" }), { transport: "local", source: null });
  assert.deepEqual(transportBadge({ transport: "carrier-pigeon", source: "  replay  " }), { transport: null, source: "replay" });
  assert.deepEqual(transportBadge({ source: 42 }), none);
});

test("scripted scenarios are labelled staged", () => {
  assert.match(scenarioLabel("late_winner"), /^late winner \(staged\)$/);
});

// ---- studio auth client -----------------------------------------------------

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => { map.delete(key); },
    setItem: (key, value) => { map.set(key, String(value)); }
  };
}

async function withEnv<T>(fetchImpl: typeof fetch, run: (calls: Request[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const hadStorage = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const originalStorage = hadStorage ? Object.getOwnPropertyDescriptor(globalThis, "localStorage") : undefined;
  const calls: Request[] = [];
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(new URL(String(input), "http://localhost"), init));
    return fetchImpl(input, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("mutations and studio reads carry the stored producer token; public GETs do not", async () => {
  await withEnv(async () => json({ state: "idle" }), async (calls) => {
    setStudioToken("  secret-token  ");
    assert.equal(getStudioToken(), "secret-token");
    assert.equal(globalThis.localStorage.getItem(STUDIO_TOKEN_KEY), "secret-token");
    await api.getLiveStatus();
    await api.stopLive();
    await api.getStudioAuthRequired();
    await api.getStudioStorylines();
    assert.equal(calls[0].headers.get("Authorization"), null);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[2].headers.get("Authorization"), null);
    assert.equal(new URL(calls[2].url).pathname, "/api/studio/auth-required");
    assert.equal(calls[3].headers.get("Authorization")?.startsWith("Bearer "), true);
    assert.equal(calls[3].headers.get("Authorization")?.endsWith("secret-token"), true);
    assert.equal(calls[1].headers.get("Authorization"), "Bearer secret-token");
    setStudioToken("");
    assert.equal(globalThis.localStorage.getItem(STUDIO_TOKEN_KEY), null);
  });
});

test("applyStudioAuth skips public GET/HEAD and requests without a token", () => {
  const headers = new Headers();
  applyStudioAuth(headers, "POST");
  assert.equal(headers.get("Authorization"), null, "no storage in Node means no token");
  applyStudioAuth(headers, "GET");
  assert.equal(headers.get("Authorization"), null);
  applyStudioAuth(headers, "GET", "/api/studio/storylines");
  assert.equal(headers.get("Authorization"), null);
  assert.equal(isStudioReadPath("/api/studio/auth-required"), false);
  assert.equal(isStudioReadPath("/API/STUDIO/STORYLINES/"), true);
});

test("studio EventSource fetches a one-time ticket and never puts the producer token in a URL", async () => {
  await withEnv(async () => json({ ticket: "short-ticket", expiresInSeconds: 60 }), async (calls) => {
    setStudioToken("secret-token");
    assert.equal(await fetchStudioStreamTicket(), "short-ticket");
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/studio/stream-ticket");
    assert.equal(url.search, "");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("Authorization"), "Bearer secret-token");
    assert.match(read("src/hooks/useLiveStream.ts"), /fetchStudioStreamTicket/);
    assert.match(read("src/hooks/useLiveStream.ts"), /params\.set\("ticket"/);
    assert.doesNotMatch(read("src/hooks/useLiveStream.ts"), /token=/);
    assert.doesNotMatch(read("src/api.ts"), /token=/);
    assert.match(read("src/StudioNotices.tsx"), /setStudioToken\(value\)/);
  });
});

test("a 401 surfaces a clear Producer token required error", async () => {
  await withEnv(async () => json({ error: "unauthorized" }, 401), async () => {
    await assert.rejects(api.stopLive(), (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === PRODUCER_TOKEN_REQUIRED);
  });
});

test("auth-required is tolerant: 404 or a network error means not required", async () => {
  await withEnv(async () => json({ error: "not found" }, 404), async (calls) => {
    assert.equal(await api.getStudioAuthRequired(), false);
    assert.equal(new URL(calls[0].url).pathname, "/api/studio/auth-required");
  });
  await withEnv(async () => { throw new TypeError("offline"); }, async () => {
    assert.equal(await api.getStudioAuthRequired(), false);
  });
  await withEnv(async () => json({ required: "yes" }), async () => {
    assert.equal(await api.getStudioAuthRequired(), false);
  });
  await withEnv(async () => json({ required: true }), async () => {
    assert.equal(await api.getStudioAuthRequired(), true);
  });
});

test("Fan View never renders the producer token entry", () => {
  assert.doesNotMatch(read("src/FanPage.tsx"), /StudioTokenEntry|getStudioAuthRequired/);
  assert.match(read("src/StudioPage.tsx"), /authRequired && <StudioTokenEntry/);
});

// ---- mobile -----------------------------------------------------------------

test("mobile CSS: sticky score bar, wrapping controls, 44px targets, readable pitch, studio notice", () => {
  const css = read("src/styles.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 767.98px)"));
  assert.ok(mobile.length > 0);
  assert.match(mobile, /\.fan-scorebar \{ position: sticky; top: 0;[^}]*min-height: 56px/);
  assert.match(mobile, /\.tabs \{ overflow-x: auto/);
  assert.match(mobile, /\.segmented \{ max-width: 100%; overflow-x: auto/);
  assert.match(mobile, /\.press-box__chip[^{]*\{ min-height: 44px; \}/);
  assert.match(mobile, /\.pitch \{ min-width: 320px; \}/);
  assert.match(mobile, /\.studio-mobile-notice \{ display: flex; \}/);
  assert.match(css, /\.studio-mobile-notice \{ display: none;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /\.var-hero|\.chance-card|\.player-id-tag|\.fan-chance__/);
});

test("hover-only title hints were replaced with inline text", () => {
  for (const file of ["src/PeriodSelector.tsx", "src/fan/PressBoxSection.tsx", "src/LivePitch.tsx"]) {
    assert.doesNotMatch(read(file), /\stitle=\{?["`]/, file);
  }
  assert.match(read("src/StudioNotices.tsx"), /Open Fan View →/);
});
