import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  resolveKiroAcpBaseModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("defaults to auto and strips the parameterized model picker suffix", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  claude-sonnet-4.6  ")).toBe("claude-sonnet-4.6");
    expect(resolveKiroAcpBaseModelId("claude-opus-4.6[reasoning=high]")).toBe("claude-opus-4.6");
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
