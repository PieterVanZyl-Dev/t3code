import {
  type KiroSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeKiroAcpRuntime, resolveKiroAcpBaseModelId } from "../acp/KiroAcpSupport.ts";
import type * as Crypto from "effect/Crypto";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const PROVIDER = ProviderDriverKind.make("kiro");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Static fallback catalogue used when live discovery via `session/new` is
 * unavailable (e.g. before the first ACP session, or when the probe times
 * out). `auto` is the task-routed default; the remaining slugs mirror the
 * `kiro-cli chat --list-models` catalogue. Discovered models replace this
 * list when the ACP session advertises them.
 */
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "auto", name: "Auto", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.6-1m",
    name: "Claude Opus 4.6 (1M)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6-1m",
    name: "Claude Sonnet 4.6 (1M)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "deepseek-3.2", name: "DeepSeek 3.2", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "kimi-k2.5", name: "Kimi K2.5", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "minimax-m2.1", name: "MiniMax M2.1", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "minimax-m2.5", name: "MiniMax M2.5", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialKiroProviderSnapshot(
  kiroSettings: KiroSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kiroModelsFromSettings(kiroSettings.customModels);

    if (!kiroSettings.enabled) {
      return buildServerProvider({
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kiro CLI availability...",
      },
    });
  });
}

function kiroModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildKiroDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveKiroAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverKiroModelsViaAcp = (kiroSettings: KiroSettings) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKiroAcpRuntime({
      kiroSettings,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildKiroDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/** Parse `kiro-cli --version` output (e.g. `kiro-cli 2.0.1`). */
function parseKiroCliVersion(output: string): string | null {
  const match = /\bkiro-cli\s+(\S+)/i.exec(output);
  if (match?.[1]) {
    return match[1].trim();
  }
  return parseGenericCliVersion(output);
}

interface KiroWhoamiResult {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

/**
 * Parse `kiro-cli whoami`. Kiro authenticates externally via AWS IAM Identity
 * Center, so the markers are "Logged in with IAM Identity Center" and/or an
 * `Email: <…>` line. Output containing "authentication required" indicates the
 * user needs to run `kiro-cli login`.
 */
export function parseKiroWhoamiOutput(result: CommandResult): KiroWhoamiResult {
  const plain = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const lowerOutput = plain.toLowerCase();

  if (
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("please log in")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Kiro is not authenticated. Run `kiro-cli login` and try again.",
    };
  }

  const emailMatch = /^Email:\s*(.+)$/m.exec(plain);
  const email = emailMatch?.[1]?.trim();
  const loggedIn = /logged in with iam identity center/i.test(plain) || /logged in/i.test(plain);
  if (email || loggedIn) {
    return {
      status: "ready",
      auth: { status: "authenticated", ...(email ? { email } : {}) },
    };
  }

  if (result.code === 0) {
    return { status: "ready", auth: { status: "unknown" } };
  }
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: "Could not verify Kiro authentication status.",
  };
}

const runKiroCommand = (
  kiroSettings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = kiroSettings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiroModelsFromSettings(kiroSettings.customModels);

  if (!kiroSettings.enabled) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kiro is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKiroCommand(kiroSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kiro CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
          : "Failed to execute Kiro CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseKiroCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kiro CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but failed to run.",
      },
    });
  }

  // Auth is probed separately via `kiro-cli whoami`. A failure here does not
  // fail the whole probe — treat it as an unknown auth status.
  const whoamiResult = yield* runKiroCommand(kiroSettings, ["whoami"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const parsedAuth: KiroWhoamiResult =
    Result.isSuccess(whoamiResult) && Option.isSome(whoamiResult.success)
      ? parseKiroWhoamiOutput(whoamiResult.success.value)
      : { status: "ready", auth: { status: "unknown" } };

  if (parsedAuth.auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: kiroSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: parsedAuth.auth,
        ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
      },
    });
  }

  // Kiro exposes its built-in models via the `session/new` response `.models`
  // field. Discovery is best-effort: failures are logged quietly and fall back
  // to the built-in catalogue, keeping `auto` + custom models usable.
  const discoveryExit = yield* discoverKiroModelsViaAcp(kiroSettings).pipe(
    Effect.timeoutOption(KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Kiro ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
  } else if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Kiro ACP model discovery timed out after ${KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
  } else {
    discoveredModels = discoveryExit.value.value;
  }

  const models =
    discoveredModels.length > 0
      ? kiroModelsFromSettings(kiroSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: kiroSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: parsedAuth.status,
      auth: parsedAuth.auth,
      ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
    },
  });
});

export const enrichKiroSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
