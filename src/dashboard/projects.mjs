import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmuxArgs } from "../roster/command.mjs";
import { listTmuxSessions } from "../runs/tmux.mjs";
import {
  COMMAND_POLICY_FILE,
  validateCommandPolicy,
  resolveProjectCommandPolicy,
} from "../commands/policy.mjs";
import { isPolicyTrusted, trustProjectPolicy } from "../specialists/approvals.mjs";

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

/**
 * One project, as the browser named it, checked against the collecting folder.
 * Every write the panel makes into a project goes through here first.
 */
function resolveProjectDir(dir, projectsDir) {
  const collecting = resolveCollectingDir(projectsDir);
  let real;
  try {
    real = fs.realpathSync(String(dir || ""));
  } catch {
    return { ok: false, status: 404, error: "no such project" };
  }
  if (path.dirname(real) !== collecting || !fs.statSync(real).isDirectory()) {
    return { ok: false, status: 400, error: "project is not a directory inside the collecting folder" };
  }
  return { ok: true, real };
}

// ── command policy ──
// Detection is deliberately narrow. A proposal is only `auto` when there is
// exactly one test command and nothing to choose: a wrong guess written into
// someone's checkout is worse than a missing file with a suggestion next to it.

const NPM_PLACEHOLDER = /no test specified/;
const PYTEST_CONFIGS = ["pyproject.toml", "setup.cfg", "tox.ini"];

const has = (...parts) => fs.existsSync(path.join(...parts));

function hasNpmTest(dir) {
  try {
    const test = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))?.scripts?.test;
    return typeof test === "string" && test.trim() !== "" && !NPM_PLACEHOLDER.test(test);
  } catch {
    return false;
  }
}

const PY_TEST_FILE = /^(test_.*|.*_test)\.py$|^conftest\.py$/;

/** A test dir says pytest only if it holds Python tests: node repos have one too. */
function hasPythonTests(dir) {
  try {
    return fs.readdirSync(dir).some((f) => PY_TEST_FILE.test(f));
  } catch {
    return false;
  }
}

function hasPytestMarkers(dir) {
  if (["pytest.ini", "conftest.py"].some((f) => has(dir, f))) return true;
  if (["tests", "test"].some((d) => hasPythonTests(path.join(dir, d)))) return true;
  return PYTEST_CONFIGS.some((f) => {
    try {
      return fs.readFileSync(path.join(dir, f), "utf8").includes("pytest");
    } catch {
      return false;
    }
  });
}

const testAction = (argv, cwd = ".") => ({ argv, cwd, timeout_seconds: 900, environment: {} });

/** The `project-test` action this repo most likely wants, or null for none. */
export function proposePolicy(dir) {
  const candidates = [];
  if (hasNpmTest(dir)) {
    candidates.push({ action: testAction(["npm", "test"]), auto: true });
  } else {
    let nested = [];
    try {
      nested = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name)
        .filter((name) => hasNpmTest(path.join(dir, name)))
        .sort();
    } catch {
      // unreadable: no nested candidates
    }
    // Several nested packages: which one is "the" test suite is Benni's call.
    if (nested.length) candidates.push({ action: testAction(["npm", "test"], nested[0]), auto: nested.length === 1 });
  }
  if (hasPytestMarkers(dir)) {
    const venv = has(dir, ".venv", "bin", "python");
    candidates.push({
      action: testAction([venv ? ".venv/bin/python" : "python3", "-m", "pytest", "-q"]),
      auto: venv && has(dir, ".venv", "bin", "pytest"),
    });
  }
  if (!candidates.length) return null;
  return {
    policy: { schema_version: 1, commands: { "project-test": candidates[0].action } },
    auto: candidates.length === 1 && candidates[0].auto,
  };
}

/** valid | invalid (with errors) | missing (with a proposal) | none (no tests found). */
export function projectPolicy(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, COMMAND_POLICY_FILE), "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") return { state: "invalid", errors: [e.message] };
    const proposal = proposePolicy(dir);
    return proposal ? { state: "missing", proposal } : { state: "none" };
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (e) {
    return { state: "invalid", errors: [`not JSON: ${e.message}`] };
  }
  const { ok, errors } = validateCommandPolicy(policy);
  return ok ? { state: "valid" } : { state: "invalid", errors };
}

/**
 * Create `.team-up/commands.json` — never overwrite it. Replacing a policy
 * silently invalidates the trust record for its checksum, so that stays a
 * deliberate edit in the repo. Nothing is committed: the file shows up as an
 * untracked change in the project's own checkout.
 */
export function writeProjectPolicy({ dir, projectsDir, policy = null } = {}) {
  const target = resolveProjectDir(dir, projectsDir);
  if (!target.ok) return target;
  let body = policy;
  if (!body) {
    const proposal = proposePolicy(target.real);
    if (!proposal?.auto) {
      return { ok: false, status: 400, error: "no unambiguous test command — edit the proposal and save it" };
    }
    body = proposal.policy;
  }
  const { ok, errors } = validateCommandPolicy(body);
  if (!ok) return { ok: false, status: 400, error: errors.join("; ") };

  // A symlinked .team-up would turn a write into this repo into a write anywhere.
  const teamUpDir = path.join(target.real, path.dirname(COMMAND_POLICY_FILE));
  try {
    if (!fs.lstatSync(teamUpDir).isDirectory()) {
      return { ok: false, status: 400, error: ".team-up is not a plain directory" };
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    fs.mkdirSync(teamUpDir);
  }
  const file = path.join(target.real, COMMAND_POLICY_FILE);
  try {
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") return { ok: false, status: 409, error: `${COMMAND_POLICY_FILE} already exists` };
    throw e;
  }
  return { ok: true, path: file };
}

/** Policy state plus checksum trust, including an inherited main-checkout policy. */
function projectPolicyStatus(dir, env) {
  const own = projectPolicy(dir);
  try {
    const loaded = resolveProjectCommandPolicy(dir);
    const inherited = path.resolve(loaded.path) !== path.resolve(dir, COMMAND_POLICY_FILE);
    return {
      ...own,
      ...(inherited ? { state: "inherited", source: loaded.path } : {}),
      checksum: loaded.checksum,
      trusted: isPolicyTrusted({ checksum: loaded.checksum, env }),
    };
  } catch {
    return { ...own, trusted: null };
  }
}

/** Trust the policy of one project in the dashboard's collecting folder. */
export function trustProjectPolicyForProject({ dir, projectsDir, env = process.env } = {}) {
  const target = resolveProjectDir(dir, projectsDir);
  if (!target.ok) return target;
  const result = trustProjectPolicy({ project: target.real, env });
  return result.ok ? result : {
    ...result,
    status: 400,
    error: (result.errors || []).join("; "),
  };
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

export function listProjects(dirInput, { exec = execFileSync, sessions = null, env = process.env } = {}) {
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
        policy: projectPolicyStatus(full, env),
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
  const cmd = roster?.clis?.[cli]?.cmd?.[0];
  if (!cmd) return { ok: false, status: 400, error: `unknown cli: ${cli}` };
  const target = resolveProjectDir(dir, projectsDir);
  if (!target.ok) return target;
  const { real } = target;

  const session = projectSessionName(path.basename(real), cli);
  const live = sessions ?? listTmuxSessions({ exec });
  // Already running is not an error: the panel's button just opens it.
  if (live.includes(session)) return { ok: true, session, existing: true };

  exec("tmux", tmuxArgs({ session, dir: real, argv: [cmd], env: { TEAMUP_WORKER: "" } }), {
    stdio: "ignore",
  });
  return { ok: true, session, existing: false };
}
