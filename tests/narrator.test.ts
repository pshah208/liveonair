import assert from "node:assert/strict";
import test from "node:test";

import {
  appendKeyMoments,
  buildEvidenceLedger,
  collectKeyMoments,
  createNarrator,
  missingKeyMoments,
  validateGroundedNarrativeDraft,
} from "../server/narrator.js";
import { HttpError } from "../server/validation.js";
import type { MatchEvent, MatchFixture, MatchSnapshot, NarrativeRequest } from "../shared/types.js";
import type { Storyline } from "../shared/platform.js";

function createFixture(): MatchFixture {
  return {
    id: "fixture-1",
    seed: 7,
    title: "Sevilla vs Lyon",
    description: "Synthetic fixture",
    home: {
      id: "home",
      name: "Sevilla",
      shortName: "SEV",
      players: [
        { id: "p1", name: "Ana Ruiz", number: 9, position: "FW", teamId: "home" },
        { id: "p2", name: "Lucia Vega", number: 8, position: "MF", teamId: "home" },
      ],
    },
    away: {
      id: "away",
      name: "Lyon",
      shortName: "LYO",
      players: [
        { id: "p3", name: "Claire Dubois", number: 4, position: "DF", teamId: "away" },
        { id: "p4", name: "Eva Martin", number: 10, position: "FW", teamId: "away" },
      ],
    },
    events: [],
    durationSeconds: 5400,
    correctionEventId: "goal-1",
    correctionAvailableAt: 2000,
  };
}

function localizedStory(language: NarrativeRequest["language"]) {
  if (language === "es") {
    return {
      title: "La presión azul fuerza el gol",
      summary: "La presión alta de Sevilla encerró a Lyon.",
      whyItMatters: "Ese tramo explicó el 1-0 y sostuvo el control local.",
    };
  }
  if (language === "fr") {
    return {
      title: "Le pressing bleu provoque le but",
      summary: "Le pressing haut de Séville a étouffé Lyon.",
      whyItMatters: "Cette séquence a expliqué le 1-0 et le contrôle local.",
    };
  }
  return {
    title: "Blue press forces the goal",
    summary: "Sevilla's high press pinned Lyon deep.",
    whyItMatters: "That spell created the 1-0 and sustained home control.",
  };
}

function createSnapshot(
  stateVersion = "v1",
  atSecond = 1800,
  language: NarrativeRequest["language"] = "en",
  extraEvents: MatchEvent[] = [],
): MatchSnapshot {
  const story = localizedStory(language);
  const baseEvents: MatchEvent[] = [
    {
      id: "goal-1",
      revision: 1,
      minute: 28,
      second: 15,
      type: "goal",
      teamId: "home",
      playerId: "p1",
      outcome: "success",
      x: 0.8,
      y: 0.3,
    },
    {
      id: "red-1",
      revision: 1,
      minute: 29,
      second: 20,
      type: "red_card",
      teamId: "away",
      playerId: "p3",
      outcome: "none",
      x: 0.2,
      y: 0.5,
    },
    {
      id: "yellow-1",
      revision: 1,
      minute: 15,
      second: 10,
      type: "yellow_card",
      teamId: "away",
      playerId: "p3",
      outcome: "none",
      x: 0.2,
      y: 0.5,
      rescinded: true,
    },
    {
      id: "future-goal",
      revision: 1,
      minute: 40,
      second: 0,
      type: "goal",
      teamId: "away",
      playerId: "p4",
      outcome: "success",
      x: 0.4,
      y: 0.4,
    },
    ...extraEvents,
  ];

  const evidence = Object.fromEntries(baseEvents.map((event) => [event.id, event]));

  return {
    fixtureId: "fixture-1",
    atSecond,
    stateVersion,
    persona: "analyst",
    language,
    score: { home: 1, away: 0 },
    stats: {
      home: { goals: 1, shots: 4, passes: 20, completedPasses: 15, passAccuracy: 75, corners: 1, tackles: 2, pressureEvents: 3, fouls: 1, yellowCards: 0, redCards: 0, illustrativeXg: 0.8 },
      away: { goals: 0, shots: 2, passes: 18, completedPasses: 10, passAccuracy: 55.5, corners: 0, tackles: 3, pressureEvents: 4, fouls: 2, yellowCards: 1, redCards: 1, illustrativeXg: 0.3 },
    },
    stories: [
      {
        id: "s1",
        kind: "turning_point",
        title: story.title,
        summary: story.summary,
        whyItMatters: story.whyItMatters,
        evidenceIds: ["goal-1"],
        metrics: [{ label: "xG", value: 0.3 }],
        confidence: "observed",
        importance: 95,
        windowStart: 1200,
        windowEnd: 1800,
        teamId: "home",
      },
    ],
    recentEvents: baseEvents,
    evidence,
    corrections: [],
    eventCount: baseEvents.length,
    evidenceCoverage: 1,
    synthetic: true,
  };
}

