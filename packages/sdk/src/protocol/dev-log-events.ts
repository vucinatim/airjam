export type AirJamDevBrowserLogSource =
  | "console"
  | "window-error"
  | "unhandledrejection"
  | "diagnostic"
  | "runtime";

export type AirJamDevBrowserConsoleCategory =
  | "airjam"
  | "app"
  | "framework"
  | "browser";

const describeBrowserConsoleValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const matchesAnyPrefix = (value: string, prefixes: string[]): boolean => {
  return prefixes.some((prefix) => value.startsWith(prefix));
};

export const resolveAirJamBrowserConsoleCategory = (
  value: string | unknown[],
): AirJamDevBrowserConsoleCategory => {
  const message =
    typeof value === "string"
      ? value
      : value.map((entry) => describeBrowserConsoleValue(entry)).join(" ");
  const firstText =
    typeof value === "string"
      ? value
      : typeof value[0] === "string"
        ? value[0]
        : "";

  if (
    matchesAnyPrefix(message, [
      "[AirJam]",
      "[Arcade]",
      "[GamePlayer]",
      "[InputManager]",
      "[Arcade][AJ_",
    ]) ||
    matchesAnyPrefix(firstText, [
      "[AirJam]",
      "[Arcade]",
      "[GamePlayer]",
      "[InputManager]",
      "[Arcade][AJ_",
    ])
  ) {
    return "airjam";
  }

  if (
    matchesAnyPrefix(firstText, ["%c >> query", "%c << query"]) ||
    message.startsWith("[Fast Refresh]") ||
    message.includes("Download the React DevTools") ||
    message.includes("No routes matched location") ||
    message.startsWith("Warning:")
  ) {
    return "framework";
  }

  if (
    message.includes("Largest Contentful Paint") ||
    message.startsWith('Image with src "') ||
    message.includes("ResizeObserver loop")
  ) {
    return "browser";
  }

  return "app";
};

