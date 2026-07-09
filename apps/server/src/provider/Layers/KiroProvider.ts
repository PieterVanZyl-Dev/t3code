import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type {
  KiroModelOptions,
  KiroSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  ServerSettingsError,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { Cause, Effect, Equal, Exit, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { KiroProvider } from "../Services/KiroProvider.ts";
import { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "kiro" as const;
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const KIRO_ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
const KIRO_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
const KIRO_REFRESH_INTERVAL = "1 hour";
const KIRO_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
export const KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

function buildInitialKiroProviderSnapshot(kiroSettings: KiroSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getKiroFallbackModels(kiroSettings);

  if (!kiroSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
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
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Kiro Agent availability...",
    },
  });
}

interface KiroSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface KiroAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KiroSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() } satisfies KiroSessionSelectOption]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies KiroSessionSelectOption,
        ),
  );
}

function normalizeKiroReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function findKiroModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function getKiroConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isKiroEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findKiroEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isKiroEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getKiroConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getKiroConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isKiroContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isKiroFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isKiroThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

export function buildKiroCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findKiroEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeKiroReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeKiroReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroThinkingConfigOption(option),
  );

  return {
    reasoningEffortLevels,
    supportsFastMode: fastOption ? isBooleanLikeConfigOption(fastOption) : false,
    supportsThinkingToggle: thinkingOption ? isBooleanLikeConfigOption(thinkingOption) : false,
    contextWindowOptions,
    promptInjectedEffortLevels: [],
  };
}

