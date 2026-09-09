export const DEFAULT_AIR_JAM_SERVER_PORT = 4000;

export const resolveLocalBackendOrigin = (env = {}) => {
  const explicitOrigin = env.VITE_AIR_JAM_SERVER_URL?.trim();
  return (
    explicitOrigin ||
    `http://127.0.0.1:${env.AIR_JAM_SERVER_PORT ?? DEFAULT_AIR_JAM_SERVER_PORT}`
  );
};
