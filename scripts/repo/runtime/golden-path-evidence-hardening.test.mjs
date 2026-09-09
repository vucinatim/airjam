import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  replaceDirectoryAtomically,
  sanitizeEvidenceTree,
} from "../lib/golden-path-primary-run.mjs";

const withTempDirectory = (run) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-evidence-"));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("evidence sanitization covers every UTF-8 file regardless of extension", () =>
  withTempDirectory((directory) => {
    const runRoot = path.join(directory, "run-secret");
    const registryUrl = "http://127.0.0.1:4873";
    fs.mkdirSync(runRoot, { recursive: true });
    for (const name of ["report.yaml", "extensionless"]) {
      fs.writeFileSync(
        path.join(runRoot, name),
        `root: ${runRoot}\nregistry: ${registryUrl}\ncontroller: https://controller.example/controller?room=TEST&aj_controller_cap=private-capability\n`,
      );
    }

    sanitizeEvidenceTree({ evidenceDir: runRoot, runRoot, registryUrl });

    for (const name of ["report.yaml", "extensionless"]) {
      const value = fs.readFileSync(path.join(runRoot, name), "utf8");
      assert.doesNotMatch(value, /run-secret|127\.0\.0\.1/u);
      assert.doesNotMatch(value, /private-capability/u);
      assert.match(value, /<run>|<candidate-registry>/u);
      assert.match(value, /aj_controller_cap=<redacted>/u);
    }

    const nestedJson = JSON.stringify({
      output: JSON.stringify({
        controllerJoinUrl:
          "https://controller.example/controller?room=TEST&aj_controller_cap=private-capability",
      }),
    });
    const nestedPath = path.join(runRoot, "events.ndjson");
    fs.writeFileSync(nestedPath, nestedJson);

    sanitizeEvidenceTree({ evidenceDir: runRoot, runRoot, registryUrl });

    const sanitizedNestedJson = fs.readFileSync(nestedPath, "utf8");
    assert.doesNotMatch(sanitizedNestedJson, /private-capability/u);
    assert.doesNotThrow(() => JSON.parse(sanitizedNestedJson));
  }));

test("evidence sanitization rejects undeclared binary artifacts", () =>
  withTempDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "image.bin"), Buffer.from([1, 0, 2]));
    assert.throws(
      () =>
        sanitizeEvidenceTree({
          evidenceDir: directory,
          runRoot: directory,
          registryUrl: "http://127.0.0.1:4873",
        }),
      /undeclared binary type/u,
    );
  }));

test("atomic evidence replacement restores the previous bundle on rename failure", () =>
  withTempDirectory((directory) => {
    const sourceDir = path.join(directory, "snapshot");
    const targetDir = path.join(directory, "evidence");
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(sourceDir, "new.txt"), "new");
    fs.writeFileSync(path.join(targetDir, "old.txt"), "old");
    let renameCalls = 0;
    const rename = (from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("simulated replacement failure");
      fs.renameSync(from, to);
    };

    assert.throws(
      () => replaceDirectoryAtomically({ sourceDir, targetDir, rename }),
      /simulated replacement failure/u,
    );
    assert.equal(
      fs.readFileSync(path.join(targetDir, "old.txt"), "utf8"),
      "old",
    );
    assert.equal(fs.existsSync(path.join(targetDir, "new.txt")), false);
  }));
