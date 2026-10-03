// Every test process gets its own empty TEAM_UP_HOME and O9K_HOME. `npm test`
// preloads this (--import); a test that reads the default state paths also
// imports it first, so running that file alone stays hermetic too.
//
// Without it a test that names neither home reads the host's ~/.team-up roster
// and usage, and one that names only TEAM_UP_HOME falls back to the host's
// ~/.o9k (paths.mjs resolveReadPath). Measured with canary files in a scratch
// HOME: 8 test files read one or the other.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "team-up-test-home-"));
process.env.TEAM_UP_HOME = home;
process.env.O9K_HOME = path.join(home, "o9k");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
