import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

const runCliHelp = (...args) =>
  execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args, "--help"],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  );

const runCli = (...args) =>
  execFileSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

const runCliFailure = (...args) => {
  try {
    runCli(...args);
    assert.fail("Expected Air Jam CLI command to fail.");
  } catch (error) {
    return `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
  }
};

test("airjam reports the installed package version", () => {
  assert.equal(runCli("--version").trim(), "0.9.3");
});

test("airjam exposes dev help", () => {
  const output = runCliHelp("dev");

  assert.match(output, /Usage: airjam dev/);
  assert.match(output, /--secure/);
  assert.match(output, /--preview-managed/);
  assert.match(output, /--server-only/);
  assert.match(output, /AIR_JAM_SERVER_PORT/);
  assert.match(output, /parallel agents/);
});

test("airjam exposes the complete evaluation contract", () => {
  const output = runCliHelp("evaluate");

  assert.match(output, /complete game evaluation/i);
  assert.match(output, /typecheck, lint, tests, and production build/i);
  assert.match(output, /--dir <path>/);
});

test("airjam exposes secure:init help", () => {
  const output = runCliHelp("secure:init");

  assert.match(output, /Usage: airjam secure:init/);
  assert.match(output, /--mode <mode>/);
  assert.match(output, /--hostname <hostname>/);
});

test("airjam exposes topology help", () => {
  const output = runCliHelp("topology");

  assert.match(output, /Usage: airjam topology/);
  assert.match(output, /--mode <mode>/);
  assert.match(output, /standalone-dev/);
  assert.match(output, /VITE_PORT/);
});

test("airjam exposes status help", () => {
  const output = runCliHelp("status");

  assert.match(output, /Usage: airjam status/);
  assert.match(output, /--dir <path>/);
  assert.match(output, /known-port status/);
});

test("airjam exposes reset local help", () => {
  const output = runCliHelp("reset", "local");

  assert.match(output, /Usage: airjam reset local/);
  assert.match(output, /--dir <path>/);
  assert.match(output, /stale known-port/);
});

test("airjam exposes ai-pack help", () => {
  const output = runCliHelp("ai-pack", "status");

  assert.match(output, /Usage: airjam ai-pack status/);
  assert.doesNotMatch(output, /manifest-url/);
  assert.match(runCliHelp("ai-pack", "repair"), /installed CLI/);
});

test("airjam exposes game list help", () => {
  const output = runCliHelp("game", "list");

  assert.match(output, /Usage: airjam game list/);
  assert.match(output, /--platform-url <url>/);
});

test("airjam exposes game create help", () => {
  const output = runCliHelp("game", "create");

  assert.match(output, /Usage: airjam game create/);
  assert.match(output, /--dir <path>/);
  assert.match(output, /--template-id <id>/);
});

test("airjam exposes game inspect help", () => {
  const output = runCliHelp("game", "inspect");

  assert.match(output, /Usage: airjam game inspect/);
  assert.match(output, /--game <slug-or-id>/);
});

test("airjam exposes game update help", () => {
  const output = runCliHelp("game", "update");

  assert.match(output, /Usage: airjam game update/);
  assert.match(output, /--clear-template-id/);
  assert.match(output, /--clear-preview-url/);
});

test("airjam exposes game media inspect help", () => {
  const output = runCliHelp("game", "media", "inspect");

  assert.match(output, /Usage: airjam game media inspect/);
  assert.match(output, /--game <slug-or-id>/);
});

test("airjam exposes game media upload help", () => {
  const output = runCliHelp("game", "media", "upload");

  assert.match(output, /Usage: airjam game media upload/);
  assert.match(output, /--thumbnail <path>/);
  assert.match(output, /--preview-video <path>/);
});

test("airjam exposes game media clear help", () => {
  const output = runCliHelp("game", "media", "clear");

  assert.match(output, /Usage: airjam game media clear/);
  assert.match(output, /--kind <kind>/);
});

test("airjam keeps release bundle help", () => {
  const output = runCliHelp("release", "bundle");

  assert.match(output, /Usage: airjam release bundle/);
  assert.match(output, /--dist-dir <path>/);
});

test("airjam exposes release doctor help", () => {
  const output = runCliHelp("release", "doctor");

  assert.match(output, /Usage: airjam release doctor/);
  assert.match(output, /--dist-dir <path>/);
});

test("airjam exposes release validate help", () => {
  const output = runCliHelp("release", "validate");

  assert.match(output, /Usage: airjam release validate/);
  assert.match(output, /--bundle <path>/);
});

test("airjam exposes release list help", () => {
  const output = runCliHelp("release", "list");

  assert.match(output, /Usage: airjam release list/);
  assert.match(output, /--game <slug-or-id>/);
});

test("airjam exposes release inspect help", () => {
  const output = runCliHelp("release", "inspect");

  assert.match(output, /Usage: airjam release inspect/);
  assert.match(output, /--release <id>/);
});

test("airjam exposes release submit help", () => {
  const output = runCliHelp("release", "submit");

  assert.match(output, /Usage: airjam release submit/);
  assert.match(output, /--game <slug-or-id>/);
  assert.match(output, /--publish/);
});

test("airjam exposes immutable release upload help", () => {
  const output = runCliHelp("release", "upload");

  assert.match(output, /Usage: airjam release upload/);
  assert.match(output, /--release <id>/);
  assert.match(output, /--bundle <path>/);
});

test("airjam exposes exact-generation finalize help", () => {
  const output = runCliHelp("release", "finalize");

  assert.match(output, /Usage: airjam release finalize/);
  assert.match(output, /--release <id>/);
  assert.match(output, /--generation <id>/);
});

test("airjam exposes release publish help", () => {
  const output = runCliHelp("release", "publish");

  assert.match(output, /Usage: airjam release publish/);
  assert.match(output, /--release <id>/);
});

test("airjam exposes exact-generation release export help", () => {
  const output = runCliHelp("release", "export");

  assert.match(output, /Usage: airjam release export/);
  assert.match(output, /--release <id>/);
  assert.match(output, /--generation <id>/);
  assert.match(output, /--out <path>/);
});

test("airjam exposes auth login help", () => {
  const output = runCliHelp("auth", "login");

  assert.match(output, /Usage: airjam auth login/);
  assert.match(output, /--platform-url <url>/);
});

test("airjam exposes auth whoami help", () => {
  const output = runCliHelp("auth", "whoami");

  assert.match(output, /Usage: airjam auth whoami/);
  assert.match(output, /--platform-url <url>/);
});

test("airjam exposes auth logout help", () => {
  const output = runCliHelp("auth", "logout");

  assert.match(output, /Usage: airjam auth logout/);
  assert.match(output, /--platform-url <url>/);
});

test("airjam exposes mcp help", () => {
  const output = runCliHelp("mcp", "doctor");

  assert.match(output, /Usage: airjam mcp doctor/);
  assert.match(output, /--dir <path>/);
});

test("airjam renders explicit MCP client profiles", () => {
  const output = runCliHelp("mcp", "config");

  assert.match(output, /--profile <profile>/);
  assert.match(output, /portable, codex, or claude-desktop/);
});

test("airjam MCP inspection and profiles expose stable JSON", () => {
  const repoRoot = path.resolve(packageRoot, "../..");
  const doctor = JSON.parse(
    runCli("mcp", "doctor", "--dir", repoRoot, "--json"),
  );
  const profile = JSON.parse(
    runCli("mcp", "config", "--dir", repoRoot, "--profile", "codex", "--json"),
  );

  assert.equal(doctor.projectDir, repoRoot);
  assert.equal(doctor.server.name, "airjam");
  assert.equal(profile.profile, "codex");
  assert.equal(profile.format, "toml");
  assert.match(profile.content, /\[mcp_servers\.airjam\]/);
});

test("airjam AI pack inspection exposes stable JSON", () => {
  const managedRoot = path.join(packageRoot, "template-assets", "managed");
  const status = JSON.parse(
    runCli("ai-pack", "status", "--dir", managedRoot, "--json"),
  );

  assert.equal(status.upToDate, true);
  assert.equal(status.comparison.differingFiles.length, 0);
  assert.equal(status.comparison.manifestSource, "packaged-snapshot");
  assert.equal(status.comparison.trustedPackage, "@air-jam/cli");
});

test("airjam AI pack repairs verified same-version drift transactionally", async () => {
  const managedRoot = path.join(packageRoot, "template-assets", "managed");
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airjam-ai-pack-repair-"),
  );
  try {
    await cp(managedRoot, projectRoot, { recursive: true });
    const managedFile = path.join(
      projectRoot,
      "docs/airjam/development-loop.md",
    );
    const expected = await readFile(managedFile, "utf8");
    await writeFile(managedFile, "drifted\n");

    const status = JSON.parse(
      runCli("ai-pack", "status", "--dir", projectRoot, "--json"),
    );
    assert.equal(status.drifted, true);
    const repaired = JSON.parse(
      runCli("ai-pack", "repair", "--dir", projectRoot, "--json"),
    );
    assert.equal(repaired.repaired, true);
    assert.equal(await readFile(managedFile, "utf8"), expected);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test(
  "airjam AI pack restores original files when transactional publication fails",
  { skip: process.platform === "win32" },
  async () => {
    const managedRoot = path.join(packageRoot, "template-assets", "managed");
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "airjam-ai-pack-rollback-"),
    );
    const manifestDirectory = path.join(projectRoot, ".airjam");
    try {
      await cp(managedRoot, projectRoot, { recursive: true });
      const managedFile = path.join(
        projectRoot,
        "docs/airjam/development-loop.md",
      );
      const manifestPath = path.join(manifestDirectory, "ai-pack.json");
      const originalManifest = await readFile(manifestPath, "utf8");
      await writeFile(managedFile, "local drift that must survive failure\n");
      await chmod(manifestDirectory, 0o500);

      assert.match(
        runCliFailure("ai-pack", "repair", "--dir", projectRoot, "--json"),
        /EACCES|EPERM|permission denied/iu,
      );
      assert.equal(
        await readFile(managedFile, "utf8"),
        "local drift that must survive failure\n",
      );
      assert.equal(await readFile(manifestPath, "utf8"), originalManifest);
    } finally {
      await chmod(manifestDirectory, 0o700).catch(() => undefined);
      await rm(projectRoot, { recursive: true, force: true });
    }
  },
);

test("airjam AI pack rejects rollback and unsafe managed paths", async () => {
  const managedRoot = path.join(packageRoot, "template-assets", "managed");
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "airjam-ai-pack-trust-"),
  );
  try {
    await cp(managedRoot, projectRoot, { recursive: true });
    const manifestPath = path.join(projectRoot, ".airjam/ai-pack.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packVersion = "999.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(
      runCliFailure("ai-pack", "update", "--dir", projectRoot, "--json"),
      /Refusing to roll an AI pack back/u,
    );

    manifest.packVersion = "0.1.0";
    manifest.managedFiles[0].path = "../outside.md";
    manifest.contentDigest = createHash("sha256")
      .update(JSON.stringify(manifest.managedFiles))
      .digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.match(
      runCliFailure("ai-pack", "status", "--dir", projectRoot, "--json"),
      /Unsafe AI pack managed path/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("airjam exposes persistent semantic session lifecycle help", () => {
  const output = runCliHelp("session");

  assert.match(output, /persistent semantic game sessions/);
  assert.match(output, /open/);
  assert.match(output, /read/);
  assert.match(output, /invoke/);
  assert.match(output, /close/);
  assert.match(output, /broker/);
});
