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
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return { status: result.status, stdout: result.stdout.trim() };
};

export const inspectPlatformMigrationDeploymentProvenance = ({
  repoRoot,
  sourceCommit,
  deployedCommit,
}) => {
  const source = requireCommit(sourceCommit, "Migration source commit");
  const deployed = requireCommit(deployedCommit, "Deployed revision");
  const sourceTree = runGit({
    repoRoot,
    args: ["rev-parse", "--verify", `${source}^{tree}`],
  }).stdout;
  const deployedTree = runGit({
    repoRoot,
    args: ["rev-parse", "--verify", `${deployed}^{tree}`],
  }).stdout;
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
