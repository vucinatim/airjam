export const DEFAULT_AIR_JAM_SERVER_PORT: number;

export function resolveLocalBackendOrigin(
  env?: {
    AIR_JAM_SERVER_PORT?: string | number;
    VITE_AIR_JAM_SERVER_URL?: string;
  },
): string;