function request(overrides: Partial<NarrativeRequest> = {}): NarrativeRequest {
  return {
    fixtureId: "fixture-1",
    atSecond: 1800,
    correction: false,
    persona: "analyst",
    language: "en",
    format: "story",
    storyId: "s1",
    ...overrides,
  };
}

function toolCall(id: string, name: string, argumentsText = "{}") {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: argumentsText },
  };
}

function createHappyCompletionClient() {
  return {
    async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("Live on Air analyst")) {
        if (messages.some((message) => message.role === "tool")) {
          return {
            text: JSON.stringify({
              selectedFactIds: ["score", "story:s1", "event:goal-1"],
              focusStoryId: "s1",
              rationale: "Lead with the story, but keep the score grounded.",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
            assistantMessage: { role: "assistant", content: "" },
          };
        }
        return {
          text: "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [
            toolCall("1", "get_match_state"),
            toolCall("2", "get_story_evidence", "{\"storyId\":\"s1\"}"),
          ],
          assistantMessage: { role: "assistant", content: "", tool_calls: [] },
        };
      }
      return {
        text: JSON.stringify({
          titleMode: "turning_point",
          orderedFactIds: ["story:s1", "score", "event:goal-1"],
          emphasis: "measured",
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [],
        assistantMessage: { role: "assistant", content: "" },
      };
    },
  };
}

test("grounded validator rejects unknown, rescinded, future, and malicious claim text", () => {
  const snapshot = createSnapshot();
  const ledger = buildEvidenceLedger(snapshot, createFixture());

  assert.throws(
    () => validateGroundedNarrativeDraft({
      title: "Bad",
      script: "Bad",
      claims: [{ text: "Nope", evidenceIds: ["missing"] }],
    }, snapshot, ledger),
    (error) => error instanceof HttpError && error.message === "Narrative claim referenced unknown evidence",
  );

  assert.throws(
    () => validateGroundedNarrativeDraft({
      title: "Bad",
      script: "Bad",
      claims: [{ text: "Nope", evidenceIds: ["yellow-1"] }],
    }, snapshot, { ...ledger, eventIndex: { ...ledger.eventIndex, "yellow-1": snapshot.evidence["yellow-1"] } }),
    (error) => error instanceof HttpError && error.message === "Narrative claim referenced rescinded evidence",
  );

  assert.throws(
    () => validateGroundedNarrativeDraft({
      title: "Bad",
      script: "Bad",
      claims: [{ text: "Nope", evidenceIds: ["future-goal"] }],
    }, createSnapshot("v1", 1700), {
      ...ledger,
      eventIndex: { ...ledger.eventIndex, "future-goal": snapshot.evidence["future-goal"] },
    }),
    (error) => error instanceof HttpError && error.message === "Narrative claim referenced future evidence",
  );

  assert.throws(
    () => validateGroundedNarrativeDraft({
      title: "Bad",
      script: "Bad",
      claims: [{ text: "Ana Ruiz definitely wins the match next.", evidenceIds: ["goal-1"] }],
    }, snapshot, ledger),
    (error) => error instanceof HttpError && error.message === "Narrative claim text did not match approved evidence",
  );
});

test("buildEvidenceLedger uses fixture names and localized story text", () => {
  const fixture = createFixture();
  const snapshot = createSnapshot("v1", 1800, "es");
  const ledger = buildEvidenceLedger(snapshot, fixture);

  assert.equal(ledger.facts["event:goal-1"].text.es, "Ana Ruiz marcó para Sevilla en 28:15.");
  assert.equal(
    ledger.facts["story:s1"].text.es,
    "La presión alta de Sevilla encerró a Lyon. Ese tramo explicó el 1-0 y sostuvo el control local.",
  );
  assert.match(ledger.facts["recap:milestones"]?.text.es ?? "", /Ana Ruiz marcó para Sevilla/);
  assert.match(ledger.facts["recap:milestones"]?.text.es ?? "", /Claire Dubois recibió una tarjeta roja para Lyon/);
});

test("recap accepts null focus and supplies strict output schemas", async () => {
  const schemaNames: string[] = [];
  const client = createHappyCompletionClient();
  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion(args: {
        messages: Record<string, unknown>[];
        responseSchema?: { name: string; schema: Record<string, unknown> };
      }) {
        if (args.responseSchema) schemaNames.push(args.responseSchema.name);
        const result = await client.createChatCompletion(args);
        if (String(args.messages[0]?.content).includes("Live on Air analyst")
          && args.messages.some((message) => message.role === "tool")) {
          return {
            ...result,
            text: JSON.stringify({
              selectedFactIds: ["score", "story:s1", "event:goal-1"],
              focusStoryId: null,
              rationale: "Grounded recap with match context.",
            }),
          };
        }
        return result;
      },
    },
  });
  const response = await narrator.narrate(
    request({ format: "recap", storyId: undefined }),
    createSnapshot(),
    { requestId: "null-focus", fixture: createFixture() },
  );
  assert.ok(response.claims.some((claim) => claim.text.includes("Score at 30:00")));
  assert.ok(schemaNames.includes("matchlens_analyst"));
  assert.ok(schemaNames.includes("matchlens_producer"));
});

