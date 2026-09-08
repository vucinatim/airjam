import type { AirJamActionInvocationResult } from "@air-jam/sdk";
import type {
  PlatformMachineCreateOwnedGameInput,
  PlatformMachineCreateOwnedGameResult,
  PlatformMachineFinalizeReleaseUploadResult,
  PlatformMachineGetOwnedGameMediaResult,
  PlatformMachineGetOwnedGameResult,
  PlatformMachineGetReleaseResult,
  PlatformMachineListOwnedGamesResult,
  PlatformMachineListReleasesResult,
  PlatformMachineMutateOwnedGameMediaAssetResult,
  PlatformMachinePublishReleaseResult,
  PlatformMachineReleaseGeneration,
  PlatformMachineReleaseJob,
  PlatformMachineRequestOwnedGameMediaUploadTargetInput,
  PlatformMachineRequestOwnedGameMediaUploadTargetResult,
  PlatformMachineRequestReleaseGenerationExportResult,
  PlatformMachineRequestReleaseUploadTargetResult,
  PlatformMachineUpdateOwnedGameInput,
  PlatformMachineUpdateOwnedGameResult,
} from "@air-jam/sdk/platform-machine";

export type AirJamProjectMode = "monorepo" | "standalone-game" | "unknown";

export type JsonObject = Record<string, unknown>;

export type PackageJson = JsonObject & {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type AirJamPackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export type AirJamProjectContext = {
  rootDir: string;
  mode: AirJamProjectMode;
  packageManager: AirJamPackageManager;
  packageJsonPath: string | null;
  packageJson: PackageJson | null;
  workspaceRoot: string | null;
  reasons: string[];
};

export type AirJamCapabilityGroup =
  | "project"
  | "games"
  | "logs"
  | "runtime"
  | "quality"
  | "repo-workspace"
  | "ai-pack";

export type AirJamProjectInspection = {
  context: AirJamProjectContext;
  capabilities: AirJamCapabilityGroup[];
  scripts: Record<string, string>;
  airJamPackages: Record<string, string>;
  files: {
    agents: string | null;
    plan: string | null;
    suggestions: string | null;
    docsIndex: string | null;
  };
};

export type AirJamGameSummary = {
  id: string;
  name: string;
  rootDir: string;
  packageName: string | null;
  description: string | null;
  category: string | null;
  scaffold: boolean | null;
  manifestPath: string | null;
  configPath: string | null;
};

export type AirJamGameInspection = AirJamGameSummary & {
  packageJsonPath: string | null;
  scripts: Record<string, string>;
  metadataExportLikely: boolean;
  controllerPathLikely: string | null;
  qualityGates: AirJamQualityGate[];
};

export type AirJamLocalHostedGameDefaults = {
  projectDir: string;
  configPath: string | null;
  manifestPath: string | null;
  packageJsonPath: string | null;
  packageName: string | null;
  sourceUrl: string | null;
  metadata: {
    name: string | null;
    slug: string | null;
    description: string | null;
    category: string | null;
    tags: string[];
  };
  template: {
    id: string | null;
    name: string | null;
    description: string | null;
    category: string | null;
  };
};

export type AirJamQualityGate =
  | "typecheck"
  | "lint"
  | "test"
  | "build"
  | "format-check"
  | "scaffold-smoke"
  | "release-check";

export type AirJamLocalReleaseIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  path: string | null;
};

export type InspectLocalReleaseOptions = {
  cwd?: string;
  distDir?: string;
};

export type AirJamLocalReleaseDoctor = {
  projectDir: string;
  packageJsonPath: string | null;
  packageName: string | null;
  packageVersion: string | null;
  packageManager: AirJamPackageManager;
  configPath: string | null;
  buildScript: string | null;
  metadataExportLikely: boolean;
  controllerPath: string | null;
  distDir: string;
  distExists: boolean;
  distEntryExists: boolean;
  recommendedBundlePath: string;
  canBundle: boolean;
  issues: AirJamLocalReleaseIssue[];
  hostedContract: {
    entryPath: string;
    manifestPath: string;
    hostPath: string;
    controllerPath: string;
  };
};

