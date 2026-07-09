import { type KiroModelOptions, type KiroSettings } from "@t3tools/contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveKiroAcpBaseModelId,
  resolveKiroAcpConfigUpdates,
} from "../Layers/KiroProvider.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "apiEndpoint" | "binaryPath">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
}

export interface KiroAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: [
      ...(kiroSettings?.apiEndpoint ? (["-e", kiroSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd),
        clientCapabilities: KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface KiroAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: KiroAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly modelOptions: KiroModelOptions | null | undefined;
  readonly mapError: (context: KiroAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveKiroAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveKiroAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.modelOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
