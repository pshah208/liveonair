import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TrackingFrame } from "../shared/tracking.js";
import { PITCH_VIEWBOX } from "../src/pitchGeometry.js";
import {
  PLAYOUT_DELAY_MS,
  PLAYOUT_MAX_GLIDE_SECONDS,
  TRACKING_SNAP_DISTANCE_M,
  addPlayoutFrame,
  createPlayout,
  crowdedPlayerIds,
  interpolateFrame,
  maxDisplacement,
  pushTrail,
  samplePlayout,
  shouldSnap,
} from "../src/trackingRender.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function frame(second: number, ballX: number, players: Array<[string, number, number]> = [["h1", 10, 10]]): TrackingFrame {
  return {
    fixtureId: "fx",
    seed: 1,
    second,
    synthetic: true,
    players: players.map(([id, x, y], index) => ({ id, teamId: index % 2 ? "away" : "home", number: index + 1, x, y })),
    ball: { x: ballX, y: 34 },
  };
}

test("live board hides arrows, path and the event-board ball while tracking is on", () => {
  const src = read("src/LivePitch.tsx");
  assert.match(src, /const trackingActive = trackingHorizon !== null;/);
  // The historical arrows/touches (ball mode) and dashed event paths (board mode) sit behind the tracking branch.
  assert.match(src, /\{trackingActive \? \(\s*<g className="pitch-tracking-latest">[\s\S]*?\) : mode === "ball" \? \(/);
  assert.match(src, /const ball = trackingActive \? null : motion\.position;/);
  assert.match(src, /className="pitch-event-ring"/);
  // Event caption moves to the ticker pill above the pitch, not an SVG label over the dots.
  assert.match(src, /: "pitch-event-chip"\}/);
  assert.match(src, /className="pitch-event-ticker"/);
  const trackingBranch = src.slice(src.indexOf('<g className="pitch-tracking-latest">'), src.indexOf(') : mode === "ball" ? ('));
  assert.doesNotMatch(trackingBranch, /<text|markerEnd|strokeDasharray/);
});

test("tracking header strip names the source once", () => {
  const src = read("src/TrackingLayer.tsx");
  assert.equal(src.match(/>Synthetic tracking</g)?.length, 1);
  assert.doesNotMatch(src, /setStatusText\("Synthetic tracking"\)/);
  assert.match(src, /~\{TRACKING_DELAY_SECONDS\}s behind live/);
  assert.equal(src.match(/className="tracking-overlay__controls"/g)?.length, 1);
});

test("tracking dots play out of a buffer on one requestAnimationFrame loop and honour reduced motion", () => {
  const src = read("src/TrackingLayer.tsx");
  assert.match(src, /requestAnimationFrame\(step\)/);
  assert.match(src, /samplePlayout\(playoutRef\.current, time\)/);
  assert.match(src, /addPlayoutFrame\(playoutRef\.current, payload\.frame, performance\.now\(\)\)/);
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /if \(reduced\) \{/);
  assert.match(src, /if \(reduced \|\| !enabled\) return;/);
  assert.match(src, /role="img" aria-label=\{`Synthetic tracking/);
  const css = read("src/board.css");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.pitch-event-ring \{\s*animation: pitch-event-ring-fade 2s/);
});

// Regression: at the default 30x the stream repeated one frame for ~1 s and then jumped
// ~30 match seconds; the client glided 200 ms, froze, then snapped (dots teleported).
test("playout runs continuously between frames and never freezes on a late frame", () => {
  const playout = createPlayout();
  // 30x: one frame every 200 ms wall, 6 match seconds apart.
  for (let i = 0; i < 6; i += 1) addPlayoutFrame(playout, frame(100 + 6 * i, 10 + 6 * i), i * 200);
  assert.ok(Math.abs(playout.rate - 30) < 1e-6, `rate ${playout.rate}`);
  const seconds: number[] = [];
  // No frame arrives during these 300 ms (a late frame): the clock keeps running smoothly.
  for (let at = 1000; at <= 1300; at += 16) {
    samplePlayout(playout, at);
    seconds.push(playout.clock!);
  }
  for (let i = 1; i < seconds.length; i += 1) {
    const step = seconds[i]! - seconds[i - 1]!;
    assert.ok(step > 0, `clock advanced at sample ${i}`);
    assert.ok(step < 1.5, `no jump at sample ${i}: ${step}`);
  }
  // Interpolated between two buffered frames, not snapped to either.
  const drawn = samplePlayout(playout, 1316)!;
  assert.ok(drawn.ball.x > 10 && drawn.ball.x < 40);
  // Duplicates are ignored; a rewind or a different fixture restarts the buffer.
  addPlayoutFrame(playout, frame(130, 40), 1320);
  assert.equal(playout.frames.length, 6);
  addPlayoutFrame(playout, frame(5, 0), 1400);
  assert.deepEqual(playout.frames.map((f) => f.second), [5]);
  assert.equal(playout.clock, null);
});

test("playout cuts across a seek instead of gliding over it", () => {
  const playout = createPlayout();
  addPlayoutFrame(playout, frame(10, 10), 0);
  addPlayoutFrame(playout, frame(10 + PLAYOUT_MAX_GLIDE_SECONDS + 5, 90), 200);
  playout.clock = 10.5;
  playout.sampledAt = 200;
  const drawn = samplePlayout(playout, 200)!;
  assert.ok(drawn.ball.x === 10 || drawn.ball.x === 90);
  assert.ok(PLAYOUT_DELAY_MS > 200, "buffer covers at least one 5 Hz frame interval");
});

test("interpolation lerps between frames and snaps on big jumps or reduced motion", () => {
  const a = frame(1, 50, [["h1", 10, 10]]);
  const b = frame(2, 54, [["h1", 12, 14]]);
  const mid = interpolateFrame(a, b, 0.5);
  assert.deepEqual([mid.ball.x, mid.players[0]!.x, mid.players[0]!.y], [52, 11, 12]);
  assert.equal(shouldSnap(a, b, false), false);
  assert.equal(shouldSnap(a, b, true), true, "reduced motion never glides");
  assert.equal(shouldSnap(null, b, false), true);
  const seek = frame(90, 50, [["h1", 10 + TRACKING_SNAP_DISTANCE_M + 1, 10]]);
  assert.ok(maxDisplacement(a, seek) > TRACKING_SNAP_DISTANCE_M);
  assert.equal(shouldSnap(a, seek, false), true);
  assert.equal(shouldSnap(a, { ...b, fixtureId: "other" }, false), true);
});

test("numbers are dropped only for dots closer than 2 m", () => {
  const crowded = crowdedPlayerIds(frame(1, 0, [["a", 10, 10], ["b", 11.5, 10], ["c", 30, 30], ["d", 32.5, 30]]).players);
  assert.deepEqual([...crowded].sort(), ["a", "b"]);
});

test("shirt numbers use hysteresis: hide below 2 m, show again only above 2.5 m", () => {
  const at = (gap: number) => frame(1, 0, [["a", 10, 10], ["b", 10 + gap, 10]]).players;
  let crowded = crowdedPlayerIds(at(1.9));
  assert.deepEqual([...crowded].sort(), ["a", "b"]);
  // Drifting between 2 and 2.5 m keeps the numbers hidden (no flicker).
  crowded = crowdedPlayerIds(at(2.2), undefined, crowded);
  assert.deepEqual([...crowded].sort(), ["a", "b"]);
  // Without history the same 2.2 m gap shows numbers.
  assert.equal(crowdedPlayerIds(at(2.2)).size, 0);
  crowded = crowdedPlayerIds(at(2.6), undefined, crowded);
  assert.equal(crowded.size, 0);
  // Once released, 2.2 m stays shown until the gap drops below 2 m again.
  crowded = crowdedPlayerIds(at(2.2), undefined, crowded);
  assert.equal(crowded.size, 0);
  const layer = read("src/TrackingLayer.tsx");
  assert.match(layer, /crowdedPlayerIds\(frame\.players, undefined, crowdedRef\.current\)/);
});

test("stream error clears the stale frame so the board falls back to arrows", () => {
  const src = read("src/TrackingLayer.tsx");
  const onError = src.slice(src.indexOf("source.onerror"), src.indexOf("return () =>", src.indexOf("source.onerror")));
  assert.match(onError, /reset\(\);/);
  assert.match(onError, /setConnected\(false\)/);
  // reset() must clear the source frame and the drawn frame/trail.
  const reset = src.slice(src.indexOf("const reset = () =>"), src.indexOf("reset();", src.indexOf("const reset = () =>")));
  assert.match(reset, /setSourceFrame\(null\)/);
  assert.match(reset, /drawnRef\.current = null/);
  assert.match(reset, /trailRef\.current = \[\]/);
});

// Regression: the board lagged because every animation frame called React setState
// (tracking dots and the ball-movement marker), re-rendering the whole board at 60 fps.
test("animation frames move SVG nodes directly instead of re-rendering React", () => {
  const layer = read("src/TrackingLayer.tsx");
  const step = layer.slice(layer.indexOf("const step = (time: number) =>"), layer.indexOf("rafRef.current = requestAnimationFrame(step);"));
  assert.ok(step.length > 0 && layer.indexOf("const step = (time: number) =>") > 0);
  assert.doesNotMatch(step, /\bset[A-Z]\w*\(/, "no React state updates inside the tracking rAF step");
  assert.match(layer, /setAttribute\("transform", svgTranslate\(player\.x, flipY\(player\.y\)\)\)/);
  assert.doesNotMatch(layer, /useState<TrackingView/);

  const pitch = read("src/LivePitch.tsx");
  const ballStep = pitch.slice(pitch.indexOf("const step = (now: number) =>"), pitch.indexOf("if (progress < 1) frame.current = requestAnimationFrame(step);"));
  assert.ok(ballStep.length > 0 && pitch.indexOf("const step = (now: number) =>") > 0);
  assert.doesNotMatch(ballStep, /\bset[A-Z]\w*\(/, "ball motion writes the transform, not React state, each frame");
  assert.match(pitch, /nodeRef\.current\?\.setAttribute\("transform", ballTransform\(point\)\)/);
});

test("tracking horizon re-renders the board only when it changes which events are visible", () => {
  const pitch = read("src/LivePitch.tsx");
  assert.match(pitch, /const floored = Math\.floor\(horizon \+ 1e-6\);/);
  assert.match(pitch, /eventsWithinTrackingHorizon\(eventsRef\.current, previous\)\.length === eventsWithinTrackingHorizon\(eventsRef\.current, floored\)\.length \? previous : floored/);
  assert.match(pitch, /onHorizonChange=\{onHorizonChange\}/);
  // Markers follow the play drawn on screen, not the newest buffered frame.
  assert.match(read("src/TrackingLayer.tsx"), /playoutRef\.current\.clock \?\? sourceFrame\.second/);
});

// Regression: the server capped frames by the service clock, which is floored and ticks
// once a wall second, so at 30x frames froze for a second and then jumped 30 match seconds.
test("tracking stream is not capped by the once-a-second service clock", () => {
  const server = read("server/live/tracking.ts");
  assert.doesNotMatch(server, /Math\.min\(projectedSecond, rawClock, watermark\)/);
  assert.match(server, /Math\.min\(projectedSecond, rawClock \+ Math\.max\(1, speed\), watermark\)/);
  assert.match(server, /rewound \|\| delayedSecond >= lastFrameSecond \? delayedSecond : lastFrameSecond/);
});

test("static pitch surface is memoised and no infinite SVG animation repaints the board", () => {
  const pitch = read("src/LivePitch.tsx");
  assert.match(pitch, /const PitchSurface = memo\(/);
  const css = read("src/styles.css");
  assert.doesNotMatch(css, /\.pitch-pulse \{[^}]*infinite/);
  assert.doesNotMatch(css, /\.pitch-ball \{[^}]*filter/);
});

test("all board layers share one viewBox and one tilt", () => {
  for (const file of ["src/LivePitch.tsx", "src/TrackingLayer.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /viewBox="0 0 105 68"/, file);
    assert.match(src, /viewBox=\{PITCH_VIEWBOX\}/, file);
  }
  assert.equal(read("src/LivePitch.tsx").match(/className="[^"]*pitch-plane/g)?.length, 2);
  assert.match(read("src/TrackingLayer.tsx"), /className="pitch-plane tracking-overlay__svg"/);
  const css = read("src/board.css");
  assert.match(css, /\.pitch-plane \{[^}]*transform: perspective\(150cqw\) rotateX\(36deg\);/);
  assert.match(css, /aspect-ratio: 117 \/ 80;/);
  // board.css hard-codes the hoarding position from this viewBox; change both together.
  assert.equal(PITCH_VIEWBOX, "-6 -6 117 80");
});

test("crowd-cap comment matches the 2 / 3 (counter-press) quota", () => {
  const src = read("shared/tracking.ts");
  assert.match(src, /at most two of a team near the ball, or three for the team out of\s*\/\/ possession during a counter-press/);
  assert.match(src, /const quota = teamId !== possession && counterPress \? 3 : 2;/);
  assert.doesNotMatch(src, /at most three of a team near the ball/);
});

test("ball trail keeps only the last 0.6 s", () => {
  let trail = pushTrail([], { x: 0, y: 0, at: 0 });
  trail = pushTrail(trail, { x: 1, y: 0, at: 300 });
  trail = pushTrail(trail, { x: 2, y: 0, at: 700 });
  assert.deepEqual(trail.map((point) => point.at), [300, 700]);
});

test("tracking dot colours keep >= 3:1 contrast on the pitch in both themes", () => {
  const css = read("src/styles.css");
  const hex = (theme: "dark" | "light", name: string) => {
    const block = theme === "dark" ? css.slice(0, css.indexOf(':root[data-theme="light"]')) : css.slice(css.indexOf(':root[data-theme="light"]'));
    const value = block.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"))?.[1];
    assert.ok(value, `${theme} --${name}`);
    return [1, 3, 5].map((i) => parseInt(value!.slice(i, i + 2), 16));
  };
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const mix = (a: number[], b: number[]) => a.map((c, i) => Math.round((c + b[i]!) / 2));
  for (const theme of ["dark", "light"] as const) {
    const bg = hex(theme, "cp-bg");
    const text = hex(theme, "cp-text");
    for (const team of ["team-home", "team-away"]) {
      const fill = hex(theme, team);
      assert.ok(contrast(fill, bg) >= 3, `${theme} ${team} ${contrast(fill, bg).toFixed(2)}`);
      assert.ok(contrast(mix(fill, text), bg) >= 3, `${theme} ${team} GK`);
    }
  }
});