export type ValidateLocalReleaseOptions = {
  cwd?: string;
  distDir?: string;
  bundlePath?: string;
  skipBuild?: boolean;
};

export type AirJamLocalReleaseValidation = {
  source:
    | {
        kind: "project";
        projectDir: string;
        distDir: string;
        bundlePath: null;
      }
    | {
        kind: "bundle";
        projectDir: null;
        distDir: null;
        bundlePath: string;
      };
  ok: boolean;
  issues: AirJamLocalReleaseIssue[];
  manifest: JsonObject | null;
  entryPath: string | null;
  wrapperDirectory: string | null;
  fileCount: number;
  extractedSizeBytes: number;
};

export type BundleLocalReleaseOptions = {
  cwd?: string;
  distDir?: string;
  out?: string;
  skipBuild?: boolean;
};

export type BundleLocalReleaseResult = {
  projectDir: string;
  distDir: string;
  outputFile: string;
  built: boolean;
  buildResult: CommandResult | null;
  validation: AirJamLocalReleaseValidation;
};

export type ListPlatformReleaseTargetsOptions = {
  platformUrl?: string;
  token?: string;
};

export type ListPlatformGamesOptions = {
  platformUrl?: string;
  token?: string;
};

export type InspectPlatformGameOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
};

export type CreatePlatformGameOptions = {
  platformUrl?: string;
  token?: string;
  input: PlatformMachineCreateOwnedGameInput;
};

export type UpdatePlatformGameOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
  input: PlatformMachineUpdateOwnedGameInput;
};

export type InspectPlatformGameMediaOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
};

export type RequestPlatformGameMediaUploadTargetOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
  input: PlatformMachineRequestOwnedGameMediaUploadTargetInput;
};

export type MutatePlatformGameMediaAssetOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
  assetId: string;
};

export type UploadPlatformGameMediaFileOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
  kind: "thumbnail" | "cover" | "preview_video";
  filePath: string;
};

export type ListPlatformReleasesOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
};

export type InspectPlatformReleaseOptions = {
  platformUrl?: string;
  token?: string;
  releaseId: string;
};

export type PublishPlatformReleaseOptions = {
  platformUrl?: string;
  token?: string;
  releaseId: string;
};

export type UploadPlatformReleaseGenerationOptions = {
  platformUrl?: string;
  token?: string;
  releaseId: string;
  cwd?: string;
  bundlePath: string;
};

export type FinalizePlatformReleaseGenerationOptions = {
  platformUrl?: string;
  token?: string;
  releaseId: string;
  generationId: string;
};

export type ExportPlatformReleaseGenerationOptions = {
  platformUrl?: string;
  token?: string;
  releaseId: string;
  generationId: string;
  cwd?: string;
  out?: string;
};

export type ExportPlatformReleaseGenerationResult =
  PlatformMachineRequestReleaseGenerationExportResult & {
    outputFile: string;
    sizeBytes: number;
  };

export type SubmitPlatformReleaseOptions = {
  platformUrl?: string;
  token?: string;
  slugOrId: string;
  versionLabel?: string;
  cwd?: string;
  distDir?: string;
  bundlePath?: string;
  skipBuild?: boolean;
  waitForProcessing?: boolean;
  processingTimeoutMs?: number;
  processingPollIntervalMs?: number;
  publish?: boolean;
};

export type ListPlatformReleaseTargetsResult =
  PlatformMachineListOwnedGamesResult;

export type InspectPlatformGameMediaResult =
  PlatformMachineGetOwnedGameMediaResult;

export type RequestPlatformGameMediaUploadTargetResult =
  PlatformMachineRequestOwnedGameMediaUploadTargetResult;

export type MutatePlatformGameMediaAssetResult =
  PlatformMachineMutateOwnedGameMediaAssetResult;

