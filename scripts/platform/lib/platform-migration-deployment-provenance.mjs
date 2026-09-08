import { spawnSync } from "node:child_process";

const commitPattern = /^[0-9a-f]{40}$/u;

const requireCommit = (value, label) => {
  const commit = value?.trim();
  if (!commitPattern.test(commit ?? "")) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return commit;
};

const runGit = ({ repoRoot, args, allowStatus = [] }) => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    const stderr = result.stderr?.trim();
    throw new Error(
      stderr || result.error?.message || `git ${args.join(" ")} failed.`,
    );
  }
  return { status: result.status, stdout: result.stdout.trim() };
};

const resolveTree = ({ repoRoot, commit, label }) => {
  try {
    return runGit({
      repoRoot,
      args: ["rev-parse", "--verify", `${commit}^{tree}`],
    }).stdout;
  } catch {
    throw new Error(
      `${label} ${commit} is not present locally; fetch the commit before verifying.`,
    );
  }
};

export const inspectPlatformMigrationDeploymentProvenance = ({
  repoRoot,
  sourceCommit,
  deployedCommit,
}) => {
  const source = requireCommit(sourceCommit, "Migration source commit");
  const deployed = requireCommit(deployedCommit, "Deployed revision");
  const sourceTree = resolveTree({
    repoRoot,
    commit: source,
    label: "Migration source commit",
  });
  const deployedTree = resolveTree({
    repoRoot,
    commit: deployed,
    label: "Deployed revision",
  });
  const ancestry = runGit({
    repoRoot,
    args: ["merge-base", "--is-ancestor", source, deployed],
    allowStatus: [1],
  });

  return {
    sourceCommit: source,
    deployedCommit: deployed,
    sourceTree,
    deployedTree,
    sourceIsAncestor: ancestry.status === 0,
    treesMatch: sourceTree === deployedTree,
  };
};

export const matchesPlatformMigrationProductionOrigin = ({
  platformOrigin,
  requestPolicy,
}) =>
  requestPolicy.platformPublicOrigin === platformOrigin &&
  !requestPolicy.isRailwayPreviewEnvironment;

export const matchesPlatformMigrationApplicationDeploymentAuthority = ({
  applicationDeployment,
  providerAuthority,
}) =>
  providerAuthority?.status === "verified" &&
  applicationDeployment.provider === providerAuthority.provider &&
  applicationDeployment.environment === providerAuthority.environmentName &&
  applicationDeployment.deploymentId === providerAuthority.deploymentId &&
  (applicationDeployment.revision === null ||
    applicationDeployment.revision === providerAuthority.revision);
