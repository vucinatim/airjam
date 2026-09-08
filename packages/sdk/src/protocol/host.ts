import { z } from "zod";
import type {
  ControllerPrivilegedCapability,
  PlayerProfile,
} from "./controller";
import { roomCodeSchema, type RoomCode } from "./core";
import type { ErrorCode } from "./errors";
import type { ControllerPresenceNotice } from "./notices";

export const hostSessionKindSchema = z.enum(["game", "system"]);
export type HostSessionKind = z.infer<typeof hostSessionKindSchema>;

export const childHostCapabilitySchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export type ChildHostCapability = z.infer<typeof childHostCapabilitySchema>;

export const hostResumeCapabilitySchema = z.object({
  token: z.string().min(1),
});

export type HostResumeCapability = z.infer<typeof hostResumeCapabilitySchema>;

export interface HostArcadeSurfaceCheckpoint {
  /** Last Arcade surface epoch accepted by the room before this reconnect. */
  epoch: number;
  /** Last replicated Arcade surface revision accepted by the room. */
  revision: number;
}

/**
 * Active arcade game session as seen by the server (launch capability + catalog id).
 * Returned on host reconnect so the platform can restore iframe + replicated surface after refresh.
 */
export interface HostArcadeSessionSnapshot {
  gameId: string;
  launchCapability: ChildHostCapability;
}

export interface HostRegistrationAck {
  ok: boolean;
  roomId?: RoomCode;
  message?: string;
  code?: ErrorCode | string;
  retryAfterSeconds?: number;
  /** When reconnecting, present if the room still has a launched game (launch pending or active). */
  arcadeSession?: HostArcadeSessionSnapshot;
  /** Last observed Arcade counters, used to keep a reconnect monotonic. */
  arcadeSurfaceCheckpoint?: HostArcadeSurfaceCheckpoint;
  /** Authoritative controller roster snapshot for the connected room. */
  players?: PlayerProfile[];
  /** Authoritative controller-session roster for the connected room. */
  controllers?: ControllerPresenceNotice[];
  /** Official Air Jam controller capability bundle for privileged controller channels. */
  controllerCapability?: ControllerPrivilegedCapability;
  /** Bearer capability required to reclaim this room after the master socket disconnects. */
  hostResumeCapability?: HostResumeCapability;
}

export interface HostBootstrapAck {
  ok: boolean;
  message?: string;
  code?: ErrorCode | string;
  traceId?: string;
}

export interface HostSocketAuthority {
  appId?: string;
  gameId?: string;
  creatorId?: string;
  traceId: string;
  verifiedAt: number;
  verifiedVia?: "appId" | "hostGrant";
  verifiedOrigin?: string;
  hostSessionKind: HostSessionKind;
}

export const hostBootstrapSchema = z.object({
  appId: z.string().optional(),
  hostGrant: z.string().min(1).optional(),
  hostSessionKind: hostSessionKindSchema.default("system"),
});

export type HostBootstrapPayload = z.infer<typeof hostBootstrapSchema>;

export const hostRegisterSystemSchema = z.object({
  roomId: roomCodeSchema,
});

export type HostRegisterSystemPayload = z.infer<
  typeof hostRegisterSystemSchema
>;

export const systemLaunchGameSchema = z.object({
  roomId: roomCodeSchema,
  gameId: z.string(),
});

export type SystemLaunchGamePayload = z.infer<typeof systemLaunchGameSchema>;

export const hostJoinAsChildSchema = z.object({
  roomId: roomCodeSchema,
  capabilityToken: z.string().min(1),
});

export type HostJoinAsChildPayload = z.infer<typeof hostJoinAsChildSchema>;

export const hostActivateEmbeddedGameSchema = z.object({
  roomId: roomCodeSchema,
  capabilityToken: z.string().min(1),
});

export type HostActivateEmbeddedGamePayload = z.infer<
  typeof hostActivateEmbeddedGameSchema
>;

export const hostCreateRoomSchema = z.object({
  maxPlayers: z.number().int().min(1).max(16).default(8),
});

export type HostCreateRoomPayload = z.infer<typeof hostCreateRoomSchema>;

export const hostReconnectSchema = z.object({
  roomId: roomCodeSchema,
  resumeCapabilityToken: z.string().min(1),
});

export type HostReconnectPayload = z.infer<typeof hostReconnectSchema>;

export const hostResetRoomSchema = z.object({
  roomId: roomCodeSchema,
});

export type HostResetRoomPayload = z.infer<typeof hostResetRoomSchema>;

export const hostRemoveControllerSchema = z.object({
  roomId: roomCodeSchema,
  controllerId: z.string().min(3),
});

export type HostRemoveControllerPayload = z.infer<
  typeof hostRemoveControllerSchema
>;

export interface HostControllerActionAck {
  ok: boolean;
  message?: string;
  code?: ErrorCode | string;
}

export interface SystemLaunchGameAck {
  ok: boolean;
  launchCapability?: ChildHostCapability;
  message?: string;
  code?: ErrorCode | string;
}
