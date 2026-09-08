import type { RoomPlatformSettingsSnapshot } from "@air-jam/sdk";
import type {
  AirJamStateSyncPayload,
  ChildHostCapability,
  ControllerPrivilegedCapability,
  ControllerPrivilegedGrant,
  ControllerSource,
  ControllerStateMessage,
  HostResumeCapability,
  HostSessionKind,
  PlayerProfile,
  RoomCode,
  RuntimeState,
} from "@air-jam/sdk/protocol";
import type {
  RealtimeControllerLease,
  RealtimeRoomLease,
} from "./services/realtime-admission-service.js";

type ControllerOrientation = NonNullable<
  ControllerStateMessage["state"]["orientation"]
>;

/**
 * Controller session information
 */
export interface ControllerSession {
  controllerId: string;
  deviceId: string;
  nickname?: string;
  socketId?: string;
  connected: boolean;
  resumeLeaseExpiresAt: number | null;
  pendingDisconnectTimer?: ReturnType<typeof setTimeout>;
  retiredAt?: number;
  playerProfile: PlayerProfile;
  privilegedGrants: ControllerPrivilegedGrant[];
  source: ControllerSource;
  admissionLease: RealtimeControllerLease;
}

export interface RoomAnalyticsState {
  runtimeSessionId: string;
  startedAt: number;
  appId?: string;
  gameId?: string;
  hostVerifiedVia?: "appId" | "hostGrant";
  hostVerifiedOrigin?: string;
  hostSessionKind: HostSessionKind;
}

/**
 * Room focus state - determines which host receives inputs
 */
export type RoomFocus = "SYSTEM" | "GAME";

/**
 * Explicit room lifecycle state
 */
export type RoomLifecycleState =
  | "SYSTEM_IDLE"
  | "GAME_LAUNCH_PENDING"
  | "GAME_ACTIVE"
  | "CLOSING"
  | "TEARDOWN";

/**
 * Room session state
 */
export interface RoomSession {
  roomId: RoomCode;
  masterHostSocketId: string; // Primary host socket for the room
  hostResumeCapability: HostResumeCapability; // Bearer capability required to reclaim master ownership
  childHostSocketId?: string; // Secondary game host socket when launched from a system shell
  analytics: RoomAnalyticsState;
  focus: RoomFocus;
  launchCapability?: ChildHostCapability; // Capability required for a child host to join
  controllerCapability?: ControllerPrivilegedCapability; // Capability required for privileged controller channels
  /** Set when a game is launched from the system host (`system:launchGame`). */
  activeGameId?: string;
  controllers: Map<string, ControllerSession>;
  replicatedStoreSnapshots: Map<string, AirJamStateSyncPayload>;
  maxPlayers: number;
  runtimeState: RuntimeState;
  stateVersion: number;
  controllerOrientation: ControllerOrientation;
  roomSettings: RoomPlatformSettingsSnapshot;
  lifecycleState: RoomLifecycleState;
  admissionLease: RealtimeRoomLease;
  /** Deferred teardown when child host socket drops (Socket.IO reconnect grace). */
  pendingChildTeardownTimer?: ReturnType<typeof setTimeout>;
  /** Deferred teardown when the master host socket drops. */
  pendingRoomCloseTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Index entry for controller tracking
 */
export interface ControllerIndexEntry {
  roomId: RoomCode;
  controllerId: string;
}
