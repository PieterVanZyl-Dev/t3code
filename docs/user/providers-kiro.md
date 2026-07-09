# Kiro

This guide is for people who want to use Kiro CLI as a coding agent in T3 Code.

Kiro is AWS's coding-agent CLI. In T3 Code it runs as `kiro-cli acp`, speaking ACP
(Agent Client Protocol) — the same protocol used by Cursor, Grok, and OpenCode. That
means Kiro turns stream content, tool calls, plans, diffs, and agent thoughts the same
way the other ACP providers do.

Kiro is offered as **Early Access**.

## Prerequisites

You need the Kiro CLI installed and reachable.

- Install `kiro-cli` and make sure it is on your `PATH`, or
- point T3 Code at a specific binary with `Binary path` in Settings.

Confirm the CLI works:

```bash
kiro-cli --version
```

T3 Code uses `kiro-cli --version` to detect that the CLI is installed and to show its
version in Settings.

## Authentication

Kiro authenticates **externally**, through AWS IAM Identity Center (SSO). There is **no
in-app login** for Kiro in T3 Code — the ACP session advertises no auth methods, so T3
Code never prompts you for Kiro credentials.

Log in from a terminal:

```bash
kiro-cli login
```

T3 Code reports your status by running `kiro-cli whoami`:

- `Logged in with IAM Identity Center` and/or an `Email: <…>` line ⇒ **authenticated**
  (the email is shown on the provider row in Settings)
- output asking you to log in ⇒ **unauthenticated**; T3 Code tells you to run
  `kiro-cli login`
- anything else ⇒ **unknown**

If Settings shows Kiro as unauthenticated, run `kiro-cli login` in a terminal and refresh
provider status.

## Settings

Kiro's provider settings are:

```text
Display name: Kiro
Binary path:  kiro-cli
API endpoint: empty
```

### Binary path

Leave this as `kiro-cli` to use the CLI from your `PATH`, or set an absolute path to a
specific binary.

### API endpoint

Optional. When set, T3 Code passes it to the CLI as `-e <apiEndpoint>` before the `acp`
subcommand (`kiro-cli -e <apiEndpoint> acp`). Leave it empty to use Kiro's default
endpoint.

### Custom models

You can add extra model slugs to the picker if you want models that live discovery does
not surface. Custom models are merged with the models Kiro reports for the session.

## Models

Kiro's default model is `auto` — Kiro routes the task to an appropriate model for you.

The available models are **discovered per session**: T3 Code reads them from the ACP
`session/new` response, so the picker reflects what your Kiro account actually offers. If
discovery is unavailable (for example before the first session, or if the probe times
out), T3 Code falls back to a built-in catalogue and keeps `auto` plus any custom models
usable.

You can **switch models within a session**. Kiro uses the standard ACP `session/set_model`
request, so changing the model applies to the next turn without starting a new thread.

## Resuming a thread

Kiro supports resuming an existing session. T3 Code persists Kiro's session id in the
thread's continuation cursor and reloads it with ACP `session/load`, so you can pick a
Kiro thread back up where you left off. Replayed history from the reload is filtered out
so it is not shown twice.
