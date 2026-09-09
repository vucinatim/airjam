import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendNextHttpsArgs,
  buildLocalCertificateHosts,
  buildSecureGameEnv,
  getSecurePaths,
  loadSecureDevState,
  parseGameDevArgs,
  parseSecureInitArgs,
  resolveRequestedSecureMode,
  resolveSecureLoopbackHost,
  resolveSecurePlatformHost,
  resolveSecurePublicHost,
  SECURE_MODE_LOCAL,
  SECURE_MODE_TUNNEL,
} from "./secure-dev.mjs";

test("resolveRequestedSecureMode prefers explicit flag", () => {
  assert.equal(
    resolveRequestedSecureMode({
      argv: ["--secure-mode=tunnel"],
      env: { AIR_JAM_SECURE_MODE: "local" },
    }),
    SECURE_MODE_TUNNEL,
  );
});

test("parseSecureInitArgs defaults to local mode", () => {
  assert.deepEqual(parseSecureInitArgs([], {}), {
    mode: SECURE_MODE_LOCAL,
    hostname: "",
    tunnel: "",
  });
});

test("parseGameDevArgs parses secure flags", () => {
  assert.deepEqual(
    parseGameDevArgs(
      ["--secure", "--secure-mode=tunnel", "--preview-managed"],
      {
        VITE_PORT: "5317",
      },
    ),
    {
      secure: true,
      secureMode: SECURE_MODE_TUNNEL,
      previewManaged: true,
      webOnly: false,
      serverOnly: false,
      allowExistingGame: false,
      port: 5317,
    },
  );
});

test("parseGameDevArgs keeps legacy web-only shape", () => {
  assert.deepEqual(
    parseGameDevArgs(["--web-only"], {
      VITE_PORT: "5317",
    }),
    {
      secure: false,
      secureMode: SECURE_MODE_LOCAL,
      previewManaged: false,
      webOnly: true,
      serverOnly: false,
      allowExistingGame: false,
      port: 5317,
    },
  );
});

test("buildLocalCertificateHosts includes LAN IP when present", () => {
  assert.deepEqual(buildLocalCertificateHosts("192.168.0.20"), [
    "localhost",
    "127.0.0.1",
    "::1",
    "192.168.0.20",
  ]);
});

test("resolveSecurePublicHost uses LAN IP for local mode", () => {
  assert.equal(
    resolveSecurePublicHost({
      mode: SECURE_MODE_LOCAL,
      port: 5173,
      lanIp: "192.168.0.20",
      tunnelHost: null,
    }),
    "https://192.168.0.20:5173",
  );
});

test("resolveSecurePublicHost uses tunnel host for tunnel mode", () => {
  assert.equal(
    resolveSecurePublicHost({
      mode: SECURE_MODE_TUNNEL,
      port: 5173,
      lanIp: "192.168.0.20",
      tunnelHost: "https://dev.example.com",
    }),
    "https://dev.example.com",
  );
});

test("resolveSecureLoopbackHost stays on 127.0.0.1", () => {
  assert.equal(resolveSecureLoopbackHost(5173), "https://127.0.0.1:5173");
});

test("resolveSecurePlatformHost uses LAN IP for local mode", () => {
  assert.equal(
    resolveSecurePlatformHost({
      mode: SECURE_MODE_LOCAL,
      lanIp: "192.168.0.20",
    }),
    "https://192.168.0.20:3000",
  );
});

test("appendNextHttpsArgs adds Next experimental HTTPS flags", () => {
  assert.deepEqual(
    appendNextHttpsArgs({
      env: {
        AIR_JAM_DEV_CERT_FILE: "/tmp/local-dev.pem",
        AIR_JAM_DEV_KEY_FILE: "/tmp/local-dev-key.pem",
      },
      args: ["dev"],
    }),
    [
      "dev",
      "--experimental-https",
      "--experimental-https-key",
      "/tmp/local-dev-key.pem",
      "--experimental-https-cert",
      "/tmp/local-dev.pem",
    ],
  );
});

test("buildSecureGameEnv forwards the secure runtime contract", () => {
  assert.deepEqual(
    buildSecureGameEnv({
      secureState: {
        mode: SECURE_MODE_LOCAL,
        publicHost: "https://192.168.0.20:5173",
        certFile: "/tmp/local-dev.pem",
        keyFile: "/tmp/local-dev-key.pem",
      },
      webOnly: true,
      backendOrigin: "http://127.0.0.1:4000",
    }),
    {
      AIR_JAM_SECURE_MODE: SECURE_MODE_LOCAL,
      AIR_JAM_SECURE_PUBLIC_HOST: "https://192.168.0.20:5173",
      AIR_JAM_DEV_CERT_FILE: "/tmp/local-dev.pem",
      AIR_JAM_DEV_KEY_FILE: "/tmp/local-dev-key.pem",
      AIR_JAM_DEV_PROXY_BACKEND_URL: "http://127.0.0.1:4000",
      VITE_AIR_JAM_PUBLIC_HOST: "https://192.168.0.20:5173",
      VITE_AIR_JAM_RUNTIME_TOPOLOGY:
        '{"runtimeMode":"standalone-secure","surfaceRole":"host","appOrigin":"https://192.168.0.20:5173","backendOrigin":"http://127.0.0.1:4000","socketOrigin":"https://192.168.0.20:5173","publicHost":"https://192.168.0.20:5173","assetBasePath":"/","secureTransport":true,"embedded":false,"proxyStrategy":"dev-proxy"}',
    },
  );
});

test("loadSecureDevState reads persisted tunnel metadata", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-secure-dev-"));
  const paths = getSecurePaths(cwd);
  fs.mkdirSync(paths.certDir, { recursive: true });
  fs.writeFileSync(paths.certFile, "cert", "utf8");
  fs.writeFileSync(paths.keyFile, "key", "utf8");
  fs.writeFileSync(
    paths.secureDevStateFile,
    JSON.stringify(
      {
        version: 1,
        mode: SECURE_MODE_TUNNEL,
        generatedAt: new Date().toISOString(),
        lanIp: "192.168.0.20",
        certFile: paths.certFile,
        keyFile: paths.keyFile,
        hosts: buildLocalCertificateHosts("192.168.0.20"),
        publicHost: "https://dev.example.com",
        tunnelHost: "https://dev.example.com",
        tunnelName: "airjam-dev",
      },
      null,
      2,
    ),
    "utf8",
  );

  const state = loadSecureDevState({
    cwd,
    mode: SECURE_MODE_TUNNEL,
    gamePort: 5173,
  });

  assert.equal(state.publicHost, "https://dev.example.com");
  assert.equal(state.loopbackHost, "https://127.0.0.1:5173");
  assert.equal(state.platformHost, "https://dev.example.com");
  assert.equal(state.tunnelName, "airjam-dev");
});

test("loadSecureDevState requires secure:init output first", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-secure-dev-"));

  assert.throws(
    () =>
      loadSecureDevState({
        cwd,
        mode: SECURE_MODE_LOCAL,
      }),
    /Run `airjam secure:init` first/,
  );
});
