import assert from "node:assert/strict";
import test from "node:test";
import {
  AIR_JAM_IFRAME_HEADERS,
  createAirJamViteConfig,
} from "./vite-config.mjs";

test("createAirJamViteConfig default profile keeps Air Jam dev contract minimal", () => {
  const config = createAirJamViteConfig({
    env: {},
    port: 5173,
  });

  assert.equal(config.server.host, true);
  assert.equal(config.server.allowedHosts, true);
  assert.equal(config.server.port, 5173);
  assert.deepEqual(config.server.headers, AIR_JAM_IFRAME_HEADERS);
  assert.deepEqual(config.server.watch.ignored, ["**/.airjam/**"]);
  assert.equal(
    config.server.proxy["/socket.io"].target,
    "http://127.0.0.1:4000",
  );
  assert.equal(config.build.chunkSizeWarningLimit, 1000);
});

test("createAirJamViteConfig three profile keeps core runtime buckets stable", () => {
  const config = createAirJamViteConfig({
    env: {},
    port: 5173,
    profile: "three",
  });

  const manualChunks = config.build?.rollupOptions?.output?.manualChunks;

  assert.equal(typeof manualChunks, "function");
  assert.equal(
    manualChunks("/workspace/node_modules/zod/v4/index.js"),
    "airjam-sdk",
  );
  assert.equal(
    manualChunks("/workspace/node_modules/react/index.js"),
    "app-runtime",
  );
  assert.equal(
    manualChunks("/workspace/node_modules/zustand/react.js"),
    "app-runtime",
  );
  assert.equal(
    manualChunks("/workspace/node_modules/@react-three/fiber/dist/index.js"),
    "fiber-runtime",
  );
});

test("createAirJamViteConfig rejects unknown profiles", () => {
  assert.throws(
    () => createAirJamViteConfig({ profile: "weird" }),
    /Unsupported Air Jam Vite profile/,
  );
});
