// Every test process gets its own empty TEAM_UP_HOME and O9K_HOME. `npm test`
// preloads this (--import); a test that reads the default state paths also
// imports it first, so running that file alone stays hermetic too.
//
// Without it a test that names neither home reads the host's ~/.team-up roster
// and usage, and one that names only TEAM_UP_HOME falls back to the host's
// ~/.o9k (paths.mjs resolveReadPath). Measured with canary files in a scratch
// HOME: 8 test files read one or the other.
//
// HOME is replaced too, with a dummy Claude credential: a capsule launch copies
// $HOME/.claude/.credentials.json into its run home, so every test that
// prepared one left a copy of the host's real OAuth credential in /tmp. A
// Codex capsule copies auth.json from CODEX_HOME the same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-test-home-"));
process.env.TEAM_UP_HOME = home;
process.env.O9K_HOME = path.join(home, "o9k");
process.env.HOME = path.join(home, "home");
delete process.env.CODEX_HOME;
fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, ".claude", ".credentials.json"), "{}\n", { mode: 0o600 });
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
