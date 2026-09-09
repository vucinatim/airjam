import { runCommandResult } from "./commands.js";
import { detectProjectContext } from "./context.js";
import type {
  AirJamCompleteEvaluationResult,
  AirJamQualityGate,
  CommandResult,
  RunCompleteEvaluationOptions,
  RunQualityGateOptions,
} from "./types.js";

export const AIR_JAM_COMPLETE_EVALUATION_GATES = [
  "typecheck",
  "lint",
  "test",
  "build",
] as const satisfies readonly AirJamQualityGate[];

const GATE_TO_SCRIPT: Record<RunQualityGateOptions["gate"], string> = {
  typecheck: "typecheck",
  lint: "lint",
  test: "test",
  build: "build",
  "format-check": "format:check",
  "scaffold-smoke": "test:scaffold",
  "release-check": "check:release",
};

export const runQualityGate = async (
  options: RunQualityGateOptions,
): Promise<CommandResult> => {
  const context = await detectProjectContext({ cwd: options.cwd });
  const script = GATE_TO_SCRIPT[options.gate];

  if (
    context.mode !== "monorepo" &&
    (options.gate === "scaffold-smoke" || options.gate === "release-check")
  ) {
    throw new Error(
      `Quality gate "${options.gate}" is only available in the Air Jam monorepo.`,
    );
  }

  const args = options.packageFilter
    ? ["--filter", options.packageFilter, "run", script]
    : ["run", script];

  return runCommandResult({
    command: "pnpm",
    args,
    cwd: context.rootDir,
  });
};

export const runCompleteEvaluation = async ({
  cwd,
}: RunCompleteEvaluationOptions = {}): Promise<AirJamCompleteEvaluationResult> => {
  const startedAt = new Date().toISOString();
  const gates: AirJamCompleteEvaluationResult["gates"] = [];

  for (const gate of AIR_JAM_COMPLETE_EVALUATION_GATES) {
    gates.push({
      gate,
      result: await runQualityGate({ cwd, gate }),
    });
  }

  return {
    contract: "air-jam-complete-evaluation/v1",
    status: gates.every(({ result }) => result.ok) ? "passed" : "failed",
    startedAt,
    endedAt: new Date().toISOString(),
    gates,
  };
};