export type ListPlatformReleasesResult = PlatformMachineListReleasesResult;

export type InspectPlatformReleaseResult = PlatformMachineGetReleaseResult;

export type PublishPlatformReleaseResult = PlatformMachinePublishReleaseResult;

export type UploadPlatformReleaseGenerationResult =
  PlatformMachineRequestReleaseUploadTargetResult & {
    bundlePath: string;
  };

export type FinalizePlatformReleaseGenerationResult =
  PlatformMachineFinalizeReleaseUploadResult;

export type ListPlatformGamesResult = PlatformMachineListOwnedGamesResult;

export type InspectPlatformGameResult = PlatformMachineGetOwnedGameResult;

export type CreatePlatformGameResult = PlatformMachineCreateOwnedGameResult;

export type UpdatePlatformGameResult = PlatformMachineUpdateOwnedGameResult;

export type SubmitPlatformReleaseResult = {
  bundlePath: string;
  createdRelease: PlatformMachineGetReleaseResult["release"];
  createdGeneration: PlatformMachineReleaseGeneration;
  submittedRelease: PlatformMachineGetReleaseResult["release"];
  submittedGeneration: PlatformMachineReleaseGeneration;
  processingJob: PlatformMachineReleaseJob;
  processedRelease: PlatformMachineGetReleaseResult["release"] | null;
  publishedRelease: PlatformMachineGetReleaseResult["release"] | null;
};

export type AirJamPlatformAuthStatus = {
  authenticated: boolean;
  storagePath: string;
  platformBaseUrl: string | null;
  clientName: string | null;
  storedAt: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    role: "creator" | "ops_admin";
  } | null;
  session: {
    id: string;
    expiresAt: string;
    createdAt: string;
    userAgent: string;
  } | null;
};

export type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  ok: boolean;
};

export type ReadDevLogsOptions = {
  cwd?: string;
  view?: "signal" | "full" | string;
  source?: string;
  trace?: string;
  room?: string;
  controller?: string;
  event?: string;
  process?: string;
  level?: string;
  runtime?: string;
  epoch?: number;
  consoleCategory?: string;
  file?: string;
  tail?: number;
};

export type RunQualityGateOptions = {
  cwd?: string;
  gate: AirJamQualityGate;
  packageFilter?: string;
};

export type RunCompleteEvaluationOptions = {
  cwd?: string;
};

export type AirJamCompleteEvaluationResult = {
  contract: "air-jam-complete-evaluation/v1";
  status: "passed" | "failed";
  startedAt: string;
  endedAt: string;
  gates: Array<{
    gate: AirJamQualityGate;
    result: CommandResult;
  }>;
};

export type AirJamDevMode = "standalone-dev" | "arcade-dev" | "arcade-test";

export type AirJamVisualArtifactMode = "standalone-dev" | "arcade-built";

export type AirJamVisualCaptureMode = "standalone-dev" | "arcade-test";

export type AirJamManagedDevProcess = {
  id: string;
  pid: number;
  cwd: string;
  projectMode: Exclude<AirJamProjectMode, "unknown">;
  mode: AirJamDevMode;
  topologyMode: "standalone-dev" | "arcade-live" | "arcade-built";
  secure: boolean;
  gameId: string | null;
  command: string;
  args: string[];
  logPath: string;
  expectedLogPath: string | null;
  startedAt: string;
};

export type AirJamSurfaceUrlSummary = {
  appOrigin: string | null;
  hostUrl: string | null;
  controllerBaseUrl: string | null;
  publicHost: string | null;
  localBuildUrl: string | null;
  browserBuildUrl: string | null;
};

export type AirJamRuntimeTopology = {
  projectMode: Exclude<AirJamProjectMode, "unknown">;
  mode: AirJamDevMode;
  topologyMode: "standalone-dev" | "arcade-live" | "arcade-built";
  gameId: string | null;
  secure: boolean;
  surfaces: Record<string, JsonObject>;
  urls: AirJamSurfaceUrlSummary;
  process: AirJamManagedDevProcess | null;
};

