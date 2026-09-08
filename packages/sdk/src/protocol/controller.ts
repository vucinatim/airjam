import { z } from "zod";
import type { RoomPlatformSettingsSnapshot } from "../settings/platform-settings";
import { roomCodeSchema, type RoomCode } from "./core";
import type { ErrorCode } from "./errors";

export const controllerInputSchema = z.object({
  roomId: roomCodeSchema,
  controllerId: z.string().min(3),
  input: z.record(z.string(), z.unknown()),
});

export type ControllerInputPayload = Record<string, unknown>;

export interface ControllerInputEvent {
  roomId: RoomCode;
  controllerId: string;
  input: ControllerInputPayload;
}

export const controllerOrientationSchema = z.enum(["portrait", "landscape"]);

export type ControllerOrientation = z.infer<typeof controllerOrientationSchema>;

export const controllerSourceSchema = z.enum(["phone", "preview", "virtual"]);

export type ControllerSource = z.infer<typeof controllerSourceSchema>;

export const PREVIEW_CONTROLLER_DEVICE_ID_PREFIX = "pd_";
export const VIRTUAL_CONTROLLER_DEVICE_ID_PREFIX = "aj-mcp-device-";

export const inferControllerSourceFromDeviceId = (
  deviceId: string | null | undefined,
): ControllerSource => {
  const normalized = deviceId?.trim();
  if (!normalized) {
    return "phone";
  }
  if (normalized.startsWith(PREVIEW_CONTROLLER_DEVICE_ID_PREFIX)) {
    return "preview";
  }
  if (normalized.startsWith(VIRTUAL_CONTROLLER_DEVICE_ID_PREFIX)) {
    return "virtual";
  }
  return "phone";
};

export const controllerStateSchema = z.object({
  roomId: roomCodeSchema,
  state: z.object({
    orientation: controllerOrientationSchema.optional(),
    message: z.string().optional(),
    roomSettings: z
      .object({
        audio: z.object({
          masterVolume: z.number().min(0).max(1),
          musicVolume: z.number().min(0).max(1),
          sfxVolume: z.number().min(0).max(1),
        }),
        previewControllers: z.object({
          activeOpacity: z.number().min(0).max(1),
        }),
      })
      .optional(),
    runtimeState: z.enum(["paused", "playing"]).optional(),
    stateVersion: z.number().int().nonnegative().optional(),
  }),
});

export type ControllerStateMessage = z.infer<typeof controllerStateSchema>;

export type ControllerStatePayload = z.infer<
  typeof controllerStateSchema
>["state"];
export type ControllerRoomSettingsState = RoomPlatformSettingsSnapshot;

export const controllerJoinSchema = z.object({
  roomId: roomCodeSchema,
  controllerId: z.string().min(3),
  /**
   * Stable local controller device identity used as a reconnect hint.
   * Older clients may omit this and fall back to controllerId-only behavior.
   */
  deviceId: z.string().min(8).max(128).optional(),
  nickname: z.string().trim().min(1).max(24).optional(),
  /** Preset avatar key (platform-defined); optional at join. */
  avatarId: z.string().trim().min(1).max(48).optional(),
  capabilityToken: z.string().min(1).optional(),
});

export type ControllerJoinPayload = z.infer<typeof controllerJoinSchema>;

export const controllerLeaveSchema = z.object({
  roomId: roomCodeSchema,
  controllerId: z.string().min(3),
});

export type ControllerLeavePayload = z.infer<typeof controllerLeaveSchema>;

export interface ControllerLeaveAck {
  ok: boolean;
  message?: string;
  code?: ErrorCode | string;
}

export const controllerSystemSchema = z.object({
  roomId: roomCodeSchema,
  command: z.enum(["exit", "pause", "resume"]),
});

export type ControllerSystemPayload = z.infer<typeof controllerSystemSchema>;

export interface PlayerProfile {
  id: string;
  label: string;
  color?: string;
  /** Preset avatar id chosen by the player (platform resolves to artwork). */
  avatarId?: string;
}

export const playerProfilePatchSchema = z
  .object({
    label: z.string().trim().min(1).max(24).optional(),
    avatarId: z.string().trim().min(1).max(48).optional(),
  })
  .strict();

export type PlayerProfilePatch = z.infer<typeof playerProfilePatchSchema>;

export const controllerUpdatePlayerProfileSchema = z
  .object({
    roomId: roomCodeSchema,
    controllerId: z.string().min(3),
    patch: playerProfilePatchSchema,
  })
  .refine(
    (data) =>
      data.patch.label !== undefined || data.patch.avatarId !== undefined,
    { message: "patch must include at least one field" },
  );

export type ControllerUpdatePlayerProfilePayload = z.infer<
  typeof controllerUpdatePlayerProfileSchema
>;

export interface ControllerUpdatePlayerProfileAck {
  ok: boolean;
  message?: string;
  player?: PlayerProfile;
  code?: ErrorCode | string;
}

export interface ControllerJoinAck {
  ok: boolean;
  controllerId?: string;
  roomId?: RoomCode;
  resumed?: boolean;
  message?: string;
  code?: ErrorCode | string;
  retryAfterSeconds?: number;
}

export const controllerPrivilegedGrantSchema = z.enum([
  "system",
  "play_sound",
  "action_rpc",
]);

export type ControllerPrivilegedGrant = z.infer<
  typeof controllerPrivilegedGrantSchema
>;

export const controllerPrivilegedCapabilitySchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
  grants: z.array(controllerPrivilegedGrantSchema).min(1),
});

export type ControllerPrivilegedCapability = z.infer<
  typeof controllerPrivilegedCapabilitySchema
>;

export interface ControllerSocketAuthority {
  roomId: RoomCode;
  controllerId: string;
  deviceId: string;
  joinedAt: number;
  privilegedGrants: ControllerPrivilegedGrant[];
}
