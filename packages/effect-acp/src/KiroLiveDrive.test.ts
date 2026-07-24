import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { it, assert } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpClient from "./client.ts";
import type * as AcpSchema from "./_generated/schema.gen.ts";

/**
 * End-to-end headless driver for the real `kiro-cli acp` binary. Reproduces the
 * production hang: a prompt that triggers a shell tool call causes Kiro to send
 * `session/request_permission`; if the client never routes/answers it, the turn
 * never completes. No T3 frontend or backend server involved.
 *
 * Set KIRO_DRIVE=1 to run (spawns the real agent + hits the model).
 */
const ENABLED = process.env.KIRO_DRIVE === "1";
const REPO_ROOT = "/Volumes/workplace/t3-code-ia/t3code";

class PromptHangError extends Data.TaggedError("PromptHangError")<{
  readonly message: string;
}> {}

const pickAllowOption = (req: AcpSchema.RequestPermissionRequest): string => {
  const byKind = (kind: string) => req.options.find((o) => o.kind === kind)?.optionId;
  return byKind("allow_always") ?? byKind("allow_once") ?? req.options[0]?.optionId ?? "allow_once";
};

it.layer(NodeServices.layer)("kiro live drive", (it) => {
  const runner = ENABLED ? it.effect : it.effect.skip;
  runner(
    "completes a shell-tool turn (permission request must be answered)",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* Path.Path;
        const command = ChildProcess.make("kiro-cli", ["acp"], {
          cwd: REPO_ROOT,
          env: { ...process.env },
        });
        const handle = yield* spawner.spawn(command);

        const permissionCalls = yield* Ref.make<Array<string>>([]);
        const updates = yield* Ref.make<Array<string>>([]);

        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);

        const result = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;

          yield* acp.handleRequestPermission((req) =>
            Ref.update(permissionCalls, (c) => [...c, req.toolCall.toolCallId]).pipe(
              Effect.as({
                outcome: { outcome: "selected" as const, optionId: pickAllowOption(req) },
              }),
            ),
          );
          yield* acp.handleReadTextFile(() => Effect.succeed({ content: "" }));
          yield* acp.handleWriteTextFile(() => Effect.succeed({}));
          yield* acp.handleSessionUpdate((n) =>
            Ref.update(updates, (c) => [
              ...c,
              (n.update as { sessionUpdate: string }).sessionUpdate,
            ]),
          );

          yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: false,
              _meta: { parameterizedModelPicker: true },
            },
          });

          const session = yield* acp.agent.createSession({ cwd: REPO_ROOT, mcpServers: [] });

          return yield* acp.agent
            .prompt({
              sessionId: session.sessionId,
              prompt: [
                {
                  type: "text",
                  text: "Run the shell command `pwd` using your shell tool, then reply with just DONE.",
                },
              ],
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: "90 seconds",
                orElse: () =>
                  Effect.fail(
                    new PromptHangError({ message: "PROMPT_HANG: turn did not complete in 90s" }),
                  ),
              }),
            );
        }).pipe(Effect.provide(context), Effect.exit);

        yield* Scope.close(scope, yield* Effect.exit(Effect.void));

        const calls = yield* Ref.get(permissionCalls);
        const seen = yield* Ref.get(updates);
        yield* Effect.log(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `permissionCalls=${calls.length} updates=${JSON.stringify(seen)} result=${result._tag}`,
        );

        assert.isTrue(
          result._tag === "Success",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `prompt turn should complete, got ${JSON.stringify(result)}`,
        );
        assert.isTrue(calls.length >= 1, "permission handler must have been invoked");
      }),
    120_000,
  );
});