test("cache separates state version and format and skips repeated budget use", async () => {
  let calls = 0;
  const completionClient = {
    async createChatCompletion(args: { messages: Record<string, unknown>[] }) {
      calls += 1;
      return createHappyCompletionClient().createChatCompletion(args);
    },
  };

  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient,
    now: (() => {
      let current = 1_000;
      return () => ++current;
    })(),
  });

  const first = await narrator.narrate(request(), createSnapshot("v1"), { requestId: "r1" });
  const cached = await narrator.narrate(request(), createSnapshot("v1"), { requestId: "r2" });
  const differentFormat = await narrator.narrate(request({ format: "recap", storyId: undefined }), createSnapshot("v1"), { requestId: "r3" });
  const differentState = await narrator.narrate(request(), createSnapshot("v2"), { requestId: "r4" });

  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(differentFormat.cached, false);
  assert.equal(differentState.cached, false);
  // Story narrations: analyst x2 + producer. The recap also runs the writer step.
  assert.equal(calls, 10);
});

test("quota and concurrency are enforced on cache misses", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolveWait) => {
    release = resolveWait;
  });

  const completionClient = {
    async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
      const system = String(messages[0]?.content ?? "");
      if (system.includes("Live on Air analyst") && !messages.some((message) => message.role === "tool")) {
        return {
          text: "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [
            toolCall("1", "get_match_state"),
            toolCall("2", "query_events", "{\"types\":[\"goal\"]}"),
          ],
          assistantMessage: { role: "assistant", content: "", tool_calls: [] },
        };
      }
      if (system.includes("Live on Air analyst")) {
        await wait;
        return {
          text: JSON.stringify({ selectedFactIds: ["score", "event:goal-1"], rationale: "ok" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      }
      return {
        text: JSON.stringify({ titleMode: "scoreline", orderedFactIds: ["score"], emphasis: "calm" }),
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [],
        assistantMessage: { role: "assistant", content: "" },
      };
    },
  };

  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient,
    maxConcurrent: 1,
    maxRequestsPerHour: 5,
  });

  const firstPromise = narrator.narrate(request({ storyId: undefined }), createSnapshot("v1"), { requestId: "r1" });
  await assert.rejects(
    () => narrator.narrate(request({ format: "recap", storyId: undefined }), createSnapshot("v2"), { requestId: "r2" }),
    (error) => error instanceof HttpError && error.status === 429 && error.message === "AI concurrency limit reached",
  );

  release();
  await firstPromise;

  const hourlyNarrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: createHappyCompletionClient(),
    maxConcurrent: 2,
    maxRequestsPerHour: 1,
  });

  await hourlyNarrator.narrate(request({ storyId: undefined }), createSnapshot("v1"), { requestId: "r3" });

  await assert.rejects(
    () => hourlyNarrator.narrate(request({ format: "recap", storyId: undefined }), createSnapshot("v3"), { requestId: "r4" }),
    (error) => error instanceof HttpError && error.status === 429 && error.message === "AI hourly request quota reached",
  );
});

