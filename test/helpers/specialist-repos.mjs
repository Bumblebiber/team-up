import fs from "node:fs";
import path from "node:path";

const REQUIRED_SPECIALISTS = ["team-up-with-tessa", "team-up-with-reanna"];

function containsSpecialistRepos(candidate) {
  return REQUIRED_SPECIALISTS.every((repo) =>
    fs.existsSync(path.join(candidate, repo, "specialist.json")),
  );
}

export function findSpecialistRepos(start, env = process.env) {
  if (env.TEAM_UP_TEST_REPOS) {
    const configured = path.resolve(env.TEAM_UP_TEST_REPOS);
    if (!containsSpecialistRepos(configured)) {
      throw new Error(`TEAM_UP_TEST_REPOS does not contain starter specialists: ${configured}`);
    }
    return configured;
  }

  let candidate = path.resolve(start);
  while (true) {
    if (containsSpecialistRepos(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  throw new Error(`Could not locate starter specialist repositories above ${path.resolve(start)}`);
}
