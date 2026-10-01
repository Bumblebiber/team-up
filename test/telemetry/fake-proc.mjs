import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOOT = "11111111-2222-3333-4444-555555555555";

function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * A /proc tree with just the files the sampler reads.
 * processes: [{ pid, ppid, comm, rss_kb, utime, stime, children? }]
 * `children` writes task/<pid>/children; leave it out to force the ppid scan.
 */
export function fakeProc({
  bootId = BOOT,
  mem = { MemTotal: 16_000_000, MemAvailable: 8_000_000, SwapTotal: 0, SwapFree: 0 },
  pressure = true,
  processes = [],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tu-proc-"));
  put(root, "sys/kernel/random/boot_id", `${bootId}\n`);
  put(root, "uptime", "1234.56 4000.00\n");
  put(root, "loadavg", "0.50 0.40 0.30 1/200 999\n");
  put(root, "meminfo", [
    `MemTotal:       ${mem.MemTotal} kB`,
    `MemFree:        1000 kB`,
    `MemAvailable:   ${mem.MemAvailable} kB`,
    `SwapTotal:      ${mem.SwapTotal} kB`,
    `SwapFree:       ${mem.SwapFree} kB`,
    "",
  ].join("\n"));
  if (pressure) {
    put(root, "pressure/memory", "some avg10=1.50 avg60=0.80 avg300=0.10 total=100\nfull avg10=0.50 avg60=0.20 avg300=0.00 total=50\n");
    put(root, "pressure/cpu", "some avg10=3.00 avg60=2.00 avg300=1.00 total=1\n");
    put(root, "pressure/io", "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  }
  for (const p of processes) {
    const fields = ["S", p.ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.utime ?? 0, p.stime ?? 0, 0, 0];
    put(root, `${p.pid}/stat`, `${p.pid} (${p.comm}) ${fields.join(" ")}\n`);
    put(root, `${p.pid}/status`, `Name:\t${p.comm}\n${p.rss_kb == null ? "" : `VmRSS:\t   ${p.rss_kb} kB\n`}`);
    if (p.children) put(root, `${p.pid}/task/${p.pid}/children`, p.children.length ? `${p.children.join(" ")} ` : "");
    else fs.mkdirSync(path.join(root, String(p.pid), "task", String(p.pid)), { recursive: true });
  }
  return root;
}

export function fakeCgroup(root, cgroupPath, { current, peak, procs = [], usageUsec = 0 }) {
  put(root, path.join(cgroupPath, "memory.current"), `${current}\n`);
  if (peak != null) put(root, path.join(cgroupPath, "memory.peak"), `${peak}\n`);
  put(root, path.join(cgroupPath, "cgroup.procs"), procs.map((p) => `${p}\n`).join(""));
  put(root, path.join(cgroupPath, "cpu.stat"), `usage_usec ${usageUsec}\nuser_usec 0\n`);
}

export function rmrf(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
