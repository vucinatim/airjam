import assert from "node:assert/strict";
import test from "node:test";

import { loadCreateAirJamRuntimeEnv } from "./runtime-env.mjs";
import { resolveProjectSurfaceTopology } from "./topology.mjs";

test("standalone topology consumes the validated numeric Vite port", () => {
  const env = loadCreateAirJamRuntimeEnv({
    env: { VITE_PORT: "53417", AIR_JAM_SERVER_PORT: "43400" },
    boundary: "create-airjam.topology-test",
  });
  const topology = resolveProjectSurfaceTopology({
    runtimeMode: "standalone-dev",
    secure: false,
    env,
    surfaceRole: "host",
    cwd: process.cwd(),
  });

  assert.equal(new URL(topology.appOrigin).port, "53417");
  assert.equal(new URL(topology.publicHost).port, "53417");
  assert.equal(new URL(topology.socketOrigin).port, "53417");
  assert.equal(topology.backendOrigin, "http://127.0.0.1:43400");
});

test("standalone topology consumes the validated default Vite port", () => {
  const env = loadCreateAirJamRuntimeEnv({
    env: { VITE_PORT: "" },
    boundary: "create-airjam.topology-test",
  });
  const topology = resolveProjectSurfaceTopology({
    runtimeMode: "standalone-dev",
    secure: false,
    env,
    surfaceRole: "host",
    cwd: process.cwd(),
  });

  assert.equal(new URL(topology.appOrigin).port, "5173");
});
