import fs from "node:fs";
import { resolveLocalBackendOrigin } from "./runtime-env.mjs";

export const DEFAULT_AIR_JAM_DEV_BACKEND_URL = resolveLocalBackendOrigin();

export const getAirJamHttpsServerOptions = (env = process.env) => {
  const certFile = env.AIR_JAM_DEV_CERT_FILE;
  const keyFile = env.AIR_JAM_DEV_KEY_FILE;
  if (!certFile || !keyFile) {
    return undefined;
  }

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    return undefined;
  }

  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  };
};

export const getAirJamDevBackendUrl = (env = process.env) =>
  env.AIR_JAM_DEV_PROXY_BACKEND_URL?.trim() ||
  resolveLocalBackendOrigin(env);

export const getAirJamDevProxyOptions = (env = process.env) => {
  const target = getAirJamDevBackendUrl(env);

  return {
    "/socket.io": {
      target,
      ws: true,
      changeOrigin: true,
    },
    "/__airjam": {
      target,
      changeOrigin: true,
    },
  };
};
