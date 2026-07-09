// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { kiroPromptSettlementBelongsToContext, makeKiroAdapter } from "./KiroAdapter.ts";
const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro-cli.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  // Kiro spawns `kiro-cli [-e <endpoint>] acp`; the mock ACP agent ignores its
  // argv and speaks ACP over stdio, so forward every argument unchanged.
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

const kiroAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiroAdapter>[1]) =>
  makeKiroAdapter(decodeKiroSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Kiro turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    kiroPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(kiroAdapterTestLayer)("KiroAdapterLive", (it) => {
  it.effect("starts a session and maps the mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "kiro");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        version: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello kiro",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      // Full canonical vocabulary produced by the shared ACP scaffolding on the
      // default mock flow (plan update + streaming assistant message).
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.plan.updated",
        "item.completed",
        "turn.completed",
      ] as const);

      // A turn that streams no agent thoughts and no diffs emits no proposed or
      // diff events (mirrors Codex, which only finalizes proposed content when a
      // plan item completed).
      assert.notIncludeMembers(types, [
        "turn.proposed.delta",
        "turn.proposed.completed",
        "turn.diff.updated",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }
      const plan = runtimeEvents.find((e) => e.type === "turn.plan.updated");
      assert.isDefined(plan);
      if (plan?.type === "turn.plan.updated") {
        assert.isAtLeast(plan.payload.plan.length, 1);
      }
      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits tool-call lifecycle updates and permission requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-tool-call-lifecycle");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened") {
            yield* adapter
              .respondToRequest(threadId, ApprovalRequestId.make(String(event.requestId)), "accept")
              .pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
      });

      yield* adapter.sendTurn({ threadId, input: "run a command", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((e) => e.type);
      assert.includeMembers(types, [
        "request.opened",
        "request.resolved",
        "item.updated",
        "item.completed",
        "turn.completed",
      ] as const);

      const inProgress = runtimeEvents.find(
        (e) => e.type === "item.updated" && e.payload.status === "inProgress",
      );
      assert.isDefined(inProgress);
      const resolved = runtimeEvents.find((e) => e.type === "request.resolved");
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "accept");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("streams agent thoughts as proposed content and tool diffs as turn diffs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-thoughts-and-diff");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_THOUGHTS_AND_DIFF: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
      });

      yield* adapter.sendTurn({ threadId, input: "edit the file", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((e) => e.type);
      assert.includeMembers(types, [
        "turn.proposed.delta",
        "turn.proposed.completed",
        "turn.diff.updated",
        "turn.completed",
      ] as const);

      // Each streamed thought chunk becomes a proposed delta.
      const proposedDeltas = runtimeEvents.filter((e) => e.type === "turn.proposed.delta");
      assert.deepStrictEqual(
        proposedDeltas.map((e) => (e.type === "turn.proposed.delta" ? e.payload.delta : "")),
        ["Considering the change. ", "Editing the file now."],
      );

      // The accumulated thought is finalized once as a proposed summary.
      const proposedCompleted = runtimeEvents.filter((e) => e.type === "turn.proposed.completed");
      assert.lengthOf(proposedCompleted, 1);
      const completedProposal = proposedCompleted[0];
      if (completedProposal?.type === "turn.proposed.completed") {
        assert.equal(
          completedProposal.payload.planMarkdown,
          "Considering the change. Editing the file now.",
        );
      }

      // The proposed summary is finalized before the turn settles.
      const proposedCompletedIndex = types.indexOf("turn.proposed.completed");
      const turnCompletedIndex = types.indexOf("turn.completed");
      assert.isBelow(proposedCompletedIndex, turnCompletedIndex);

      // Both the tool_call and tool_call_update diff payloads surface.
      const diffs = runtimeEvents.filter((e) => e.type === "turn.diff.updated");
      assert.lengthOf(diffs, 2);
      const firstDiff = diffs[0];
      if (firstDiff?.type === "turn.diff.updated") {
        assert.include(firstDiff.payload.unifiedDiff, "diff --git a/greeting.txt b/greeting.txt");
        assert.include(firstDiff.payload.unifiedDiff, "+hello world");
      }

      // Diff events are additive: the tool-call lifecycle still emits its item
      // event alongside the diff.
      assert.include(types, "item.completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("aborts an in-flight turn on interrupt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-interrupt-abort");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({ threadId, input: "hang forever", attachments: [] });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "restores a Kiro session to ready and emits a failed turn when the prompt RPC fails",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kiro-prompt-failure-ready");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKiroWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kiro"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
        });

        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] }),
        );
        const readySessions = yield* adapter.listSessions();
        const readySession = readySessions.find((session) => session.threadId === threadId);
        const failedTurnCompleted = runtimeEvents.find(
          (event) => event.type === "turn.completed" && event.threadId === threadId,
        );

        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.equal(readySession?.status, "ready");
        assert.isUndefined(readySession?.activeTurnId);
        if (failedTurnCompleted?.type === "turn.completed") {
          assert.equal(failedTurnCompleted.payload.state, "failed");
          assert.isString(failedTurnCompleted.payload.errorMessage);
        }

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
      });
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("resumes from the session/load cursor and drops replayed updates", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
        resumeCursor: { version: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({ threadId, input: "after resume", attachments: [] });

      assert.deepStrictEqual(session.resumeCursor, {
        version: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when the provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("kiro-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      yield* adapter.stopSession(threadId);
    }),
  );
});
