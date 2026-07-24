import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  resolveKiroAcpBaseModelId,
  resolveKiroAcpRequestedModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("defaults to auto and strips the parameterized model picker suffix", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  claude-sonnet-4.6  ")).toBe("claude-sonnet-4.6");
    expect(resolveKiroAcpBaseModelId("claude-opus-4.6[reasoning=high]")).toBe("claude-opus-4.6");
  });

  describe("resolveKiroAcpRequestedModelId", () => {
    const modelState = {
      currentModelId: "gpt-5.6-sol",
      availableModels: [
        { modelId: "auto", name: "Auto" },
        { modelId: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
        { modelId: "gpt-5.4", name: "GPT 5.4" },
      ],
    };

    it("preserves exact model ids advertised by Kiro", () => {
      expect(resolveKiroAcpBaseModelId("gpt-5.4")).toBe("gpt-5.4");
      expect(resolveKiroAcpBaseModelId("openai-gpt-5.4")).toBe("openai-gpt-5.4");
      expect(resolveKiroAcpRequestedModelId({ requestedModelId: "gpt-5.4", modelState })).toBe(
        "gpt-5.4",
      );
    });

    it("falls back to the advertised current model for a stale selection", () => {
      expect(
        resolveKiroAcpRequestedModelId({ requestedModelId: "openai-gpt-5.4", modelState }),
      ).toBe("gpt-5.6-sol");
    });

    it("keeps the requested model when the agent does not advertise model state", () => {
      expect(
        resolveKiroAcpRequestedModelId({
          requestedModelId: "custom-model",
          modelState: undefined,
        }),
      ).toBe("custom-model");
    });

    it("falls back to auto when current is not among advertised models", () => {
      expect(
        resolveKiroAcpRequestedModelId({
          requestedModelId: "stale-model",
          modelState: {
            currentModelId: "removed-model",
            availableModels: [{ modelId: "auto", name: "Auto" }],
          },
        }),
      ).toBe("auto");
    });
  });
});

describe("buildKiroAcpSpawnInput", () => {
  it("spawns `kiro-cli acp` without an endpoint override by default", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "kiro-cli", apiEndpoint: "" },
      "/tmp/project",
    );

    expect(spawn).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("prepends `-e <endpoint>` before the acp subcommand", () => {
    const spawn = buildKiroAcpSpawnInput(
      { binaryPath: "/usr/local/bin/kiro-cli", apiEndpoint: "https://example.test" },
      "/tmp/project",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/kiro-cli",
      args: ["-e", "https://example.test", "acp"],
      cwd: "/tmp/project",
    });
  });

  it("falls back to the `kiro-cli` command when settings are absent", () => {
    const spawn = buildKiroAcpSpawnInput(null, "/tmp/project");

    expect(spawn).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("applyKiroAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "claude-sonnet-4.6",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["claude-sonnet-4.6"]);
      expect(result).toBe("claude-sonnet-4.6");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "auto",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("auto");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("auto");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "claude-sonnet-4.6",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
