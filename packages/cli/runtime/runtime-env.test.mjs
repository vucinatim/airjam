import { EnvValidationError } from "@air-jam/env";
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCreateAirJamRuntimeEnv,
  resolveLocalBackendOrigin,
} from "./runtime-env.mjs";

test("loadCreateAirJamRuntimeEnv parses defaults", () => {
  const runtimeEnv = loadCreateAirJamRuntimeEnv({
    env: {},
    boundary: "create-airjam.runtime-test",
  });

  assert.equal(runtimeEnv.VITE_PORT, 5173);
  assert.equal(runtimeEnv.AIR_JAM_SERVER_PORT, 4000);
  assert.equal(runtimeEnv.AIR_JAM_SECURE_MODE, undefined);
});

test("loadCreateAirJamRuntimeEnv accepts a partial .env-style object", () => {
  const runtimeEnv = loadCreateAirJamRuntimeEnv({
    env: {
      VITE_AIR_JAM_SERVER_URL: "",
    },
    boundary: "create-airjam.runtime-test",
  });

  assert.equal(runtimeEnv.VITE_PORT, 5173);
  assert.equal(runtimeEnv.VITE_AIR_JAM_SERVER_URL, undefined);
});

test("loadCreateAirJamRuntimeEnv rejects invalid secure mode", () => {
  assert.throws(
    () =>
      loadCreateAirJamRuntimeEnv({
        env: { AIR_JAM_SECURE_MODE: "unsupported" },
        boundary: "create-airjam.runtime-test",
      }),
    EnvValidationError,
  );
});

test("loadCreateAirJamRuntimeEnv rejects invalid VITE_PORT", () => {
  assert.throws(
    () =>
      loadCreateAirJamRuntimeEnv({
        env: { VITE_PORT: "abc" },
        boundary: "create-airjam.runtime-test",
      }),
    EnvValidationError,
  );
});

test("loadCreateAirJamRuntimeEnv parses and validates AIR_JAM_SERVER_PORT", () => {
  assert.equal(
    loadCreateAirJamRuntimeEnv({
      env: { AIR_JAM_SERVER_PORT: "4400" },
      boundary: "create-airjam.runtime-test",
    }).AIR_JAM_SERVER_PORT,
    4400,
  );
  assert.throws(
    () =>
      loadCreateAirJamRuntimeEnv({
        env: { AIR_JAM_SERVER_PORT: "not-a-port" },
        boundary: "create-airjam.runtime-test",
      }),
    EnvValidationError,
  );
});

test("resolveLocalBackendOrigin owns default, port, and explicit URL precedence", () => {
  assert.equal(resolveLocalBackendOrigin(), "http://127.0.0.1:4000");
  assert.equal(
    resolveLocalBackendOrigin({ AIR_JAM_SERVER_PORT: 4400 }),
    "http://127.0.0.1:4400",
  );
  assert.equal(
    resolveLocalBackendOrigin({
      AIR_JAM_SERVER_PORT: 4400,
      VITE_AIR_JAM_SERVER_URL: "https://backend.example.test",
    }),
    "https://backend.example.test",
  );
});
