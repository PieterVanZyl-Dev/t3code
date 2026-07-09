# Kiro CLI Provider Integration Plan (ACP)

> **Status: complete.** All phases below shipped. Kiro is selectable in the
> provider picker (Early Access), authenticates externally via AWS IAM Identity
> Center, discovers models from `session/new`, resumes via `session/load`, and
> emits the full canonical event vocabulary. User-facing docs live in
> `docs/user/providers-kiro.md`.

Add **Kiro CLI** as a coding-agent provider alongside Codex, Claude, Cursor, Grok, and
OpenCode. Kiro speaks ACP (Agent Client Protocol — JSON-RPC 2.0 over newline-delimited
stdio), the same protocol Cursor, Grok, and OpenCode already use, so the integration
builds on the shared `apps/server/src/provider/acp/` scaffolding
(`AcpSessionRuntime`, `AcpAdapterSupport`, `AcpCoreRuntimeEvents`).

A previous implementation attempt lives on the `ref-implem` branch. That branch predates
the current **driver architecture** (`provider/Drivers/*Driver.ts` + `builtInDrivers.ts`

- `textGeneration/`), so its files are used as _protocol reference only_ — the code must
  be re-mapped onto the current `GrokDriver` pattern, which is the closest sibling
  (Grok already reads models from the `session/new` response and uses the standard ACP
  `session/set_model`).

## Kiro-specific protocol facts

### Spawn

- Command: `kiro-cli acp` (binary resolved as `kiroSettings.binaryPath || "kiro-cli"`).
- Optional endpoint override: prepend `-e <apiEndpoint>` **before** the `acp` subcommand.

### Auth — biggest divergence from Cursor/Grok

- Kiro authenticates externally via AWS IAM Identity Center (SSO), **not** via ACP
  `authenticate`. The agent advertises **no auth methods** — the ACP `authenticate`
  step must be **skipped entirely when `authMethods` is empty** (Cursor passes
  `authMethodId: "cursor_login"`, Grok picks between `xai.api_key`/`cached_token`;
  Kiro passes none).
- Health/auth probe: there is **no `about` subcommand**. Probe version and auth
  separately:
  - version: `kiro-cli --version` (prints e.g. `kiro-cli 2.0.1`)
  - auth: `kiro-cli whoami` — success markers `"Logged in with IAM Identity Center"`
    and/or `"Email: <…>"` ⇒ `authenticated`; output containing
    `"authentication required"` ⇒ `unauthenticated` (surface message: run
    `kiro-cli login`); anything else ⇒ `unknown`.

### Models — second divergence

- Available models come from the **`session/new` response `.models` field** (not from
  `configOptions`, and not via the Cursor-only model-discovery ACP extension).
- Model switching uses the **standard ACP `session/set_model`** request.
- Declare client capability **`KIRO_PARAMETERIZED_MODEL_PICKER_CAPABILITIES`** at
  `initialize` (see ref-implem `KiroProvider.ts:45`); helper shapes from the reference:
  `resolveKiroAcpBaseModelId(model)`, `resolveKiroAcpConfigUpdates(configOptions, modelOptions)`.
- Default model: `"auto"` (task-routed). Known catalogue (from
  `kiro-cli chat --list-models`): `auto`, `claude-opus-4.6`, `claude-opus-4.6-1m`,
  `claude-sonnet-4.6`, `claude-sonnet-4.6-1m`, `claude-opus-4.5`, `claude-sonnet-4.5`,
  `claude-sonnet-4`, `claude-haiku-4.5`, `deepseek-3.2`, `kimi-k2.5`, `minimax-m2.1`,
  `minimax-m2.5`, `qwen3-coder-next`, `qwen3-coder-480b`, `agi-nova-beta-1m`.
  There is no offline list-models probe usable at snapshot time — discover via
  `session/new` and keep `auto` + custom models working when discovery is unavailable.
- Capability: `{ sessionModelSwitch: "in-session" }`.

### Resume

- Kiro supports ACP `session/load`. Persist the session id in an opaque continuation
  cursor: `{ version: 1, sessionId?: string }`.

### Canonical event mapping — full vocabulary required

The old KiroAdapter under-emitted events, so Kiro turns rendered far less than Codex.
The adapter emits the complete canonical vocabulary (verified against `CodexAdapter`
and `GrokAdapter` behaviour):

