/**
 * Tool names that count as native shell access across harness adapters.
 * Codex uses `exec_command` / `write_stdin`; Claude uses `Bash`; others vary.
 */
export const NATIVE_SHELL_TOOL_NAMES = Object.freeze([
  "bash",
  "exec_command",
  "write_stdin",
  "shell",
  "shell_command",
  "local_shell",
  "container.exec",
]);

const SHELL_NAME_SET = new Set(NATIVE_SHELL_TOOL_NAMES.map((n) => n.toLowerCase()));

export function isNativeShellToolName(name) {
  const n = String(name || "").trim().toLowerCase();
  return SHELL_NAME_SET.has(n);
}

export function inventoryListsNativeShell(names) {
  if (!Array.isArray(names) || !names.length) return false;
  return names.some((n) => isNativeShellToolName(n));
}
