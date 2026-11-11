#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const recordPath = path.join(cwd, ".impeccable/live/server.json");

if (mode === "dev") {
  process.stdout.write("Local: http://127.0.0.1:4567/\n");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} else if (mode === "dev-record") {
  await writeFile(args[0], String(process.pid));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} else if (mode === "tree") {
  const pidFile = args[0];
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, "grandchild"], { stdio: "ignore" });
  await writeFile(pidFile, String(grandchild.pid));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} else if (mode === "parent-first") {
  const pidFile = args[0];
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, "grandchild"], { stdio: "ignore" });
  await writeFile(pidFile, String(grandchild.pid));
  setTimeout(() => process.exit(0), 100);
} else if (mode === "grandchild") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
} else if (mode === "helper-daemon") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
} else if (mode === "live") {
  const delay = Number(process.env.GUARDIAN_BOOT_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  await mkdir(path.dirname(recordPath), { recursive: true });
  const daemon = spawn(process.execPath, [new URL(import.meta.url).pathname, "helper-daemon"], { detached: true, stdio: "ignore" });
  daemon.unref();
  const helper = { pid: daemon.pid, port: 8456, token: "guardian-fixture-token" };
  await writeFile(recordPath, JSON.stringify(helper));
  await writeFile(path.join(cwd, ".guardian-helper.pid"), String(helper.pid));
  process.stdout.write(JSON.stringify({ ok: true, serverPort: helper.port, serverToken: helper.token }));
} else if (mode === "live-server" && args[0] === "stop") {
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (process.env.GUARDIAN_STOP_LEAVES_ALIVE !== "1") {
    try { process.kill(record.pid, "SIGTERM"); } catch {}
  }
  await rm(recordPath, { force: true });
  await writeFile(path.join(cwd, ".guardian-stopped"), "yes");
} else if (mode === "live-inject" && args[0] === "--remove") {
  await writeFile(path.join(cwd, ".guardian-injection-removed"), "yes");
} else if (mode === "output") {
  process.stdout.write(args.join(" "));
} else if (mode === "env") {
  process.stdout.write(`${process.env.GUARDIAN_CUSTOM ?? ""}|${process.env.PATH ? "path" : "no-path"}`);
} else if (mode === "huge") {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
} else if (mode === "fail") {
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "read") {
  process.stdout.write(await readFile(args[0], "utf8"));
} else {
  process.stderr.write(`Unknown fixture mode: ${mode}`);
  process.exitCode = 2;
}