- `content.delta`, `item.started`, `item.completed`, `turn.started`, `turn.completed`
- **`item.updated`** — ACP `tool_call` `in_progress` follow-ups (dropped in the old branch)
- **cancellation** — Kiro represents an aborted turn as `turn.completed` with
  `payload.state = "cancelled"` (the shared `RuntimeTurnState` covers
  `completed`/`failed`/`interrupted`/`cancelled`), rather than emitting the distinct
  `turn.aborted` event that Codex/OpenCode use. `session/cancel` therefore settles the
  in-flight turn once as a cancelled `turn.completed`.
- **`turn.diff.updated`** — ACP `Diff` tool-call content, surfaced as a first-class
  event (not buried in `item.completed`). Kiro emits diffs via `turn.diff.updated`
  content; the shared scaffolding (`makeAcpDiffUpdatedEvent` in `AcpCoreRuntimeEvents`)
  now maps this, and both the `tool_call` and `tool_call_update` diff payloads surface.
- **`turn.plan.updated`** — ACP `Plan`/`PlanEntry` updates
- **`turn.proposed.delta` / `turn.proposed.completed`** — streaming agent thoughts
  (`turn.proposed.*` thought chunks) as deltas, plus a single post-turn summary flushed
  before the turn settles. The shared scaffolding
  (`makeAcpProposedDeltaEvent` / `makeAcpProposedCompletedEvent`) now maps these thought
  chunks; a turn that streams no thoughts emits no proposed events (mirrors Codex).
- **`session.started` / `session.state.changed`**, `session.exited`
- `thread.*`, `request.opened`, `request.resolved` (permission requests)

The `turn.diff.updated` and `turn.proposed.*` mappings live in the shared ACP
scaffolding, so Cursor and Grok can adopt them too; those adapters do not emit the new
events yet (only KiroAdapter wires them today).

## Phases

All phases are complete (✅).

| Phase                       | Scope                                                                                            | Files                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts ✅             | `kiro` driver kind, `KiroSettings`, model defaults/aliases, display name                         | `packages/contracts/src/model.ts`, `settings.ts` (and `orchestration.ts` only if provider-kind unions require it)                                             |
| 2. ACP support ✅           | Spawn input, initialize capabilities, auth skip, model-selection helpers                         | `apps/server/src/provider/acp/KiroAcpSupport.ts` (+ test)                                                                                                     |
| 3. Status probe ✅          | `--version` + `whoami` probes, snapshot build/enrich                                             | `apps/server/src/provider/Layers/KiroProvider.ts` (+ test)                                                                                                    |
| 4. Adapter ✅               | Turn/session runtime on `AcpAdapterSupport`, full event vocabulary, `session/load` resume cursor | `apps/server/src/provider/Layers/KiroAdapter.ts`, `provider/Services/KiroAdapter.ts` (+ tests)                                                                |
| 5. Driver + registration ✅ | `KiroDriver` following `GrokDriver`, register in `builtInDrivers.ts`                             | `apps/server/src/provider/Drivers/KiroDriver.ts`, `builtInDrivers.ts`                                                                                         |
| 6. Text generation ✅       | Commit-message/title generation routed through Kiro                                              | `apps/server/src/textGeneration/KiroTextGeneration.ts` (+ test), `TextGeneration.ts`                                                                          |
| 7. Web UI ✅                | Provider picker entry, settings panel meta, icon mapping                                         | `apps/web/src/components/chat/providerIconUtils.ts`, `components/settings/providerDriverMeta.ts`, `session-logic.ts` (KiroIcon already exists in `Icons.tsx`) |
| 8. Verification & docs ✅   | Event-vocabulary audit vs Codex, full `typecheck`/`lint`/`test` runs, provider docs              | `docs/user/providers-kiro.md`, this plan                                                                                                                           |

Phases 1–3 shipped together (work package A), 4–6 together (work package B), 7 (C), 8 (D).

## Definition of done

- ✅ `vp run -r typecheck`, `vp lint`, and the package test suites green on Node 24
  (the only red is pre-existing sandbox-environmental noise unrelated to Kiro:
  `infra/relay`'s network-blocked `alchemy`/`@cloudflare/workers-types`, the PTY
  `terminal/Manager.test.ts`, and loopback port-binding tests).
- ✅ Kiro selectable in the provider picker (Early Access); status shows "Kiro" +
  authenticated via `whoami`.
- ✅ A turn streams content, tool calls, diffs, and plan entries comparable to Codex.

## Environment note

`infra/relay` pins `alchemy` to a `pkg.ing` tarball that is unreachable in restricted
network environments; dependency installation may need `infra/*` temporarily excluded
from `pnpm-workspace.yaml`. This does not affect the Kiro scope (contracts, server, web).
