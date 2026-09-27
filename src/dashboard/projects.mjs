import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmuxArgs } from "../roster/command.mjs";
import { listTmuxSessions } from "../runs/tmux.mjs";

export const SESSION_PREFIX = "team-up-proj-";

/** tmux rewrites `.` and `:` in a session name, so the name we check for and
 *  the name we create have to be built from the same sanitised slug. */
const slug = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "-");

export const projectSessionName = (name, cli) => `${SESSION_PREFIX}${slug(name)}-${slug(cli)}`;

/**
 * The collecting folder, as the browser typed it, turned into a path the server
 * is willing to read. Both the folder and the project inside it arrive from the
 * client, so "is a child of the folder" is not a boundary on its own — the home
 * directory is. realpath resolves `..` and symlinks before that check.
 */
export function resolveCollectingDir(input) {
  const home = fs.realpathSync(os.homedir());
  const raw = String(input || "").trim() || path.join(home, "projects");
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error("collecting folder must be an absolute path");
  let real;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new Error(`no such directory: ${expanded}`);
  }
  if (real !== home && !real.startsWith(home + path.sep)) {
    throw new Error("collecting folder must be inside the home directory");
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${expanded}`);
  return real;
}

/** Branch and dirtiness in one call — `status --branch` reports both. */
function gitInfo(dir, exec) {
  try {
    const raw = exec("git", ["-C", dir, "status", "--porcelain=v2", "--branch"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(raw).split("\n");
    const head = lines.find((l) => l.startsWith("# branch.head "));
    return {
      branch: head ? head.slice("# branch.head ".length).trim() : null,
      dirty: lines.some((l) => l && !l.startsWith("#")),
    };
  } catch {
    return { branch: null, dirty: false };
  }
}

export function listProjects(dirInput, { exec = execFileSync, sessions = null } = {}) {
  const dir = resolveCollectingDir(dirInput);
  const live = sessions ?? listTmuxSessions({ exec });
  const projects = fs.readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      const full = path.join(dir, name);
      // stat, not withFileTypes: a project symlinked into the folder is still
      // a project.
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        return null;
      }
      if (!st.isDirectory()) return null;
      const git = fs.existsSync(path.join(full, ".git"));
      return {
        name,
        path: full,
        git,
        ...(git ? gitInfo(full, exec) : { branch: null, dirty: false }),
        sessions: live.filter((s) => s.startsWith(`${SESSION_PREFIX}${slug(name)}-`)).sort(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, projects };
}

/**
 * An interactive CLI in one project, detached in tmux, for a human to drive
 * through the pane overlay. Deliberately the bare binary from roster.clis:
 * the templated form carries --dangerously-* flags and a {prompt}, which is
 * what a dispatched worker wants, not a session Benni types into himself.
 * TEAMUP_WORKER is cleared for the same reason.
 */
export function startProjectSession({
  dir,
  cli,
  projectsDir,
  roster,
  exec = execFileSync,
  sessions = null,
} = {}) {
  const collecting = resolveCollectingDir(projectsDir);
  const cmd = roster?.clis?.[cli]?.cmd?.[0];
  if (!cmd) return { ok: false, status: 400, error: `unknown cli: ${cli}` };

  let real;
  try {
    real = fs.realpathSync(String(dir || ""));
  } catch {
    return { ok: false, status: 404, error: "no such project" };
  }
  if (path.dirname(real) !== collecting || !fs.statSync(real).isDirectory()) {
    return { ok: false, status: 400, error: "project is not a directory inside the collecting folder" };
  }

  const session = projectSessionName(path.basename(real), cli);
  const live = sessions ?? listTmuxSessions({ exec });
  // Already running is not an error: the panel's button just opens it.
  if (live.includes(session)) return { ok: true, session, existing: true };

  exec("tmux", tmuxArgs({ session, dir: real, argv: [cmd], env: { TEAMUP_WORKER: "" } }), {
    stdio: "ignore",
  });
  return { ok: true, session, existing: false };
}
