import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose } from "../src/doctor.mjs";
import { appendSample } from "../src/telemetry/store.mjs";
import { ISOLATION_FORBIDDEN_CANARIES } from "../src/harness/isolation-canary.mjs";

// The whole world a diagnosis may see. An unnamed TEAM_UP_HOME is the host's,
// which is how the host's roster reached these tests to begin with.
function homeEnv(home) {
  return { TEAM_UP_HOME: home };
}

function withHome(state, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    for (const [name, doc] of Object.entries(state)) {
      fs.writeFileSync(path.join(home, name), JSON.stringify(doc));
    }
    return fn(homeEnv(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const INDEX = {
  specialists: {
    "testing.tessa": {
      id: "testing.tessa",
      version: "0.1.0",
      checksum: "sha256:aaa",
      path: "/nowhere",
    },
  },
};

test("a rename leaves an assignment that delivers nothing", () => {
  // testing.hannes was renamed to testing.tessa; the assignment still names
  // the old id, matches nobody, and reports no error anywhere.
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["testing.hannes"], exclude: [] },
        ],
      },
    },
    diagnose
  );
  const target = report.findings.find((f) => f.kind === "assignment_unknown_target");
  assert.ok(target, "the stale target must be reported");
  assert.equal(target.id, "testing.hannes");
  assert.equal(target.severity, "medium");
});

test("a stale exclusion is worse than a stale target and ranks higher", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["all"], exclude: ["testing.hannes"] },
        ],
      },
    },
    diagnose
  );
  const excluded = report.findings.find((f) => f.field === "exclude");
  assert.ok(excluded);
  // targets:["all"] plus a dead exclusion means the package now reaches the
  // specialist it was meant to be kept from.
  assert.equal(excluded.severity, "high");
  assert.equal(report.counts.high >= 1, true);
});

test("the literal all target is not a specialist id", () => {
  const report = withHome(
    {
      "specialists-index.json": INDEX,
      "capability-assignments.json": {
        schema_version: 1,
        assignments: [
          { package: "style.caveman@0.1.0", checksum: "sha256:bbb", targets: ["all"], exclude: [] },
        ],
      },
    },
    diagnose
  );
  assert.equal(report.findings.some((f) => f.kind === "assignment_unknown_target"), false);
});

function installedPackage(home, manifest) {
  const dir = path.join(home, "specialists", manifest.id, manifest.version, "abc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "specialist.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "instructions.md"), "hi\n");
  return dir;
}

// Two cells, both valid: the doctor resolves against the roster of the home it
// is given, so this fixture is the whole world these tests see. It has to
// survive validateRoster (an invalid roster exits the process) and reach the
// resolver, or the assertions below would be about nothing. review.example
// runs on a reachable role; coding.example on a chain whose only cell sits on a
// disabled account.
const ROSTER = {
  schema_version: 1,
  models: {
    "some-frontier": {
      reasoning: { max: "high", medium: "medium", low: "low" },
      cli: ["claude"],
      account: "a",
    },
    "off-frontier": { cli: ["claude"], account: "off" },
  },
  accounts: {
    a: { kind: "subscription", enabled: true },
    off: { kind: "subscription", enabled: false },
  },
  clis: { claude: { cmd: ["claude"] } },
  roles: { reviewer: { chain: ["claude:some-frontier"] } },
  specialists: {
    "review.example": { role: "reviewer" },
    "coding.example": { chain: ["off-frontier"] },
  },
};

function installExample(home, id, permissions) {
  const manifest = {
    schema_version: 1,
    id,
    version: "0.1.0",
    display_name: "Example",
    call_types: ["delegate"],
    output_contract: "team-up.result/v1",
    capabilities: { skills: [], tools: [], mcps: [], frameworks: [] },
    permissions: permissions ?? { filesystem: "project", writes: true, network: false, commands: [] },
  };
  const dir = installedPackage(home, manifest);
  fs.writeFileSync(
    path.join(home, "specialists-index.json"),
    JSON.stringify({ specialists: { [id]: { id, version: manifest.version, checksum: "sha256:abc", path: dir } } })
  );
  fs.writeFileSync(path.join(home, "roster.json"), JSON.stringify(ROSTER));
}

