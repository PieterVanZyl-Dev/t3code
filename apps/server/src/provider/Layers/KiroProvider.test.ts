import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KiroSettings } from "@t3tools/contracts";

import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  parseKiroWhoamiOutput,
} from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default with auto in the catalogue", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kiro");
      expect(snapshot.models.map((model) => model.slug)).toContain("auto");
    }),
  );
});

describe("parseKiroWhoamiOutput", () => {
  it("treats the IAM Identity Center marker as authenticated", () => {
    const parsed = parseKiroWhoamiOutput({
      stdout: "Logged in with IAM Identity Center\nEmail: user@example.com\n",
      stderr: "",
      code: 0,
    });
    expect(parsed.status).toBe("ready");
    expect(parsed.auth.status).toBe("authenticated");
    expect(parsed.auth.email).toBe("user@example.com");
  });

  it("treats `authentication required` as unauthenticated with a login hint", () => {
    const parsed = parseKiroWhoamiOutput({
      stdout: "",
      stderr: "authentication required",
      code: 1,
    });
    expect(parsed.status).toBe("error");
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("kiro-cli login");
  });

  it("treats an unrecognized zero-exit output as unknown", () => {
    const parsed = parseKiroWhoamiOutput({ stdout: "something unexpected", stderr: "", code: 0 });
    expect(parsed.status).toBe("ready");
    expect(parsed.auth.status).toBe("unknown");
  });
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kiro-cli-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken kiro install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-version-" });
          const kiroPath = path.join(dir, "kiro-cli");
          yield* fs.writeFileString(
            kiroPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kiro CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports unauthenticated when whoami requires authentication", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-unauth-" });
          const kiroPath = path.join(dir, "kiro-cli");
          yield* fs.writeFileString(
            kiroPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "kiro-cli 2.0.1\\n"; exit 0; fi',
              'if [ "$1" = "whoami" ]; then printf "authentication required\\n" >&2; exit 1; fi',
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2.0.1");
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kiro-cli login");
    }),
  );

  it.effect("falls back to the built-in catalogue when discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-authed-" });
          const kiroPath = path.join(dir, "kiro-cli");
          yield* fs.writeFileString(
            kiroPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "kiro-cli 2.0.1\\n"; exit 0; fi',
              'if [ "$1" = "whoami" ]; then printf "Logged in with IAM Identity Center\\nEmail: user@example.com\\n"; exit 0; fi',
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2.0.1");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.auth.email).toBe("user@example.com");
      expect(snapshot.models.map((model) => model.slug)).toContain("auto");
    }),
  );
});
