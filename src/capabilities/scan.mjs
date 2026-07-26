import fs from "node:fs";
import path from "node:path";

const MARKERS = [
  ["SKILL.md", "skill"],
  [".codex-plugin/plugin.json", "plugin"],
  ["mcp.json", "mcp"],
  ["framework.json", "framework"],
  ["capability.json", "bundle"],
];

export function scanCapabilityRoots(roots) {
  const results = [];
  for (const configured of roots) {
    if (!fs.existsSync(configured)) continue;
    const root = fs.realpathSync(configured);
    const parents = [root];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(root, entry.name);
      parents.push(child);
      for (const nested of fs.readdirSync(child, { withFileTypes: true })) {
        if (!nested.isDirectory() || nested.isSymbolicLink()) continue;
        parents.push(path.join(child, nested.name));
      }
    }
    for (const parent of parents) {
      const matches = MARKERS.filter(([marker]) =>
        fs.existsSync(path.join(parent, marker)));
      if (matches.length === 1) {
        results.push({ type: matches[0][1], path: parent, marker: matches[0][0] });
      } else if (matches.length > 1) {
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

export function normalizeDetectedCandidate(candidate, {
  id, version, displayName, selectedType,
}) {
  const type = selectedType ?? candidate.type;
  if (type === "ambiguous") throw new Error("CAPABILITY_TYPE_REQUIRED");
  if (!id || !version || !displayName) {
    throw new Error("detected import requires id, version, and display name");
  }
  const marker = {
    skill: "SKILL.md",
    plugin: ".codex-plugin/plugin.json",
    mcp: "mcp.json",
    framework: "framework.json",
    bundle: "capability.json",
  }[type];
  if (!marker) throw new Error(`unsupported detected capability type: ${type}`);
  return {
    schema_version: 1,
    id,
    version,
    display_name: displayName,
    provides: {
      skills: type === "skill" ? [marker] : [],
      plugins: type === "plugin" ? [marker] : [],
      mcps: type === "mcp" ? [marker] : [],
      frameworks: type === "framework" ? [marker] : [],
    },
    permissions: { network: false, commands: [], filesystem: "none" },
  };
}