export const AIRJAM_DEV_LOG_EVENTS = {
  server: {
    started: "server.started",
    startupFailed: "server.startup.failed",
  },
  socket: {
    connected: "socket.connected",
    disconnected: "socket.disconnected",
  },
  auth: {
    modeDisabled: "auth.mode.disabled",
    modeMasterKey: "auth.mode.master_key",
    modeDatabaseAndHostGrant: "auth.mode.database_and_host_grant",
    modeDatabase: "auth.mode.database",
    backendMissing: "auth.backend.missing",
    appIdLastUsedAtUpdateFailed: "auth.app_id_last_used_at_update.failed",
    appIdVerificationDatabaseError: "auth.app_id_verification.database_error",
  },
  browser: {
    logSessionStarted: "browser.log_session.started",
    logBatchReceived: "browser.log_batch.received",
    console: "browser.console",
    windowError: "browser.window_error",
    unhandledRejection: "browser.unhandled_rejection",
    diagnostic: "browser.diagnostic",
    runtime: "browser.runtime",
  },
  runtime: {
    providerMounted: "runtime.provider.mounted",
    providerUnmounted: "runtime.provider.unmounted",
    windowBeforeUnload: "runtime.window.beforeunload",
    windowPageHide: "runtime.window.pagehide",
    socketConnected: "runtime.socket.connected",
    socketDisconnected: "runtime.socket.disconnected",
    socketConnectError: "runtime.socket.connect_error",
    hostCreateRoomRequested: "runtime.host.create_room.requested",
    hostReconnectRequested: "runtime.host.reconnect.requested",
    hostReconnectRetryScheduled: "runtime.host.reconnect.retry_scheduled",
    hostResetRoomRequested: "runtime.host.reset_room.requested",
    hostStateReceived: "runtime.host.state.received",
    controllerJoinRequested: "runtime.controller.join.requested",
    controllerStateReceived: "runtime.controller.state.received",
    phaseTransition: "runtime.phase.transition",
    stateVersionReceived: "runtime.state_version.received",
    invariantViolation: "runtime.invariant.violation",
    embeddedBridgeRequested: "runtime.embedded_bridge.requested",
    embeddedBridgeAttached: "runtime.embedded_bridge.attached",
    embeddedBridgeRejected: "runtime.embedded_bridge.rejected",
    embeddedBridgeClosed: "runtime.embedded_bridge.closed",
    browserLogSinkFailure: "runtime.browser_log_sink.failure",
  },
  host: {
    lifecycleRejected: "host.lifecycle.rejected",
    bootstrapVerified: "host.bootstrap.verified",
    bootstrapRejected: "host.bootstrap.rejected",
    disconnectPendingRoomClose: "host.disconnect.pending_room_close",
    disconnectRoomClosed: "host.disconnect.room_closed",
    registerSystemAccepted: "host.register_system.accepted",
    registerSystemRejected: "host.register_system.rejected",
    createRoomAccepted: "host.create_room.accepted",
    createRoomRejected: "host.create_room.rejected",
    reconnectAccepted: "host.reconnect.accepted",
    reconnectRejected: "host.reconnect.rejected",
    resetRoomAccepted: "host.reset_room.accepted",
    resetRoomRejected: "host.reset_room.rejected",
    systemAccepted: "host.system.accepted",
    systemRejected: "host.system.rejected",
    stateRejected: "host.state.rejected",
    signalRejected: "host.signal.rejected",
    playSoundRejected: "host.play_sound.rejected",
    stateBroadcastSummary: "host.state_broadcast.summary",
    reconnectStateReconcile: "host.reconnect.state_reconcile",
    stateSyncSummary: "host.state_sync.summary",
    stateSyncRejected: "host.state_sync.rejected",
  },
  controller: {
    joinAccepted: "controller.join.accepted",
    joinRejected: "controller.join.rejected",
    resumeAccepted: "controller.resume.accepted",
    disconnectPendingResume: "controller.disconnect.pending_resume",
    disconnectLeaseExpired: "controller.disconnect.lease_expired",
    disconnectApplied: "controller.disconnect.applied",
    profileUpdateAccepted: "controller.profile_update.accepted",
    profileUpdateRejected: "controller.profile_update.rejected",
    leaveAccepted: "controller.leave.accepted",
    leaveRejected: "controller.leave.rejected",
    inputSummary: "controller.input.summary",
    inputDroppedSummary: "controller.input_dropped.summary",
    inputRejected: "controller.input.rejected",
    systemAccepted: "controller.system.accepted",
    systemRejected: "controller.system.rejected",
    playSoundRejected: "controller.play_sound.rejected",
    actionRpcSummary: "controller.action_rpc.summary",
    actionRpcRejected: "controller.action_rpc.rejected",
  },
  system: {
    launchGameAccepted: "system.launch_game.accepted",
    launchGameRejected: "system.launch_game.rejected",
    closeGameAccepted: "system.close_game.accepted",
    closeGameRejected: "system.close_game.rejected",
  },
  childHost: {
    joinAccepted: "child_host.join.accepted",
    joinRejected: "child_host.join.rejected",
    disconnectPendingSystemFocus: "child_host.disconnect.pending_system_focus",
    disconnectSystemFocusRestored:
      "child_host.disconnect.system_focus_restored",
  },
  embeddedGame: {
    activateAccepted: "embedded_game.activate.accepted",
    activateRejected: "embedded_game.activate.rejected",
  },
} as const;

type ValueOf<T> = T[keyof T];

export type AirJamDevLogEventName = ValueOf<{
  [Group in keyof typeof AIRJAM_DEV_LOG_EVENTS]: ValueOf<
    (typeof AIRJAM_DEV_LOG_EVENTS)[Group]
  >;
}>;

const AIRJAM_BROWSER_LOG_EVENT_BY_SOURCE = {
  console: AIRJAM_DEV_LOG_EVENTS.browser.console,
  "window-error": AIRJAM_DEV_LOG_EVENTS.browser.windowError,
  unhandledrejection: AIRJAM_DEV_LOG_EVENTS.browser.unhandledRejection,
  diagnostic: AIRJAM_DEV_LOG_EVENTS.browser.diagnostic,
  runtime: AIRJAM_DEV_LOG_EVENTS.browser.runtime,
} as const satisfies Record<AirJamDevBrowserLogSource, AirJamDevLogEventName>;

export const resolveAirJamBrowserLogEvent = (
  source: AirJamDevBrowserLogSource,
): AirJamDevLogEventName => AIRJAM_BROWSER_LOG_EVENT_BY_SOURCE[source];
