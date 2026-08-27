import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../json-store.mjs";
import { assertPathInsideRoot, assertSafeSpecialistSegment, assertSafeRelPath } from "../specialists/safe-id.mjs";

function assertUnderRoot(absPath, root) {
  const resolved = fs.realpathSync(absPath);
  const rootResolved = fs.realpathSync(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes approved root: ${absPath}`);
  }
  return resolved;
}

export async function materialize({
  packageDir,
  request,
  destination,
  manifest,
  projectRoot,
  inputs = [],
  filesystem,
}) {
  fs.mkdirSync(destination, { recursive: true });
  const pkgRoot = fs.realpathSync(packageDir);
  const destRoot = path.resolve(destination);
  const fsMode = filesystem ?? manifest?.permissions?.filesystem;

  const copyFile = (rel) => {
    const from = path.join(pkgRoot, rel);
    if (!fs.existsSync(from)) return false;
    if (fs.lstatSync(from).isSymbolicLink()) {
      throw new Error(`refusing symlink: ${from}`);
    }
    assertUnderRoot(from, pkgRoot);
    assertPathInsideRoot(path.join(destRoot, rel), destRoot);
    const to = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  };

  copyFile("specialist.json");
  copyFile("instructions.md");
  const skills = manifest?.capabilities?.skills || [];
  for (const skill of skills) {
    assertSafeSpecialistSegment(String(skill), "skill id");
    copyFile(path.join("skills", `${skill}.md`));
  }
  if (manifest?.eval_suite) {
    const rel = assertSafeRelPath(String(manifest.eval_suite), "eval_suite");
    copyFile(rel);
  }

  atomicWriteJson(path.join(destination, "REQUEST.json"), request);

  const inputsDir = path.join(destination, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });

  // filesystem:none — do not bind or traverse the project tree.
  // Only explicitly provided absolute (or already-approved) input artifacts.
  if (fsMode === "none") {
    for (const item of inputs) {
      if (!item?.path) continue;
      if (!path.isAbsolute(item.path)) {
        throw new Error("filesystem:none requires absolute input artifact paths");
      }
      const src = item.path;
      if (fs.lstatSync(src).isSymbolicLink()) {
        throw new Error(`refusing symlink input: ${src}`);
      }
      const base = path.basename(src);
      const dest = path.join(inputsDir, base);
      assertPathInsideRoot(dest, destRoot);
      fs.copyFileSync(src, dest);
    }
  } else if (projectRoot) {
    const proj = fs.realpathSync(projectRoot);
    for (const item of inputs) {
      if (!item?.path) continue;
      const src = path.isAbsolute(item.path) ? item.path : path.join(proj, item.path);
      if (fs.lstatSync(src).isSymbolicLink()) {
        throw new Error(`refusing symlink input: ${src}`);
      }
      assertUnderRoot(src, proj);
      const base = path.basename(src);
      fs.copyFileSync(src, path.join(inputsDir, base));
    }
  }

  // No mailbox is seeded here. The run's real one already exists a directory
  // up, and this destination is the worker's cwd — a second `mailbox/` here is
  // exactly where a relative path lands, so seeding one turned a wrong path
  // into a silent success: the worker reported done into a directory nothing
  // reads, while the watcher waited on the real mailbox forever. Without it a
  // relative write fails loudly instead.
  return destination;
}

export async function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