export type StartDevOptions = {
  cwd?: string;
  gameId?: string;
  mode?: AirJamDevMode;
  secure?: boolean;
};

export type StartDevResult = {
  process: AirJamManagedDevProcess;
  reusedExistingProcess: boolean;
  topology: AirJamRuntimeTopology;
};

export type StopDevOptions = {
  cwd?: string;
  processId?: string;
  mode?: AirJamDevMode;
};

export type StopDevResult = {
  stopped: AirJamManagedDevProcess[];
};

export type AirJamUnmanagedDevProcess = {
  pid: number;
  ports: number[];
  command: string | null;
  startedAt: string | null;
  ageMs: number | null;
  managed: false;
};

export type GetDevStatusOptions = {
  cwd?: string;
};

export type AirJamDevStatus = {
  processes: AirJamManagedDevProcess[];
  unmanagedProcesses: AirJamUnmanagedDevProcess[];
  knownPorts: number[];
};

export type ResetLocalDevOptions = {
  cwd?: string;
};

export type ResetLocalDevResult = {
  stoppedManaged: AirJamManagedDevProcess[];
  stoppedUnmanaged: AirJamUnmanagedDevProcess[];
  remainingUnmanaged: AirJamUnmanagedDevProcess[];
  knownPorts: number[];
};

export type GetTopologyOptions = {
  cwd?: string;
  gameId?: string;
  mode?: AirJamDevMode;
  secure?: boolean;
};

export type AirJamVisualScenarioSummary = {
  gameId: string;
  scenarioId: string;
  description: string | null;
  supportedModes: AirJamVisualCaptureMode[];
};

export type AirJamGameAgentActionDescriptor = {
  actionId: string;
  target: {
    kind: "participant" | "host";
    actionName: string;
    storeDomain: string;
  };
  description: string | null;
  availability: string | null;
  payload: {
    kind: "none" | "boolean" | "number" | "string" | "enum" | "json";
    description: string | null;
    allowedValues?: string[];
  };
  resultDescription: string | null;
};

export type AirJamAgentContractInspection = {
  gameId: string;
  rootDir: string;
  hasContract: boolean;
  snapshotStoreDomains: string[];
  snapshotDescription: string | null;
  actions: AirJamGameAgentActionDescriptor[];
};

export type InspectGameAgentContractOptions = {
  cwd?: string;
  gameId?: string;
};

export type ReadGameSnapshotOptions = {
  controllerSessionId: string;
  requestSync?: boolean;
  timeoutMs?: number;
};

export type AirJamGameSnapshotInspection = {
  controllerSessionId: string;
  gameId: string;
  /** Logical store names declared by the game contract. */
  snapshotStoreDomains: string[];
  /** Concrete replicated store domains used by the active runtime. */
  runtimeStoreDomains: string[];
  storeDomainBindings: Array<{
    contractStoreDomain: string;
    runtimeStoreDomain: string;
  }>;
  snapshotDescription: string | null;
  actions: AirJamGameAgentActionDescriptor[];
  snapshot: JsonObject;
  rawStores: AirJamRuntimeStoreSnapshot[];
};

export type InvokeGameActionOptions = {
  controllerSessionId: string;
  actionId: string;
  payload?: unknown;
  timeoutMs?: number;
};

export type AirJamGameActionAcknowledgementObservation =
  | "host-acknowledged"
  | "host-acknowledgement-not-observed";

export type AirJamGameActionOutcome =
  | "accepted"
  | "rejected"
  | "acknowledgement-not-observed-state-changed"
  | "acknowledgement-not-observed-no-state-change-observed";

