import assert from "node:assert/strict";
import test from "node:test";

import { createCommentator } from "../server/commentary.js";
import type { CompletionClient } from "../server/narrator.js";
import { buildSsml, createSpeechService, resolveSpeechEndpoint, type SpeechService } from "../server/speech.js";
import { HttpError } from "../server/validation.js";
import { buildHighlightReel, commentaryRequest } from "../shared/highlights.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function event(partial: Partial<MatchEvent> & Pick<MatchEvent, "id" | "minute" | "type" | "teamId" | "playerId">): MatchEvent {
  return { revision: 1, second: 0, outcome: "none", x: 50, y: 50, ...partial };
}

function fixture(): MatchFixture {
  return {
    id: "fx",
    seed: 1,
    title: "Sevilla vs Lyon",
    description: "",
    home: { id: "home", name: "Sevilla", shortName: "SEV", players: [
      { id: "p1", name: "Ana Ruiz", number: 9, position: "FW", teamId: "home" },
      { id: "p2", name: "Lucia Vega", number: 8, position: "MF", teamId: "home" },
    ] },
    away: { id: "away", name: "Lyon", shortName: "LYO", players: [
      { id: "p3", name: "Claire Dubois", number: 1, position: "GK", teamId: "away" },
      { id: "p4", name: "Eva Martin", number: 10, position: "FW", teamId: "away" },
    ] },
    events: [
      event({ id: "pass-1", minute: 27, second: 50, type: "pass", teamId: "home", playerId: "p2", outcome: "complete" }),
      event({ id: "shot-1", minute: 28, second: 5, type: "shot", teamId: "home", playerId: "p1", outcome: "success", x: 90, y: 50, xg: 0.42 }),
      event({ id: "goal-1", minute: 28, second: 6, type: "goal", teamId: "home", playerId: "p1", outcome: "success", x: 96, y: 50, relatedEventId: "shot-1" }),
    ],
    durationSeconds: 5400,
    correctionEventId: "goal-1",
    correctionAvailableAt: 9999,
  };
}

function fakeSpeech(): SpeechService & { registered: string[] } {
  const registered: string[] = [];
  return {
    configured: true,
    registered,
    register(text) {
      registered.push(text);
      return `/api/audio/${String(registered.length).padStart(32, "0")}.mp3`;
    },
    async synthesize() { return Buffer.from("mp3"); },
  };
}

function completion(lines: { intro: string; clip: string; outro: string }): { client: CompletionClient; deployment: string; calls: () => number } {
  let calls = 0;
  return {
    deployment: "test",
    calls: () => calls,
    client: {
      async createChatCompletion() {
        calls += 1;
        return {
          text: JSON.stringify({
            intro: { text: lines.intro, mood: "build" },
            lines: [{ clipId: "clip-01", text: lines.clip, mood: "excited" }],
            outro: { text: lines.outro, mood: "calm" },
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  };
}

test("commentator writes grounded broadcast lines, voices them and caches by reel", async () => {
  const match = fixture();
  const reel = buildHighlightReel(match, [], { language: "en" });
  const speech = fakeSpeech();
  const model = completion({
    intro: "Welcome to the highlights from Sevilla against Lyon.",
    clip: "Vega threads it through, Ana Ruiz is in the six-yard box... and she buries it! Sevilla lead 1-0!",
    outro: "Sevilla 1, Lyon 0, and Ana Ruiz the difference.",
  });
  const commentator = createCommentator({ completion: model, speech });
  const first = await commentator.write(commentaryRequest(reel), match, [], "r1");
  assert.equal(first.source, "foundry");
  assert.match(first.lines[0].text, /buries it/u);
  assert.equal(first.lines[0].mood, "excited");
  assert.ok(first.lines[0].audioUrl?.startsWith("/api/audio/"));
  assert.ok(first.intro.audioUrl && first.outro.audioUrl);

  const second = await commentator.write(commentaryRequest(reel), match, [], "r2");
  assert.equal(second.cached, true);
  assert.equal(model.calls(), 1);
});

test("commentator replaces lines that invent players or numbers with the verified caption", async () => {
  const match = fixture();
  const reel = buildHighlightReel(match, [], { language: "es" });
  const commentator = createCommentator({
    completion: completion({
      intro: "Bienvenidos al resumen del Sevilla contra el Lyon.",
      clip: "¡Eva Martin pierde el balón y Ana Ruiz marca su gol número 20 de la temporada!",
      outro: "Sevilla 3, Lyon 0.",
    }),
    speech: fakeSpeech(),
  });
  const result = await commentator.write(commentaryRequest(reel), match, [], "r1");
  assert.equal(result.intro.text, "Bienvenidos al resumen del Sevilla contra el Lyon.");
  assert.equal(result.lines[0].text, reel.clips[0].caption);
  assert.match(result.outro.text, /Sevilla 1, Lyon 0/u);
});

test("commentator falls back to captions when the model fails and rejects unknown events", async () => {
  const match = fixture();
  const reel = buildHighlightReel(match, [], { language: "fr" });
  const commentator = createCommentator({
    completion: { deployment: "x", client: { async createChatCompletion() { throw new HttpError(503, "down"); } } },
    speech: fakeSpeech(),
  });
  const result = await commentator.write(commentaryRequest(reel), match, [], "r1");
  assert.equal(result.source, "fallback");
  assert.equal(result.lines[0].text, reel.clips[0].caption);

  const bad = commentaryRequest(reel);
  bad.clips[0] = { ...bad.clips[0], keyEventId: "nope" };
  await assert.rejects(() => commentator.write(bad, match, [], "r2"), (error) => error instanceof HttpError && error.status === 400);
});

test("speech service only synthesizes registered text, escapes SSML and falls back from HD voices", async () => {
  const bodies: string[] = [];
  const speech = createSpeechService({
    endpoint: "https://example.cognitiveservices.azure.com",
    credential: { async getToken() { return { token: "t", expiresOnTimestamp: Date.now() + 60_000 }; } },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return bodies.length === 1 ? new Response("bad voice", { status: 400 }) : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch,
  });
  const url = speech.register("Goal <b>& more</b>", "en", "excited");
  assert.match(url ?? "", /^\/api\/audio\/[a-f0-9]{32}\.mp3$/u);
  const id = /([a-f0-9]{32})/u.exec(url!)![1];
  const audio = await speech.synthesize(id);
  assert.equal(audio.length, 3);
  assert.match(bodies[0], /DragonHD/u);
  assert.match(bodies[1], /en-GB-RyanNeural/u);
  assert.match(bodies[1], /Goal &lt;b&gt;&amp; more&lt;\/b&gt;/u);
  await assert.rejects(() => speech.synthesize("f".repeat(32)), (error) => error instanceof HttpError && error.status === 404);
  assert.equal((await speech.synthesize(id)).length, 3);
  assert.equal(bodies.length, 2);
});

test("speech endpoint is derived from the Azure OpenAI endpoint", () => {
  assert.equal(resolveSpeechEndpoint({ AZURE_OPENAI_ENDPOINT: "https://matchlens-ai-x.openai.azure.com/" }), "https://matchlens-ai-x.cognitiveservices.azure.com");
  assert.equal(resolveSpeechEndpoint({ AZURE_SPEECH_ENDPOINT: "https://custom.example/" }), "https://custom.example");
  assert.equal(resolveSpeechEndpoint({}), undefined);
  assert.equal(createSpeechService({ endpoint: "" }).register("x", "en"), undefined);
  assert.match(buildSsml({ text: "Hola", language: "es", mood: "calm" }, "es-ES-AlvaroNeural"), /xml:lang="es-ES"/u);
});