function buildKiroDiscoveredModels(
  discoveredModels: ReadonlyArray<KiroAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function hasKiroModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (
    (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
    model.capabilities?.supportsFastMode === true ||
    model.capabilities?.supportsThinkingToggle === true ||
    (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
    (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0
  );
}

export function buildKiroDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelOption = findKiroModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }

  const currentModelValue =
    modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
  const currentModelCapabilities = buildKiroCapabilitiesFromConfigOptions(configOptions);

  return buildKiroDiscoveredModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

const makeKiroAcpProbeRuntime = (kiroSettings: KiroSettings) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: kiroSettings.binaryPath,
          args: [
            ...(kiroSettings.apiEndpoint ? (["-e", kiroSettings.apiEndpoint] as const) : []),
            "acp",
          ],
          cwd: process.cwd(),
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        clientCapabilities: KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withKiroAcpProbeRuntime = <A, E, R>(
  kiroSettings: KiroSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeKiroAcpProbeRuntime(kiroSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

function normalizeKiroConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findKiroSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: KiroSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findKiroBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findKiroSelectOptionValue(
    configOption,
    (option) => normalizeKiroConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveKiroAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelOptions: KiroModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];

  const reasoningOption = findKiroEffortConfigOption(configOptions);
  const requestedReasoning = normalizeKiroReasoningValue(modelOptions?.reasoning);
  if (reasoningOption && requestedReasoning) {
    const value = findKiroSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeKiroReasoningValue(option.value);
      const normalizedName = normalizeKiroReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroContextConfigOption(option),
  );
  if (contextOption && modelOptions?.contextWindow) {
    const value = findKiroSelectOptionValue(
      contextOption,
      (option) =>
        normalizeKiroConfigOptionToken(option.value) ===
          normalizeKiroConfigOptionToken(modelOptions.contextWindow) ||
        normalizeKiroConfigOptionToken(option.name) ===
          normalizeKiroConfigOptionToken(modelOptions.contextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroFastConfigOption(option),
  );
  if (fastOption && typeof modelOptions?.fastMode === "boolean") {
    const value = findKiroBooleanConfigValue(fastOption, modelOptions.fastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isKiroThinkingConfigOption(option),
  );
  if (thinkingOption && typeof modelOptions?.thinking === "boolean") {
    const value = findKiroBooleanConfigValue(thinkingOption, modelOptions.thinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

export const discoverKiroModelsViaAcp = (kiroSettings: KiroSettings) =>
  withKiroAcpProbeRuntime(kiroSettings, (acp) =>
    Effect.map(acp.start(), (started) => {
      // Kiro exposes its built-in models via the top-level `models.availableModels`
      // field on the session setup response (not via Cursor's `configOptions`).
      const availableModels = started.sessionSetupResult.models?.availableModels ?? [];
      return availableModels.map(
        (model): ServerProviderModel => ({
          slug: model.modelId,
          name: model.modelId,
          isCustom: false,
          capabilities: null,
        }),
      );
    }),
  );

export const discoverKiroModelCapabilitiesViaAcp = (
  kiroSettings: KiroSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
) =>
  withKiroAcpProbeRuntime(kiroSettings, (acp) =>
    Effect.gen(function* () {
      const started = yield* acp.start();
      const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
      const modelOption = findKiroModelConfigOption(initialConfigOptions);
      const modelChoices = flattenSessionConfigSelectOptions(modelOption);
      if (!modelOption || modelChoices.length === 0) {
        return [];
      }

      const currentModelValue =
        modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
      const capabilitiesBySlug = new Map<string, ModelCapabilities>();
      if (currentModelValue) {
        capabilitiesBySlug.set(
          currentModelValue,
          buildKiroCapabilitiesFromConfigOptions(initialConfigOptions),
        );
      }

      const targetModelSlugs = new Set(
        existingModels
          .filter((model) => !model.isCustom && !hasKiroModelCapabilities(model))
          .map((model) => model.slug),
      );
      if (targetModelSlugs.size === 0) {
        return buildKiroDiscoveredModels(
          modelChoices.map((modelChoice) => ({
            slug: modelChoice.value.trim(),
            name: modelChoice.name.trim(),
            capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
          })),
        );
      }

      const probedCapabilities = yield* Effect.forEach(
        modelChoices,
        (modelChoice) => {
          const modelSlug = modelChoice.value.trim();
          if (!modelSlug || !targetModelSlugs.has(modelSlug) || capabilitiesBySlug.has(modelSlug)) {
            return Effect.void.pipe(
              Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
            );
          }

          return withKiroAcpProbeRuntime(kiroSettings, (probeAcp) =>
            Effect.gen(function* () {
              const probeStarted = yield* probeAcp.start();
              const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
              const probeModelOption = findKiroModelConfigOption(probeConfigOptions);
              const probeCurrentModelValue =
                probeModelOption?.type === "select"
                  ? probeModelOption.currentValue?.trim() || undefined
                  : undefined;
              yield* Effect.annotateCurrentSpan({
                "kiro.acp.model.value": modelSlug,
                "kiro.acp.model.currentValue": probeCurrentModelValue,
                "kiro.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
              });
              const nextConfigOptions =
                probeCurrentModelValue === modelSlug
                  ? probeConfigOptions
                  : yield* probeAcp
                      .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                      .pipe(Effect.map((response) => response.configOptions ?? probeConfigOptions));
              return [
                modelSlug,
                buildKiroCapabilitiesFromConfigOptions(nextConfigOptions),
              ] as const;
            }),
          ).pipe(
            Effect.timeout(KIRO_ACP_MODEL_CAPABILITY_TIMEOUT),
            Effect.retry({ times: 3 }),
            Effect.withSpan("kiro-acp-model-capability-probe"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Kiro ACP capability probe failed", {
                modelSlug,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: KIRO_ACP_MODEL_DISCOVERY_CONCURRENCY },
      );

      for (const entry of probedCapabilities) {
        if (!entry) {
          continue;
        }
        capabilitiesBySlug.set(entry[0], entry[1]);
      }

      return buildKiroDiscoveredModels(
        modelChoices.map((modelChoice) => ({
          slug: modelChoice.value.trim(),
          name: modelChoice.name.trim(),
          capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
        })),
      );
    }).pipe(Effect.withSpan("kiro-acp-model-capability-discovery", {})),
  );

export function getKiroFallbackModels(
  kiroSettings: Pick<KiroSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, kiroSettings.customModels, EMPTY_CAPABILITIES);
}

/** Timeout for `agent about` — it's slower than a simple `--version` probe. */
const ABOUT_TIMEOUT_MS = 8_000;

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface KiroAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildKiroProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly kiroSettings: KiroSettings;
  readonly parsed: KiroAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProvider {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: input.kiroSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.kiroSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

interface KiroAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseKiroVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseKiroCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function kiroSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function kiroAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = kiroSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Kiro ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseKiroAboutJsonPayload(raw: string): KiroAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as KiroAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isKiroAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

function readKiroCliConfigChannel(): string | undefined {
  try {
    const configPath = nodePath.join(nodeOs.homedir(), ".kiro", "cli-config.json");
    return parseKiroCliConfigChannel(nodeFs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function getKiroParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseKiroVersionDate(input.version);
  if (versionDate !== undefined && versionDate < KIRO_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE) {
    reasons.push(
      `Kiro Agent CLI version ${input.version} is too old for Kiro ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Kiro Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Kiro Agent CLI 2026.04.08 or newer.`;
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Kiro CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Kiro CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseKiroAboutOutput(result: CommandResult): KiroAboutResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const plain = stripAnsi(combined);

  // `kiro-cli --version` prints e.g. "kiro-cli 2.0.1".
  const versionMatch = /\bkiro-cli\s+(\S+)/i.exec(plain);
  const version = versionMatch?.[1]?.trim() ?? null;

  const lowerOutput = plain.toLowerCase();
  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("please log in")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Kiro Agent is not authenticated. Run `kiro-cli login` and try again.",
    };
  }

  // `kiro-cli whoami` prints "Logged in with IAM Identity Center ..." + "Email: <email>".
  const emailMatch = /^Email:\s*(.+)$/m.exec(plain);
  const loggedIn = /logged in/i.test(plain);
  if (emailMatch || loggedIn) {
    return {
      version,
      status: "ready",
      auth: { status: "authenticated" },
    };
  }

  // whoami succeeded but we couldn't find obvious markers — treat as unknown.
  if (result.code === 0) {
    return { version, status: "ready", auth: { status: "unknown" } };
  }
  return {
    version,
    status: "warning",
    auth: { status: "unknown" },
    message: "Could not verify Kiro Agent authentication status.",
  };
}

const runKiroCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const kiroSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kiro),
    );
    const command = ChildProcess.make(kiroSettings.binaryPath, [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runKiroAboutCommand = Effect.gen(function* () {
  // Kiro CLI doesn't have an `about` subcommand. Probe version and auth separately
  // then synthesize a combined result that parseKiroAboutOutput can consume.
  const versionResult = yield* runKiroCommand(["--version"]);
  if (versionResult.code !== 0) {
    return versionResult;
  }
  const whoamiResult = yield* runKiroCommand(["whoami"]);
  return {
    stdout: `${versionResult.stdout}\n${whoamiResult.stdout}`,
    stderr: whoamiResult.stderr,
    code: whoamiResult.code,
  } satisfies CommandResult;
});

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const kiroSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kiro),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getKiroFallbackModels(kiroSettings);

    if (!kiroSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
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

    // Single `agent about` probe: returns version + auth status in one call.
    const aboutProbe = yield* runKiroAboutCommand.pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(aboutProbe)) {
      const error = aboutProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kiroSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Kiro Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Kiro Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(aboutProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kiroSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Kiro CLI is installed but timed out while probing version/auth.",
        },
      });
    }

    const parsed = parseKiroAboutOutput(aboutProbe.success.value);
    const parameterizedModelPickerUnsupportedMessage =
      getKiroParameterizedModelPickerUnsupportedMessage({
        version: parsed.version,
        channel: readKiroCliConfigChannel(),
      });
    if (parameterizedModelPickerUnsupportedMessage) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kiroSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsed.version,
          status: "error",
          auth: parsed.auth,
          message:
            parsed.auth.status === "unauthenticated" && parsed.message
              ? `${parameterizedModelPickerUnsupportedMessage} ${parsed.message}`
              : parameterizedModelPickerUnsupportedMessage,
        },
      });
    }
    // Kiro has no `kiro-cli about --list-models` equivalent, so we discover
    // the built-in model catalogue via a short-lived `kiro-cli acp` session.
    // Log failures quietly — don't surface them as UI warnings since a missing
    // catalogue still leaves `auto` + custom models working.
    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    if (parsed.auth.status !== "unauthenticated") {
      const discoveryExit = yield* Effect.exit(
        discoverKiroModelsViaAcp(kiroSettings).pipe(
          Effect.timeoutOption(KIRO_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        yield* Effect.logWarning("Kiro ACP model discovery failed", {
          cause: Cause.pretty(discoveryExit.cause),
        });
      } else if (Option.isSome(discoveryExit.value) && discoveryExit.value.value.length > 0) {
        discoveredModels = discoveryExit.value;
      }
    }
    const discoveryWarning: string | undefined = undefined;
    return buildKiroProviderSnapshot({
      checkedAt,
      kiroSettings,
      parsed,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export const KiroProviderLive = Layer.effect(
  KiroProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkKiroProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<KiroSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kiro),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kiro),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialKiroProviderSnapshot,
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        if (
          !settings.enabled ||
          snapshot.auth.status === "unauthenticated" ||
          !snapshot.models.some((model) => !model.isCustom && !hasKiroModelCapabilities(model))
        ) {
          return Effect.void;
        }

        return discoverKiroModelCapabilitiesViaAcp(settings, snapshot.models).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.flatMap((discoveredModels) => {
            if (discoveredModels.length === 0) {
              return Effect.void;
            }

            return publishSnapshot({
              ...snapshot,
              models: providerModelsFromSettings(
                discoveredModels,
                PROVIDER,
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
            });
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kiro ACP background capability enrichment failed", {
              models: snapshot.models.map((model) => model.slug),
              cause: Cause.pretty(cause),
            }).pipe(Effect.asVoid),
          ),
        );
      },
      refreshInterval: KIRO_REFRESH_INTERVAL,
    });
  }),
);
