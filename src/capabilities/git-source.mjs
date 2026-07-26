import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { importLocalCapability } from "./store.mjs";

export function importGitCapability({ url, ref = "HEAD" }, {
  env = process.env, exec = execFileSync,
} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-git-"));
  const repo = path.join(temp, "repo");
  try {
    exec("git", ["clone", "--no-checkout", "--filter=blob:none", "--", url, repo],
      { stdio: "pipe" });
    const commit = String(exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repo, encoding: "utf8",
    })).trim();
    exec("git", ["checkout", "--detach", commit], { cwd: repo, stdio: "pipe" });
    return importLocalCapability(repo, {
      env,
      sourceMetadata: { type: "git", url, ref, commit },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