export type InvokeGameActionResult = AirJamVirtualControllerSessionSummary & {
  actionId: string;
  lane: "player" | "host";
  actionName: string;
  storeDomain: string;
  payload?: unknown;
  sentAt: string;
  acknowledgement: AirJamActionInvocationResult;
  acknowledgementObservation: AirJamGameActionAcknowledgementObservation;
  outcome: AirJamGameActionOutcome;
  snapshotBefore: AirJamGameSnapshotInspection;
  snapshotAfter: AirJamGameSnapshotInspection;
  snapshotAfterStatus:
    | "committed-update-observed"
    | "no-new-commit-before-timeout";
  observedStateChange: boolean;
};

export type AirJamGameSessionActionDescriptor = {
  actionId: string;
  lane: "player" | "host";
  source: "semantic-game";
  description: string | null;
  availability: string | null;
  payload: {
    kind: "none" | "boolean" | "number" | "string" | "enum" | "json";
    description: string | null;
    allowedValues?: string[];
  };
  resultDescription: string | null;
};

export type AirJamVisualScenarioList = {
  gameId: string;
  scenarioModulePath: string | null;
  scenarios: AirJamVisualScenarioSummary[];
};

export type ListVisualScenariosOptions = {
  cwd?: string;
  gameId?: string;
};

export type CaptureVisualsOptions = {
  cwd?: string;
  gameId?: string;
  scenarioId?: string;
  mode?: AirJamVisualCaptureMode;
  secure?: boolean;
};

export type AirJamVisualScenarioMetadata = {
  gameId: string;
  scenarioId: string;
  scenarioDescription: string | null;
  runtimeMode: AirJamVisualArtifactMode;
  capturedAt: string;
  status: "captured" | "failed";
  urls: JsonObject;
  screenshots: Array<{
    surface: "host" | "controller";
    viewportName: string;
    width: number;
    height: number;
    fileName: string;
    relativePath: string;
  }>;
  notes: string[];
  error: {
    message: string;
    stack: string | null;
  } | null;
};

export type CaptureVisualsResult = {
  gameId: string;
  artifactRoot: string;
  summaryPath: string;
  summary: AirJamVisualCaptureSummary;
  scenarios: AirJamVisualScenarioMetadata[];
};

export type ConnectControllerOptions = {
  cwd?: string;
  gameId?: string;
  mode?: AirJamDevMode;
  secure?: boolean;
  roomId?: string;
  controllerJoinUrl?: string;
  controllerId?: string;
  deviceId?: string;
  nickname?: string;
  avatarId?: string;
  capabilityToken?: string;
  timeoutMs?: number;
};

export type SendControllerInputOptions = {
  controllerSessionId: string;
  input: JsonObject;
};

export type InvokeControllerActionOptions = {
  controllerSessionId: string;
  actionName: string;
  storeDomain: string;
  payload?: JsonObject;
};

export type DisconnectControllerOptions = {
  controllerSessionId: string;
};

export type ReadRuntimeSnapshotOptions = {
  controllerSessionId: string;
  storeDomains?: string[];
  requestSync?: boolean;
  timeoutMs?: number;
};

export type AirJamRuntimeStoreSnapshot = {
  storeDomain: string;
  data: JsonObject;
  updatedAt: string;
  revision: number;
};

export type AirJamVirtualControllerSessionSummary = {
  controllerSessionId: string;
  gameId: string | null;
  projectMode: AirJamProjectMode;
  mode: AirJamDevMode | null;
  topologyMode: "standalone-dev" | "arcade-live" | "arcade-built" | null;
  secure: boolean;
  process: AirJamManagedDevProcess | null;
  roomId: string;
  controllerId: string;
  deviceId: string;
  controllerJoinUrl: string;
  socketOrigin: string;
  connected: boolean;
  connectedAt: string;
  disconnectedAt: string | null;
  disconnectReason: string | null;
};

export type AirJamVirtualControllerSession =
  AirJamVirtualControllerSessionSummary & {
    welcome: JsonObject | null;
    controllerState: JsonObject | null;
    players: JsonObject[];
    storeSnapshots: AirJamRuntimeStoreSnapshot[];
    lastSignal: JsonObject | null;
    lastError: JsonObject | null;
    requestedStoreDomains: string[];
    missingStoreDomains: string[];
  };

