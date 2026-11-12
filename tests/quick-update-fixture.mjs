#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "fail") {
  process.stderr.write("token=fixture-secret\n");
  process.exit(7);
}
if (mode === "large") {
  process.stdout.write("x".repeat(96 * 1024));
  process.exit(0);
}
if (mode === "env") {
  process.stdout.write(JSON.stringify({ bin: process.env.IMPECCABLE_BIN, base: process.env.IMPECCABLE_DOWNLOAD_BASE, skill: process.env.IMPECCABLE_SKILL_DIR, home: process.env.IMPECCABLE_HOME }));
  process.exit(0);
}
if (mode === "hang") {
  const child = await import("node:child_process");
  child.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  setInterval(() => {}, 1000);
}
