import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const resolveDevtoolsHelperScript = (fileName: string): string => {
  const builtHelperPath = path.resolve(
    moduleDir,
    "tooling",
    fileName.replace(/\.ts$/, ".js"),
  );
  if (existsSync(builtHelperPath)) {
    return builtHelperPath;
  }

  const sourceHelperPath = path.resolve(
    moduleDir,
    "..",
    "src",
    "tooling",
    fileName,
  );
  if (existsSync(sourceHelperPath)) {
    return sourceHelperPath;
  }

  throw new Error(
    `Air Jam helper script is missing from this installation: ${fileName}`,
  );
};

const typescriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const projectTypescriptLoaderHelpers = new Set([
  "agent-contract",
  "inspect-airjam-agent",
  "list-visual-scenarios",
  "run-visual-capture",
]);

export const resolveDevtoolsHelperArgs = (helperPath: string): string[] =>
  typescriptExtensions.has(path.extname(helperPath)) ||
  projectTypescriptLoaderHelpers.has(
    path.basename(helperPath, path.extname(helperPath)),
  )
    ? ["--import", require.resolve("tsx"), helperPath]
    : [helperPath];
