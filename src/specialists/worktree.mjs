import fs from "node:fs";
import path from "node:path";

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The main checkout a git worktree belongs to, or null when `dir` is not one.
 *
 * A worktree runs under its main checkout's command policy and approval, so
 * this answer is a grant — and the `.git` file it starts from sits in the
 * worktree, where a worker can write. The claim alone therefore proves
 * nothing. What proves it is the back-link git keeps inside the main repo,
 * `<main>/.git/worktrees/<name>/gitdir`, which has to name this very worktree:
 * a folder cannot adopt a checkout without write access to that checkout's
 * `.git`. A bare common dir has no checkout to take a policy from.
 */
export function mainCheckoutOf(dir) {
  const self = real(dir);
  if (!self) return null;
  const dotGit = path.join(self, ".git");
  let claim;
  try {
    if (!fs.lstatSync(dotGit).isFile()) return null;
    claim = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
  } catch {
    return null;
  }
  if (!claim) return null;
  const gitdir = real(path.resolve(self, claim));
  if (!gitdir) return null;

  let back;
  let common;
  try {
    back = fs.readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
    common = real(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()));
  } catch {
    return null;
  }
  if (!common || path.basename(common) !== ".git") return null;
  if (path.dirname(gitdir) !== path.join(common, "worktrees")) return null;
  if (real(path.resolve(gitdir, back)) !== dotGit) return null;
  const main = path.dirname(common);
  return main === self ? null : main;
}
