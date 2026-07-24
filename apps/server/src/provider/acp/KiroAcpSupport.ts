import type { KiroSettings } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Client capability advertised at `initialize` so Kiro streams its
 * parameterized model picker (model ids that may carry `[option=value]`
 * suffixes). Kiro exposes its available models through the `session/new`
 * response `.models` field and honors the standard `session/set_model`.
 */
export const KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "apiEndpoint" | "binaryPath">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: [
      ...(kiroSettings?.apiEndpoint ? (["-e", kiroSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
    // Kiro authenticates out-of-band via AWS IAM Identity Center, so per-instance
    // environment overrides (PATH, AWS profile/SSO) must reach the child process.
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      // Kiro authenticates externally via AWS IAM Identity Center and
      // advertises no auth methods, so no `authMethodId` is supplied — the ACP
      // `authenticate` request is skipped entirely.
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
        clientCapabilities: KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "auto";
  // Strip the parameterized model picker suffix (e.g. `claude-opus-4.6[...]`)
  // while preserving the exact model id advertised by the ACP agent.
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveKiroAcpRequestedModelId(input: {
  readonly requestedModelId: string | undefined;
  readonly modelState: EffectAcpSchema.SessionModelState | null | undefined;
}): string | undefined {
  const requestedModelId = input.requestedModelId?.trim();
  if (!requestedModelId) {
    return undefined;
  }

  const requestedBaseModelId = resolveKiroAcpBaseModelId(requestedModelId);
  const availableModelIds = new Set(
    input.modelState?.availableModels.map((model) => resolveKiroAcpBaseModelId(model.modelId)) ??
      [],
  );
  if (availableModelIds.size === 0 || availableModelIds.has(requestedBaseModelId)) {
    return requestedBaseModelId;
  }

  const currentModelId = input.modelState?.currentModelId?.trim();
  if (currentModelId) {
    const currentBaseModelId = resolveKiroAcpBaseModelId(currentModelId);
    if (availableModelIds.has(currentBaseModelId)) {
      return currentBaseModelId;
    }
  }

  return availableModelIds.has("auto") ? "auto" : undefined;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