test("a specialist whose chain no roster cell can reach is reported before launch", () => {
  // coding.codey was built, published and installed on this host and
  // could never have run. Nothing between building it and running it said so.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    installExample(home, "coding.example");

    const report = diagnose(homeEnv(home));
    const finding = report.findings.find((f) => f.kind === "no_model_for_profile");
    assert.ok(finding, "a chain no cell satisfies must be reported");
    assert.equal(finding.id, "coding.example");
    assert.equal(finding.severity, "high");
    assert.deepEqual(finding.profile, { chain: ["off-frontier"] });
    // The reasons come from the real resolver, so they say why rather than
    // just that it failed — and they are about the fixture cell only. A host
    // model appearing here means the doctor read a roster it was not given.
    assert.deepEqual(finding.skipped, [
      { model: "off-frontier", reason: "account unavailable" },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a specialist with no role or chain is reported before launch", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    installExample(home, "coding.unassigned");

    const report = diagnose(homeEnv(home));
    const finding = report.findings.find((f) => f.kind === "no_model_for_profile");
    assert.ok(finding, "an unassigned specialist must be reported");
    assert.equal(finding.id, "coding.unassigned");
    assert.equal(finding.profile, null);
    assert.match(finding.skipped[0].reason, /no role or chain assigned to coding\.unassigned/);
    assert.match(finding.detail, /no role or chain assigned/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a specialist on a reachable role is not reported", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    installExample(home, "review.example", {
      filesystem: "project_readonly", writes: false, network: false, commands: [],
    });
    const verifyDir = path.join(home, "harness-verification", "claude");
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(verifyDir, "9.9.9.json"),
      JSON.stringify({
        adapter: "claude",
        cli_version: "9.9.9",
        status: "verified",
        context_isolation: "team-up.context-isolation/v1",
        context_isolation_absent: [...ISOLATION_FORBIDDEN_CANARIES],
        checked_at: "2026-09-01T09:57:52.333Z",
      })
    );

    const report = diagnose(homeEnv(home), { execFileSync: () => "9.9.9 (Claude Code)\n" });
    assert.equal(report.findings.some((f) => f.kind === "no_model_for_profile"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// No admission block and no telemetry capped every dispatch at 2 workers,
// silently: nothing reported it until a dispatch was refused.
test("a roster on the admission fallback limit is a medium finding naming both remedies", () => {
  const report = withHome({ "roster.json": { clis: {}, models: {}, roles: {} } }, diagnose);
  const finding = report.findings.find((f) => f.kind === "admission_fallback_limit");
  assert.ok(finding, "the fallback limit must be reported");
  assert.equal(finding.severity, "medium");
  assert.match(finding.detail, /capped at 2 /);
  assert.match(finding.fix, /team-up telemetry install-timer/);
  assert.match(finding.fix, /admission\.max_workers/);
});

// A busy host: telemetry runs and has worker samples, but a worker ran in
// every one of them, so there is no idle baseline. The timer is already
// installed; telling the user to install it fixes nothing.
test("a fallback limit for want of an idle baseline names the baseline, not the timer", () => {
  const report = withHome({ "roster.json": { admission: { min_samples: 1 } } }, (env) => {
    appendSample(
      { at: new Date().toISOString(), workers: [{ runId: "r1", cli: "claude", role: "code", rss_kb: 500_000 }] },
      { dir: path.join(env.TEAM_UP_HOME, "telemetry") }
    );
    return diagnose(env);
  });
  const finding = report.findings.find((f) => f.kind === "admission_fallback_limit");
  assert.ok(finding, "the fallback limit must be reported");
  assert.match(finding.detail, /idle baseline/);
  assert.doesNotMatch(finding.fix, /install-timer/);
  assert.match(finding.fix, /admission\.max_workers/);
});

test("a fixed admission.max_workers is no fallback finding", () => {
  const report = withHome({ "roster.json": { admission: { max_workers: 6 } } }, diagnose);
  assert.equal(report.findings.some((f) => f.kind === "admission_fallback_limit"), false);
});

test("a clean install reports ok", () => {
  const report = withHome({ "specialists-index.json": INDEX }, (env) => diagnose(env, { execFileSync: () => { throw new Error("cli not installed"); } }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { high: 0, medium: 0, low: 0, warning: 0 });
  assert.equal(report.checked.specialists, 1);
});

test("missing harness verification is a warning with a direct verify fix", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.300 (Claude Code)\n" });
    const finding = report.findings.find((item) => item.kind === "harness_verification_missing");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
    assert.equal(finding.installed, "2.1.300");
    assert.equal(finding.fix, "team-up harness verify claude");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("failed harness verification is a warning", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const dir = path.join(home, "harness-verification", "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2.1.300.json"), JSON.stringify({
      adapter: "claude", cli_version: "2.1.300", status: "failed",
    }));
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.300 (Claude Code)\n" });
    const finding = report.findings.find((item) => item.kind === "harness_verification_failed");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
    assert.equal(finding.fix, "team-up harness verify claude");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("harness version drift is a warning and does not revoke specialist eligibility", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    const dir = path.join(home, "harness-verification", "claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2.1.252.json"), JSON.stringify({
      adapter: "claude", cli_version: "2.1.252", status: "verified",
      checked_at: "2026-09-01T09:57:52.333Z",
    }));
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.259 (Claude Code)\n" });
    const finding = report.findings.find((item) => item.kind === "harness_version_drift");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
    assert.equal(finding.installed, "2.1.259");
    assert.equal(finding.fix, "team-up harness verify claude");
    const roster = {
      clis: { claude: { cmd: ["claude", "{prompt}"] } },
      accounts: { anthropic: { kind: "subscription", enabled: true } },
      models: { m: { cli: ["claude"], account: "anthropic", reasoning: { low: null }, priority: 1 } },
      specialists: { "review.example": { chain: ["claude:m"] } },
    };
    fs.writeFileSync(path.join(home, "roster.json"), JSON.stringify(roster));
    const after = diagnose(homeEnv(home), { execFileSync: () => "2.1.259 (Claude Code)\n" });
    assert.equal(after.findings.some((item) => item.kind === "no_model_for_profile"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a chain cell whose CLI no longer lists the model is model_unavailable", () => {
  const roster = {
    clis: {
      cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
      claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
    },
    models: {
      "grok-4.6": { cli: ["cursor"], cli_model: "cursor-grok-4.6-medium" },
      "claude-opus": { cli: ["claude"] },
    },
    roles: { planner: { chain: ["cursor:grok-4.6", "claude:claude-opus"] } },
  };
  const listing = "cursor-grok-4.5-high - Grok 4.5\n";
  const report = withHome(
    { "roster.json": roster },
    (env) => diagnose(env, {
      execFileSync: (_bin, args) => {
        if (args[0] === "models") return listing;
        return "";
      },
    })
  );
  const finding = report.findings.find((f) => f.kind === "model_unavailable");
  assert.ok(finding, "gone chain cell must be reported");
  assert.equal(finding.cli, "cursor");
  assert.equal(finding.model, "grok-4.6");
  assert.equal(finding.severity, "high");
  assert.equal(report.findings.some((f) => f.kind === "model_unavailable" && f.cli === "claude"), false);
});

test("doctor skips model check when CLI listing fails", () => {
  const roster = {
    clis: { cursor: { cmd: ["cursor-agent", "--model", "{model}"] } },
    models: { "grok-4.6": { cli: ["cursor"], cli_model: "cursor-grok-4.6-medium" } },
    roles: { planner: { chain: ["cursor:grok-4.6"] } },
  };
  const report = withHome(
    { "roster.json": roster },
    (env) => diagnose(env, {
      execFileSync: () => {
        throw new Error("timeout");
      },
    })
  );
  assert.equal(report.findings.some((f) => f.kind === "model_unavailable"), false);
});

test("an adapter with no record at all is not reported as drift", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tu-doctor-"));
  try {
    // Nothing planted: a fresh home has never verified anything, and saying
    // "it stopped working" about that would be false.
    const report = diagnose(homeEnv(home), { execFileSync: () => "2.1.259 (Claude Code)\n" });
    assert.equal(report.findings.some((f) => f.kind === "harness_version_drift"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a recent restart blamed on team-up is a high finding", () => {
  const report = withHome({}, (env) => {
    const logs = path.join(env.TEAM_UP_HOME, "logs");
    fs.mkdirSync(logs);
    const base = { schema: "team-up.restart-report/v1", created_at: new Date().toISOString(), previous_boot_id: "p" };
    fs.writeFileSync(path.join(logs, "restart-a.json"), JSON.stringify({
      ...base, boot_id: "a", verdict: "team_up_suspected", reasons: ["memory exhaustion: 1 OOM kill(s)"],
    }));
    fs.writeFileSync(path.join(logs, "restart-b.json"), JSON.stringify({ ...base, boot_id: "b", verdict: "other_cause" }));
    fs.writeFileSync(path.join(logs, "restart-c.json"), JSON.stringify({
      ...base, boot_id: "c", verdict: "team_up_suspected", created_at: "2020-01-01T00:00:00Z",
    }));
    return diagnose(env);
  });
  const found = report.findings.filter((f) => f.kind === "restart_team_up_suspected");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "high");
  assert.match(found[0].detail, /OOM kill/);
});

test("a volatile journal is a medium finding once telemetry runs", () => {
  const volatile = () => ({ persistent: false, storage: "auto", reason: "Storage=auto and /var/log/journal is missing" });
  const before = withHome({}, (env) => diagnose(env, { journalStore: volatile }));
  assert.equal(before.findings.some((f) => f.kind === "journal_not_persistent"), false);
  const after = withHome({}, (env) => {
    fs.mkdirSync(path.join(env.TEAM_UP_HOME, "telemetry"));
    return diagnose(env, { journalStore: volatile });
  });
  const found = after.findings.filter((f) => f.kind === "journal_not_persistent");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "medium");
  assert.match(found[0].fix, /mkdir -p \/var\/log\/journal/);
  const persistent = withHome({}, (env) => {
    fs.mkdirSync(path.join(env.TEAM_UP_HOME, "telemetry"));
    return diagnose(env, { journalStore: () => ({ persistent: true }) });
  });
  assert.equal(persistent.findings.some((f) => f.kind === "journal_not_persistent"), false);
});
