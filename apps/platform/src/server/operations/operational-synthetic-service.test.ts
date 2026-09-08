import type { Socket } from "socket.io-client";
import { describe, expect, it } from "vitest";
import { getOperationalSyntheticCheck } from "./operational-reliability-policy";
import {
  anchorOperationalSyntheticRunToDatabaseTime,
  executeOperationalSyntheticCheck,
  type OperationalSyntheticRuntimeConfig,
} from "./operational-synthetic-service";

const config: OperationalSyntheticRuntimeConfig = {
  environment: "test",
  targets: {
    "platform.home": "https://platform.example.test/",
    "platform.docs": "https://platform.example.test/docs",
    "platform.arcade": "https://platform.example.test/arcade",
    "platform.health": "https://platform.example.test/api/health",
    "platform.readiness": "https://platform.example.test/api/readiness",
    "realtime.health": "https://realtime.example.test/health",
    "hosted.release": "https://release.example.test/",
    "worker.ready": "https://worker.example.test/ready",
    "browser_worker.health": "https://browser-worker.example.test/health",
    "realtime.room_controller": "https://realtime.example.test/",
    "realtime.semantic_action": "https://realtime.example.test/",
  },
  realtimeOrigin: "https://realtime.example.test",
  requestOrigin: "https://platform.example.test",
  appId: "app:synthetic-test",
};

const execute = (
  checkId: string,
  options: {
    runtimeConfig?: OperationalSyntheticRuntimeConfig;
    fetchImpl?: typeof fetch;
    socketFactory?: typeof import("socket.io-client").io;
  } = {},
) =>
  executeOperationalSyntheticCheck({
    check: getOperationalSyntheticCheck(checkId),
    config: options.runtimeConfig ?? config,
    fetchImpl: options.fetchImpl,
    socketFactory: options.socketFactory,
    startedAt: new Date(Date.now() - 1_000),
    runId: `test-run:${checkId}`,
  });

