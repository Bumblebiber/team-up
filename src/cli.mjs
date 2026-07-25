export const VERSION = "0.1.0";

export async function runCli(args, io = { out: console.log, err: console.error }) {
  if (args[0] === "version" || args[0] === "--version") {
    io.out(VERSION);
    return 0;
  }
  io.err("usage: team-up <version|validate|pick|dispatch|runs|specialist>");
  return 1;
}
