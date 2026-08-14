import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Layout markers recognized in an existing local installation. */
const MARKERS = [
  ["SKILL.md", "skill"],
  [".claude-plugin/plugin.json", "plugin"],
  [".codex-plugin/plugin.json", "plugin"],
  ["mcp.json", "mcp"],
  ["framework.json", "framework"],
  ["capability.json", "bundle"],
];

const TYPE_MARKERS = {
  skill: "SKILL.md",
  plugin: ".claude-plugin/plugin.json",
  mcp: "mcp.json",
  framework: "framework.json",
  bundle: "capability.json",
};

const PROVIDE_KEY = {
  skill: "skills",
  plugin: "plugins",
  mcp: "mcps",
  framework: "frameworks",
};

/** Known roots scanned when the human names none. */
export function defaultScanRoots(env = process.env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "plugins"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents"),
  ];
}

/**
 * Read-only discovery. Reports import candidates and never imports,
 * activates, or rewrites the original installation.
 */
export function scanCapabilityRoots(roots) {
  const results = [];
  for (const configured of roots) {
    if (!fs.existsSync(configured)) continue;
    const root = fs.realpathSync(configured);
    const children = fs
      .readdirSync(root, { withFileTypes: true })
      // A symlinked directory could point anywhere; scanning stays inside.
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
    for (const parent of [root, ...children]) {
      const matches = MARKERS.filter(([marker]) =>
        fs.existsSync(path.join(parent, marker))
      );
      const types = [...new Set(matches.map(([, type]) => type))];
      if (types.length === 1) {
        results.push({ type: types[0], path: parent, marker: matches[0][0] });
      } else if (types.length > 1) {
        results.push({
          type: "ambiguous",
          path: parent,
          markers: matches.map(([marker, type]) => ({ marker, type })),
        });
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build a capability manifest for a detected candidate. The human supplies
 * identity; ambiguous candidates require an explicit type. `relPath` overrides
 * the declared path for layouts (plugins, frameworks) whose content is a
 * directory rather than the marker file itself.
 */
export function normalizeDetectedCandidate(
  candidate,
  { id, version, displayName, selectedType, relPath } = {}
) {
  const type = selectedType ?? candidate.type;
  if (type === "ambiguous") throw new Error("CAPABILITY_TYPE_REQUIRED");
  if (!id || !version || !displayName) {
    throw new Error("detected import requires id, version, and display name");
  }
  const marker = TYPE_MARKERS[type];
  if (!marker) throw new Error(`unsupported detected capability type: ${type}`);
  if (type === "bundle") {
    throw new Error("a bundle already declares capability.json; import it directly");
  }
  const declared = relPath ?? marker;
  const provides = { skills: [], plugins: [], mcps: [], frameworks: [] };
  provides[PROVIDE_KEY[type]] = [declared];
  return {
    schema_version: 1,
    id,
    version,
    display_name: displayName,
    provides,
    permissions: { network: false, commands: [], filesystem: "none" },
  };
}