describe("operational synthetic execution", () => {
  it("anchors persisted chronology to database time without changing measured duration", async () => {
    const run = await execute("landing-docs", {
      fetchImpl: (async () => new Response("ok")) as typeof fetch,
    });
    const authorityNow = new Date("2026-09-04T12:00:00.000Z");
    const anchored = anchorOperationalSyntheticRunToDatabaseTime({
      run,
      authorityNow,
    });

    expect(anchored.completedAt).toBe(authorityNow.toISOString());
    expect(Date.parse(anchored.startedAt)).toBe(
      authorityNow.getTime() - run.durationMilliseconds,
    );
    expect(anchored.durationMilliseconds).toBe(run.durationMilliseconds);
    expect(
      anchored.evidence.every(
        (item) => item.collectedAt === anchored.completedAt,
      ),
    ).toBe(true);
  });

  it("evaluates HTTP, JSON readiness, hosted HTML, and missing targets safely", async () => {
    const requestedUrls: string[] = [];
    const healthyFetch = async (input: string | URL | Request) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url.includes("/api/readiness")) {
        return Response.json({
          ok: true,
          boundaries: {
            database: { required: true, status: "ready" },
            optionalProvider: { required: false, status: "unconfigured" },
          },
        });
      }
      if (url.includes("/api/health")) {
        return Response.json({ ok: true });
      }
      if (url.includes("/health") || url.includes("/ready")) {
        return Response.json({ ok: true });
      }
      if (url.includes("release.example.test")) {
        return new Response(
          "<!doctype html><html><body>release</body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response("ok", { status: 200 });
    };

    await expect(
      execute("landing-docs", { fetchImpl: healthyFetch as typeof fetch }),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      execute("arcade-hosted-release", {
        fetchImpl: healthyFetch as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      execute("platform-realtime-health", {
        fetchImpl: healthyFetch as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      execute("release-dependencies", {
        fetchImpl: healthyFetch as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "passed" });
    expect(requestedUrls).toContain("https://platform.example.test/api/health");
    expect(requestedUrls).toContain(
      "https://platform.example.test/api/readiness",
    );

    const missingRelease = await execute("arcade-hosted-release", {
      runtimeConfig: {
        ...config,
        targets: { ...config.targets, "hosted.release": null },
      },
      fetchImpl: healthyFetch as typeof fetch,
    });
    expect(missingRelease).toMatchObject({ status: "error" });
    expect(missingRelease.observations[1]).toMatchObject({
      status: "error",
      failure: {
        code: "synthetic.target_unconfigured",
        details: { targetKey: "hosted.release" },
      },
    });
    expect(JSON.stringify(missingRelease)).not.toContain(
      "https://release.example.test",
    );
  });

  it("fails closed when a required release dependency is degraded", async () => {
    const run = await execute("release-dependencies", {
      fetchImpl: (async () =>
        Response.json({
          ok: true,
          boundaries: {
            database: { required: true, status: "degraded" },
          },
        })) as typeof fetch,
    });
    expect(run.status).toBe("failed");
    expect(run.observations[0]).toMatchObject({
      status: "failed",
      failure: {
        code: "synthetic.assertion_failed",
        details: {
          targetKey: "platform.readiness",
          assertion: "dependency_ready",
          httpStatus: 200,
        },
      },
    });
    expect(run.observations.slice(1)).toEqual([
      expect.objectContaining({
        stepId: "operational-worker",
        status: "passed",
      }),
      expect.objectContaining({
        stepId: "browser-worker",
        status: "passed",
      }),
    ]);
  });

  it("proves room/controller and semantic action protocol behavior", async () => {
    type Handler = (...args: unknown[]) => void;
    class SyntheticSocket {
      handlers = new Map<string, Handler[]>();
      disconnected = false;
      peer: SyntheticSocket | null = null;
      role: "host" | "controller";

      constructor(role: "host" | "controller") {
        this.role = role;
        queueMicrotask(() => this.trigger("connect"));
      }

      once(event: string, handler: Handler) {
        this.handlers.set(event, [handler]);
        return this;
      }

      emit(event: string, payload: Record<string, unknown>, ack?: Handler) {
        if (event === "host:bootstrap") ack?.({ ok: true });
        if (event === "host:createRoom") {
          ack?.({
            ok: true,
            roomId: "ROOM01",
            controllerCapability: { token: "opaque-test-capability" },
          });
        }
        if (event === "controller:join") ack?.({ ok: true });
        if (event === "host:state_sync") {
          this.peer?.trigger("airjam:state_sync", {
            data: payload.data,
            revision: payload.revision,
          });
        }
        if (event === "controller:action_rpc") {
          this.peer?.trigger(
            "airjam:action_rpc",
            payload,
            (result: Record<string, unknown>) => ack?.(result),
          );
        }
        return this;
      }

      disconnect() {
        this.disconnected = true;
        return this;
      }

      trigger(event: string, ...args: unknown[]) {
        const handlers = this.handlers.get(event) ?? [];
        this.handlers.delete(event);
        for (const handler of handlers) handler(...args);
      }
    }

    const sockets: SyntheticSocket[] = [];
    const socketFactory = (() => {
      const socket = new SyntheticSocket(
        sockets.length % 2 === 0 ? "host" : "controller",
      );
      sockets.push(socket);
      if (sockets.length % 2 === 0) {
        const host = sockets.at(-2)!;
        const controller = sockets.at(-1)!;
        host.peer = controller;
        controller.peer = host;
      }
      return socket as unknown as Socket;
    }) as typeof import("socket.io-client").io;

    await expect(
      execute("room-controller", { socketFactory }),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      execute("semantic-gameplay", { socketFactory }),
    ).resolves.toMatchObject({ status: "passed" });
    expect(sockets).toHaveLength(4);
    expect(sockets.every((socket) => socket.disconnected)).toBe(true);
  });
});
