import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { it, assert } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import { encodeJsonl, jsonRpcNotification, jsonRpcRequest } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

/**
 * Reproduction for the Kiro ACP hang: Kiro emits `session/request_permission`
 * batched into a single stdout read together with a `session/update`
 * notification and a proprietary `_kiro.dev/*` notification (see provider log
 * frame [46]). The client must still route the permission request to the
 * registered handler and write a response back, otherwise Kiro blocks forever.
 */

const KiroMetadataNotification = jsonRpcNotification(
  "_kiro.dev/metadata",
  Schema.Struct({
    sessionId: Schema.String,
    contextUsagePercentage: Schema.Number,
  }),
);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);
const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);

const SESSION_ID = "be428806-9a36-4bdb-aab3-5ebc36910996";
const TOOL_CALL_ID = "toolu_bdrk_018JajdGomsbqyT4XebJgfek";
const PERMISSION_REQUEST_ID = "64d5fe26-c1c2-4522-b002-3f766bd69fe0";

const toolCallUpdate = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call" as const,
    toolCallId: TOOL_CALL_ID,
    title: "Running: git remote -v",
    kind: "execute" as const,
    rawInput: { command: "git remote -v" },
  },
};

const permissionRequest = {
  sessionId: SESSION_ID,
  toolCall: {
    toolCallId: TOOL_CALL_ID,
    title: "Running: git remote -v",
  },
  options: [
    { optionId: "allow_once", name: "Yes", kind: "allow_once" as const },
    { optionId: "reject_once", name: "No", kind: "reject_once" as const },
  ],
};

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const awaitResponseLine = (output: Queue.Dequeue<string>, requestId: string) =>
  Effect.gen(function* () {
    const buffer: Array<string> = [];
    while (true) {
      const line = yield* Queue.take(output);
      buffer.push(line);
      if (buffer.join("").includes(requestId)) {
        return buffer.join("");
      }
    }
  }).pipe(Effect.timeoutOption("2 seconds"));

it.layer(NodeServices.layer)("kiro batched permission", (it) => {
  const runScenario = (batched: boolean) =>
    Effect.gen(function* () {
      const permissionCalls = yield* Ref.make<Array<unknown>>([]);
      const updates = yield* Ref.make<Array<unknown>>([]);
      const scope = yield* Scope.make();
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

      yield* acp.handleRequestPermission((req) =>
        Ref.update(permissionCalls, (current) => [...current, req]).pipe(
          Effect.as({
            outcome: { outcome: "selected" as const, optionId: "allow_once" },
          }),
        ),
      );
      yield* acp.handleSessionUpdate((n) => Ref.update(updates, (current) => [...current, n]));

      const metadataBytes = yield* encodeJsonl(KiroMetadataNotification, {
        jsonrpc: "2.0",
        method: "_kiro.dev/metadata",
        params: { sessionId: SESSION_ID, contextUsagePercentage: 3.83 },
      });
      const updateBytes = yield* encodeJsonl(SessionUpdateNotification, {
        jsonrpc: "2.0",
        method: "session/update",
        params: toolCallUpdate,
      });
      const permissionBytes = yield* encodeJsonl(RequestPermissionRequest, {
        jsonrpc: "2.0",
        id: PERMISSION_REQUEST_ID,
        method: "session/request_permission",
        params: permissionRequest,
        headers: [],
      });

      if (batched) {
        // Exactly like Kiro frame [46]: all three in one stdout read.
        yield* Queue.offer(input, concatBytes([metadataBytes, updateBytes, permissionBytes]));
      } else {
        yield* Queue.offer(input, metadataBytes);
        yield* Queue.offer(input, updateBytes);
        yield* Queue.offer(input, permissionBytes);
      }

      const response = yield* awaitResponseLine(output, PERMISSION_REQUEST_ID);
      const calls = yield* Ref.get(permissionCalls);
      const seenUpdates = yield* Ref.get(updates);
      yield* Queue.end(input);
      yield* Scope.close(scope, Exit.void);
      return { response, calls, seenUpdates };
    });

  it.effect("routes a permission request batched with notifications (Kiro frame [46])", () =>
    Effect.gen(function* () {
      const { response, calls, seenUpdates } = yield* runScenario(true);
      assert.strictEqual(seenUpdates.length, 1, "session/update notification should be delivered");
      assert.strictEqual(calls.length, 1, "permission handler must be invoked");
      assert.isTrue(
        response._tag === "Some" && response.value.includes(PERMISSION_REQUEST_ID),
        "client must write a response for the permission request",
      );
    }),
  );

  it.effect("routes a permission request sent in its own chunk (control)", () =>
    Effect.gen(function* () {
      const { response, calls } = yield* runScenario(false);
      assert.strictEqual(calls.length, 1, "permission handler must be invoked");
      assert.isTrue(
        response._tag === "Some" && response.value.includes(PERMISSION_REQUEST_ID),
        "client must write a response for the permission request",
      );
    }),
  );
});
