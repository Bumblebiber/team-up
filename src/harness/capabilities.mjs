export const COMMAND_BROKER_CAPABILITY = "team-up.command-broker/v1";

export const UNVERIFIED_CAPABILITIES = Object.freeze({
  command_broker: null,
  native_shell: "unverified",
  mcp: "unverified",
});

export const CLAUDE_DECLARED_CAPABILITIES = Object.freeze({
  command_broker: COMMAND_BROKER_CAPABILITY,
  native_shell: "denied",
  mcp: "stdio",
});
