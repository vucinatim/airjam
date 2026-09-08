import type { Server } from "node:http";

export const getHttpServerLoopbackUrl = (server: Server): string => {
  const address = server.address();
  if (address === null) {
    throw new Error(
      "Cannot resolve a test URL before the HTTP server is listening",
    );
  }
  if (typeof address === "string") {
    throw new Error("Cannot resolve an HTTP test URL for a Unix socket");
  }

  const host =
    address.address === "::"
      ? "::1"
      : address.address === "0.0.0.0"
        ? "127.0.0.1"
        : address.address;
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return `http://${urlHost}:${address.port}`;
};
