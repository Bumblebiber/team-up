import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCursorModels,
  parseOpencodeModels,
  collectCliModels,
  scanCliModels,
  scanModels,
  UNSUPPORTED_REASONS,
} from "../../src/collectors/cli-models.mjs";
import { parseClaudeModels, parseCodexModels } from "../../src/collectors/models-pty.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/panes");

const CURSOR_SAMPLE = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
cursor-grok-4.6-medium - Cursor Grok 4.6 Medium
not a model line
`;

const OPENCODE_SAMPLE = `openrouter/x-ai/grok-4.6
openrouter/deepseek/deepseek-v4-pro
deepseek/deepseek-v4-pro
`;

const CLAUDE_SAMPLE = fs.readFileSync(path.join(FIXTURES, "claude/model-picker.txt"), "utf8");
const CODEX_SAMPLE = fs.readFileSync(path.join(FIXTURES, "codex/model-picker.txt"), "utf8");

const ROSTER = {
  clis: {
    cursor: { cmd: ["cursor-agent", "--model", "{model}", "{prompt}"] },
    opencode: { cmd: ["opencode", "run", "--model", "{model}", "{prompt}"] },
    claude: { cmd: ["claude", "--model", "{model}", "{prompt}"] },
    codex: { cmd: ["codex", "--model", "{model}", "{prompt}"] },
    hermes: { cmd: ["hermes", "chat", "--model", "{model}", "{prompt}"] },
  },
  models: {
    "composer-2.5": { cli: ["cursor"] },
    "grok-4.6": { cli: ["cursor"], cli_model: "cursor-grok-4.6-medium" },
    "gone-alpha": { cli: ["opencode"], cli_model: "openrouter/stealth/gone-alpha" },
    "deepseek-v4-pro": { cli: ["opencode", "hermes"], cli_model: { opencode: "openrouter/deepseek/deepseek-v4-pro" } },
    "brand-new-cli-only": { cli: ["cursor"], cli_model: "retired-cursor-model" },
    "claude-opus": { cli: ["claude"], cli_model: "opus" },
  },
};

const LISTINGS = {
  "cursor-agent": CURSOR_SAMPLE,
  opencode: OPENCODE_SAMPLE,
};
const run = (bin, args) => {
  if (bin === "claude" && args[0] === "-p") return CLAUDE_SAMPLE;
  const out = LISTINGS[bin];
  if (out === undefined) throw new Error(`${bin} ${args.join(" ")}: not found`);
  return out;
};

const runModelPty = (cli) => ({
  ok: true,
  transcript: cli === "codex" ? CODEX_SAMPLE : CLAUDE_SAMPLE,
});

test("parseCursorModels handles display names and (current)", () => {
  const models = parseCursorModels(CURSOR_SAMPLE);
  assert.deepEqual(
    models.map((m) => m.id),
    ["auto", "composer-2.5", "cursor-grok-4.6-medium"]
  );
  const current = models.find((m) => m.id === "composer-2.5");
  assert.equal(current.display_name, "Composer 2.5");
  assert.equal(current.current, true);
  assert.equal(models.find((m) => m.id === "auto").current, undefined);
});

test("parseOpencodeModels takes one id per line", () => {
  const models = parseOpencodeModels(OPENCODE_SAMPLE);
  assert.deepEqual(models.map((m) => m.id), [
    "openrouter/x-ai/grok-4.6",
    "openrouter/deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro",
  ]);
});

test("parseClaudeModels and parseCodexModels parse committed fixtures", () => {
  assert.ok(parseClaudeModels(CLAUDE_SAMPLE).some((m) => m.id === "opus"));
  assert.ok(parseCodexModels(CODEX_SAMPLE).some((m) => m.id === "gpt-6-astra"));
});

test("unsupported CLIs return documented reasons", () => {
  const r = collectCliModels("hermes", { roster: ROSTER, run, runModelPty });
  assert.equal(r.supported, false);
  assert.equal(r.reason, UNSUPPORTED_REASONS.hermes);
});

test("codex without PTY runner is unsupported", () => {
  const r = collectCliModels("codex", { roster: ROSTER, run });
  assert.equal(r.supported, false);
  assert.match(r.reason, /PTY/);
});

test("claude and codex collect via -p and PTY respectively", () => {
  const claude = collectCliModels("claude", { roster: ROSTER, run, runModelPty });
  assert.equal(claude.supported, true);
  assert.ok(claude.models.some((m) => m.id === "opus"));

  const codex = collectCliModels("codex", { roster: ROSTER, run, runModelPty });
  assert.equal(codex.supported, true);
  assert.ok(codex.models.some((m) => m.id === "gpt-6-astra"));
});

test("scanCliModels classifies known, new, and gone", () => {
  const report = scanCliModels("cursor", { roster: ROSTER, run, runModelPty });
  assert.equal(report.supported, true);
  assert.deepEqual(
    report.known.map((k) => k.roster_id).sort(),
    ["composer-2.5", "grok-4.6"]
  );
  assert.ok(report.new.some((n) => n.cli_id === "auto"));
  assert.deepEqual(report.gone, [{ roster_id: "brand-new-cli-only", sent: "retired-cursor-model" }]);
});

test("scanCliModels matches opencode via cli_model alias", () => {
  const report = scanCliModels("opencode", { roster: ROSTER, run, runModelPty });
  assert.equal(report.supported, true);
  assert.ok(report.known.some((k) => k.roster_id === "deepseek-v4-pro"));
  assert.deepEqual(report.gone, [{ roster_id: "gone-alpha", sent: "openrouter/stealth/gone-alpha" }]);
  assert.ok(report.new.some((n) => n.cli_id === "openrouter/x-ai/grok-4.6"));
});

test("scanModels returns reports and collected map", () => {
  const { reports, collectedByCli } = scanModels({ roster: ROSTER, cliFilter: "claude", run, runModelPty });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].supported, true);
  assert.ok(collectedByCli.get("claude")?.supported);
});

test("a failed listing is unsupported, not empty", () => {
  const failing = () => {
    throw new Error("boom");
  };
  const r = collectCliModels("cursor", { roster: ROSTER, run: failing });
  assert.equal(r.supported, false);
  assert.match(r.reason, /boom/);
});