test("analyst must call match state and a supporting tool", async () => {
  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst") && !messages.some((message) => message.role === "tool")) {
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [toolCall("1", "get_match_state")],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        if (system.includes("Live on Air analyst")) {
          return {
            text: JSON.stringify({ selectedFactIds: ["score", "story:s1"], focusStoryId: "s1", rationale: "ok" }),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
            assistantMessage: { role: "assistant", content: "" },
          };
        }
        return {
          text: JSON.stringify({ titleMode: "scoreline", orderedFactIds: ["score"], emphasis: "calm" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  await assert.rejects(
    () => narrator.narrate(request(), createSnapshot(), { requestId: "r1" }),
    (error) => error instanceof HttpError && error.message === "AI analyst did not ground its selection",
  );
});

test("invalid analyst and producer shapes are rejected", async () => {
  const badAnalystNarrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst") && !messages.some((message) => message.role === "tool")) {
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [
              toolCall("1", "get_match_state"),
              toolCall("2", "get_story_evidence", "{\"storyId\":\"s1\"}"),
            ],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        return {
          text: JSON.stringify({ selectedFactIds: "score", rationale: "bad" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  await assert.rejects(
    () => badAnalystNarrator.narrate(request(), createSnapshot(), { requestId: "r1" }),
    (error) => error instanceof HttpError && error.message === "AI returned invalid analyst shape",
  );

  const badProducerNarrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst")) {
          if (messages.some((message) => message.role === "tool")) {
            return {
              text: JSON.stringify({ selectedFactIds: ["score", "story:s1"], focusStoryId: "s1", rationale: "ok" }),
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
              assistantMessage: { role: "assistant", content: "" },
            };
          }
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [
              toolCall("1", "get_match_state"),
              toolCall("2", "get_story_evidence", "{\"storyId\":\"s1\"}"),
            ],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        return {
          text: JSON.stringify({ titleMode: "bad_enum", orderedFactIds: ["score"], emphasis: "calm" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  await assert.rejects(
    () => badProducerNarrator.narrate(request(), createSnapshot(), { requestId: "r2" }),
    (error) => error instanceof HttpError && error.message === "AI returned invalid producer shape",
  );
});

test("unknown analyst facts and producer facts outside selection are rejected", async () => {
  const unknownFactNarrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst")) {
          if (messages.some((message) => message.role === "tool")) {
            return {
              text: JSON.stringify({ selectedFactIds: ["score", "story:s1", "event:not-real"], focusStoryId: "s1", rationale: "bad" }),
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
              assistantMessage: { role: "assistant", content: "" },
            };
          }
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [
              toolCall("1", "get_match_state"),
              toolCall("2", "get_story_evidence", "{\"storyId\":\"s1\"}"),
            ],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        return {
          text: JSON.stringify({ titleMode: "scoreline", orderedFactIds: ["score"], emphasis: "measured" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  await assert.rejects(
    () => unknownFactNarrator.narrate(request(), createSnapshot(), { requestId: "r1" }),
    (error) => error instanceof HttpError && error.message === "AI analyst selected facts outside grounded tool results",
  );

  const badProducerNarrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst")) {
          if (messages.some((message) => message.role === "tool")) {
            return {
              text: JSON.stringify({ selectedFactIds: ["score", "story:s1"], focusStoryId: "s1", rationale: "ok" }),
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
              assistantMessage: { role: "assistant", content: "" },
            };
          }
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [
              toolCall("1", "get_match_state"),
              toolCall("2", "get_story_evidence", "{\"storyId\":\"s1\"}"),
            ],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        return {
          text: JSON.stringify({ titleMode: "scoreline", orderedFactIds: ["event:red-1"], emphasis: "measured" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  await assert.rejects(
    () => badProducerNarrator.narrate(request(), createSnapshot(), { requestId: "r2" }),
    (error) => error instanceof HttpError && error.message === "AI producer ordered facts outside analyst selection",
  );
});

test("narration keeps localized names and exact ledger claims", async () => {
  const fixture = createFixture();
  const snapshot = createSnapshot("v1", 1800, "es");
  const ledger = buildEvidenceLedger(snapshot, fixture);
  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: createHappyCompletionClient(),
  });

  const response = await narrator.narrate(request({ language: "es" }), snapshot, {
    requestId: "r1",
    fixture,
  });

  assert.equal(response.claims[0]?.text, ledger.facts["story:s1"].text.es);
  assert.ok(response.claims.some((claim) => claim.text.includes("Ana Ruiz")));
  assert.ok(response.claims.some((claim) => claim.text.includes("Sevilla")));
  assert.ok(response.claims.every((claim) => !claim.text.includes("p1")));
  assert.ok(response.claims.every((claim) => !claim.text.includes("home")));
});

test("recap always includes score and active goal plus red-card coverage", async () => {
  const fixture = createFixture();
  const extraGoal: MatchEvent = {
    id: "goal-2",
    revision: 1,
    minute: 35,
    second: 5,
    type: "goal",
    teamId: "home",
    playerId: "p2",
    outcome: "success",
    x: 0.7,
    y: 0.2,
  };
  const snapshot = {
    ...createSnapshot("v1", 2200, "en", [extraGoal]),
    score: { home: 2, away: 0 },
    stats: {
      home: { goals: 2, shots: 5, passes: 22, completedPasses: 17, passAccuracy: 77, corners: 1, tackles: 2, pressureEvents: 3, fouls: 1, yellowCards: 0, redCards: 0, illustrativeXg: 1.1 },
      away: { goals: 0, shots: 2, passes: 18, completedPasses: 10, passAccuracy: 55.5, corners: 0, tackles: 3, pressureEvents: 4, fouls: 2, yellowCards: 1, redCards: 1, illustrativeXg: 0.3 },
    },
  };
  const ledger = buildEvidenceLedger(snapshot, fixture);
  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: {
      async createChatCompletion({ messages }: { messages: Record<string, unknown>[] }) {
        const system = String(messages[0]?.content ?? "");
        if (system.includes("Live on Air analyst")) {
          if (messages.some((message) => message.role === "tool")) {
            return {
              text: JSON.stringify({
                selectedFactIds: ["score", "recap:milestones"],
                rationale: "Recap should cover the whole state.",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
              assistantMessage: { role: "assistant", content: "" },
            };
          }
          return {
            text: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [
              toolCall("1", "get_match_state"),
              toolCall("2", "query_events", "{\"types\":[\"goal\",\"red_card\"]}"),
            ],
            assistantMessage: { role: "assistant", content: "", tool_calls: [] },
          };
        }
        return {
          text: JSON.stringify({
            titleMode: "scoreline",
            orderedFactIds: ["score"],
            emphasis: "measured",
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      },
    },
  });

  const response = await narrator.narrate(request({ format: "recap", storyId: undefined }), snapshot, {
    requestId: "r1",
    fixture,
  });

  assert.equal(response.claims[0]?.text, ledger.facts.score.text.en);
  assert.equal(response.claims[1]?.text, ledger.facts["recap:milestones"].text.en);
  assert.match(response.script, /Score at 36:40: Sevilla 2-0 Lyon\./);
  assert.match(response.script, /Ana Ruiz scored for Sevilla/);
  assert.match(response.script, /Lucia Vega scored for Sevilla/);
  assert.match(response.script, /Claire Dubois received a red card for Lyon/);
});

function writerClient(script: string, title = "Ruiz strikes as Sevilla edge Lyon") {
  const happy = createHappyCompletionClient();
  return {
    async createChatCompletion(args: { messages: Record<string, unknown>[] }) {
      if (String(args.messages[0]?.content).includes("Live on Air match reporter")) {
        return {
          text: JSON.stringify({ title, script }),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          assistantMessage: { role: "assistant", content: "" },
        };
      }
      return happy.createChatCompletion(args);
    },
  };
}

test("recap writer turns approved facts into match-report prose and keeps grounded claims", async () => {
  const script = "Sevilla lead Lyon 1-0. Ana Ruiz broke the deadlock in the 28th minute after a spell of relentless pressing, and the visitors' task grew harder still when Claire Dubois was sent off in minute 29.";
  const narrator = createNarrator({
    endpoint: "https://example.openai.azure.com",
    deployment: "test-model",
    completionClient: writerClient(script),
  });
  const response = await narrator.narrate(request({ format: "recap", storyId: undefined }), createSnapshot(), { requestId: "writer", fixture: createFixture() });
  assert.equal(response.script, script);
  assert.equal(response.title, "Ruiz strikes as Sevilla edge Lyon");
  assert.ok(response.claims.length > 0);
  assert.equal(response.trace.find((step) => step.role === "writer")?.status, "complete");
});

test("recap writer falls back to the fact script when prose invents numbers or players", async () => {
  for (const script of [
    "Sevilla beat Lyon 3-0 thanks to a stunning hat-trick from Ana Ruiz, who has now scored in every home game this season.",
    "Sevilla lead Lyon 1-0 after Ana Ruiz scored, with Eva Martin denied repeatedly by a heroic home defence in the first half.",
  ]) {
    const narrator = createNarrator({
      endpoint: "https://example.openai.azure.com",
      deployment: "test-model",
      completionClient: writerClient(script),
    });
    const response = await narrator.narrate(request({ format: "recap", storyId: undefined }), createSnapshot(), { requestId: "writer-bad", fixture: createFixture() });
    assert.notEqual(response.script, script);
    assert.match(response.script, /Here is the match recap so far\./u);
    assert.equal(response.trace.find((step) => step.role === "writer")?.status, "rejected");
  }
});

test("recap key moments cover every red card and approved storyline, never retracted or future ones", () => {
  const fixture = createFixture();
  const snapshot = createSnapshot("v1", 1800, "en");
  const ledger = buildEvidenceLedger(snapshot, fixture);
  const story = (id: string, triggerEventIds: string[], status: Storyline["status"], line: string): Storyline => ({
    id, matchId: "m1", triggerEventIds, triggerMinute: 28, createdAt: "", updatedAt: "", status, priority: 1,
    headline: { en: line, es: "", fr: "", pt: "" }, onAirLine: { en: line, es: "", fr: "", pt: "" }, overlay: { en: line, es: "", fr: "", pt: "" },
    claims: [], trace: [], version: 1,
  });
  const moments = collectKeyMoments(ledger, [
    story("approved", ["goal-1"], "approved", "Ana Ruiz opens the scoring."),
    story("draft", ["goal-1"], "needs_review", "Draft line."),
    story("future", ["future-goal"], "approved", "Eva Martin equalises."),
  ], fixture, "en");
  assert.deepEqual(moments.map((moment) => moment.kind), ["approved_storyline", "red_card"]);
  assert.deepEqual(moments.find((moment) => moment.kind === "red_card")?.playerNames, ["Claire Dubois"]);

  assert.deepEqual(missingKeyMoments("Ana Ruiz struck first before Claire Dubois saw red.", moments), []);
  assert.deepEqual(missingKeyMoments("Ana Ruiz struck first.", moments).map((moment) => moment.kind), ["red_card"]);

  const fallback = appendKeyMoments("Recap.", moments);
  assert.ok(fallback.includes("Ana Ruiz opens the scoring."));
  assert.equal(appendKeyMoments(fallback, moments), fallback, "lines are not duplicated");
});
test("Portuguese ledger facts read naturally and keep names and score", () => {
  const fixture = createFixture();
  const ledger = buildEvidenceLedger(createSnapshot("v1", 1800, "en"), fixture);
  assert.equal(ledger.facts["event:goal-1"].text.pt, "Ana Ruiz marcou para o Sevilla aos 28:15.");
  assert.match(ledger.facts["event:red-1"].text.pt, /Claire Dubois recebeu cartão vermelho pelo Lyon/u);
  assert.match(ledger.facts["recap:milestones"].text.pt, /^Momentos decisivos:/u);
  assert.match(ledger.facts.score.text.pt, /Sevilla 1-0 Lyon/u);
});