export type SendControllerInputResult =
  AirJamVirtualControllerSessionSummary & {
    input: JsonObject;
    sentAt: string;
  };

export type InvokeControllerActionResult =
  AirJamVirtualControllerSessionSummary & {
    actionName: string;
    storeDomain: string;
    payload?: JsonObject;
    sentAt: string;
    acknowledgement: AirJamActionInvocationResult;
  };

export type DisconnectControllerResult = {
  disconnected: boolean;
  session: AirJamVirtualControllerSessionSummary;
};

export type AirJamRuntimeSnapshotInspection = AirJamVirtualControllerSession;

export type OpenGameSessionOptions = ConnectControllerOptions;

export type ReadGameSessionOptions = {
  gameSessionId: string;
  requestSync?: boolean;
  timeoutMs?: number;
};

export type SendGameSessionInputOptions = {
  gameSessionId: string;
  input: JsonObject;
};

export type InvokeGameSessionActionOptions = {
  gameSessionId: string;
  actionId: string;
  payload?: unknown;
  timeoutMs?: number;
};

export type CloseGameSessionOptions = {
  gameSessionId: string;
};

export type AirJamGameSessionSummary = {
  gameSessionId: string;
  cwd: string;
  gameId: string | null;
  controllerSessionId: string;
  projectMode: AirJamProjectMode;
  mode: AirJamDevMode | null;
  topologyMode: "standalone-dev" | "arcade-live" | "arcade-built" | null;
  secure: boolean;
  process: AirJamManagedDevProcess | null;
  roomId: string;
  controllerId: string;
  deviceId: string;
  controllerJoinUrl: string;
  socketOrigin: string;
  connected: boolean;
  connectedAt: string;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  hasAgentContract: boolean;
  actions: AirJamGameSessionActionDescriptor[];
};

export type AirJamGameSessionInspection = AirJamGameSessionSummary & {
  runtimeSnapshot: AirJamRuntimeSnapshotInspection;
  gameSnapshot: AirJamGameSnapshotInspection | null;
};

export type SendGameSessionInputResult = AirJamGameSessionSummary & {
  input: JsonObject;
  sentAt: string;
};

export type InvokeGameSessionActionResult = AirJamGameSessionSummary & {
  actionId: string;
  lane: "player" | "host";
  invocation: InvokeGameActionResult;
};

export type CloseGameSessionResult = {
  closed: boolean;
  session: AirJamGameSessionSummary;
};

export type AirJamVisualCaptureSummary = {
  gameId: string;
  mode: AirJamVisualArtifactMode;
  secure: boolean;
  capturedAt: string;
  scenarios: Array<{
    scenarioId: string;
    status: "captured" | "failed";
    screenshotCount: number;
    relativeDir: string;
  }>;
};

export type AirJamVisualCaptureInspection = {
  gameId: string;
  summaryPath: string;
  summary: AirJamVisualCaptureSummary;
};

export type AirJamPlatformMachineSessionStore = {
  version: 1;
  platformBaseUrl: string;
  clientName: string | null;
  storedAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: "creator" | "ops_admin";
  };
  session: {
    id: string;
    token: string;
    expiresAt: string;
    createdAt: string;
    userAgent: string;
  };
};

export type StartPlatformDeviceAuthorizationOptions = {
  platformUrl?: string;
  clientName?: string;
};

export type PollPlatformDeviceAuthorizationOptions = {
  platformUrl?: string;
  deviceCode: string;
};

export type LoginPlatformWithDeviceFlowOptions = {
  platformUrl?: string;
  clientName?: string;
  onPrompt?: (payload: {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    verificationUriComplete: string;
    expiresAt: string;
    intervalSeconds: number;
  }) => void | Promise<void>;
};

export type GetPlatformMachineProfileOptions = {
  platformUrl?: string;
  token?: string;
};

export type LogoutPlatformMachineSessionOptions = {
  platformUrl?: string;
  token?: string;
};
