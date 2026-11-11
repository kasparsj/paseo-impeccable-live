import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessGuardian } from "../server/process-guardian.ts";

const fixture = path.resolve("tests/guardian-fixture.mjs");
const exists = (file: string) => access(file).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function eventually(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

test("runs the serialized guardian and stops its owned development process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-dev-"));
  const output: string[] = [];
  const guardian = new ProcessGuardian({ onOutput: (_source, text) => output.push(text) });
  try {
    const started = await guardian.startDevelopment({ command: process.execPath, args: [fixture, "dev"], cwd: root });
    assert(started.pid > 0);
    await eventually(() => output.join("").includes("http://127.0.0.1:4567/"), "development output");
    assert.equal(guardian.hasDevelopment, true);
    await guardian.stopDevelopment();
    await eventually(() => !alive(started.pid), "development process exit");
    assert.equal(guardian.hasDevelopment, false);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("kills a TERM-resistant grandchild in the owned POSIX process group", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-tree-"));
  const pidFile = path.join(root, "grandchild.pid");
  const guardian = new ProcessGuardian();
  try {
    await guardian.startDevelopment({ command: process.execPath, args: [fixture, "tree", pidFile], cwd: root });
    await eventually(() => exists(pidFile), "grandchild pid file");
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    assert.equal(alive(grandchildPid), true);
    await guardian.stopDevelopment();
    await eventually(() => !alive(grandchildPid), "grandchild process exit");
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reaps descendants when the development parent exits first", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-parent-first-"));
  const pidFile = path.join(root, "grandchild.pid");
  let exited = false;
  const guardian = new ProcessGuardian({ onExit: () => { exited = true; } });
  try {
    await guardian.startDevelopment({ command: process.execPath, args: [fixture, "parent-first", pidFile], cwd: root });
    await eventually(() => exists(pidFile), "grandchild pid file");
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    await eventually(() => exited, "development parent exit");
    await eventually(() => !alive(grandchildPid), "automatic descendant cleanup");
    assert.equal(guardian.hasDevelopment, false);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("owns a verified helper and refuses to stop a replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-helper-"));
  const guardian = new ProcessGuardian();
  try {
    const boot = await guardian.bootHelper({ command: process.execPath, args: [fixture, "live"], cwd: root });
    assert.match(boot.stdout, /guardian-fixture-token/);
    const recordPath = path.join(root, ".impeccable/live/server.json");
    const original = await readFile(recordPath, "utf8");
    await writeFile(recordPath, JSON.stringify({ pid: 99999, port: 9999, token: "replacement" }));
    await assert.rejects(guardian.stopHelper(), /identity changed/);
    assert.equal(await exists(recordPath), true);
    await writeFile(recordPath, original);
    await guardian.stopHelper();
    await eventually(() => exists(path.join(root, ".guardian-stopped")), "owned helper stop");
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("supports an explicit helper app target without forwarding boot flags to stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-explicit-target-"));
  const guardian = new ProcessGuardian();
  try {
    await assert.rejects(guardian.bootHelper({ command: process.execPath, args: [fixture, "live", "--target", path.dirname(root)], cwd: root }), /target must match/);
    assert.equal(await exists(path.join(root, ".impeccable/live/server.json")), false);
    await guardian.bootHelper({ command: process.execPath, args: [fixture, "live", "--target", root], cwd: root });
    await guardian.stopHelper();
    assert.equal(await exists(path.join(root, ".guardian-stopped")), true);
    assert.equal(await exists(path.join(root, ".impeccable/live/server.json")), false);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("retains helper ownership when its record disappears while the process is live", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-missing-record-"));
  const guardian = new ProcessGuardian();
  try {
    await guardian.bootHelper({ command: process.execPath, args: [fixture, "live"], cwd: root });
    const recordPath = path.join(root, ".impeccable/live/server.json");
    const helperPid = Number(await readFile(path.join(root, ".guardian-helper.pid"), "utf8"));
    assert.equal(alive(helperPid), true);
    await rm(recordPath, { force: true });
    await assert.rejects(guardian.stopHelper(), /record is missing while its process is still running/);
    assert.equal(alive(helperPid), true);
    assert.equal(await exists(path.join(root, ".guardian-injection-removed")), false);

    process.kill(helperPid, "SIGTERM");
    await eventually(() => !alive(helperPid), "orphaned fixture helper exit");
    await guardian.stopHelper();
    assert.equal(await exists(path.join(root, ".guardian-injection-removed")), true);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("retains helper ownership when its stop command removes the record but leaves the process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-incomplete-stop-"));
  const guardian = new ProcessGuardian();
  try {
    await guardian.bootHelper({
      command: process.execPath,
      args: [fixture, "live"],
      cwd: root,
      env: { ...process.env, GUARDIAN_STOP_LEAVES_ALIVE: "1" },
    });
    const helperPid = Number(await readFile(path.join(root, ".guardian-helper.pid"), "utf8"));
    await assert.rejects(guardian.stopHelper(), /removed its record but its retained process is still running/);
    assert.equal(alive(helperPid), true);

    process.kill(helperPid, "SIGTERM");
    await eventually(() => !alive(helperPid), "incompletely stopped helper exit");
    await guardian.stopHelper();
    assert.equal(await exists(path.join(root, ".guardian-injection-removed")), true);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an invalid helper record without losing ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-invalid-record-"));
  const guardian = new ProcessGuardian();
  try {
    await guardian.bootHelper({ command: process.execPath, args: [fixture, "live"], cwd: root });
    const recordPath = path.join(root, ".impeccable/live/server.json");
    const original = await readFile(recordPath, "utf8");
    const helperPid = JSON.parse(original).pid as number;
    await writeFile(recordPath, "not-json");
    await assert.rejects(guardian.stopHelper(), /record is invalid/);
    assert.equal(alive(helperPid), true);
    await writeFile(recordPath, original);
    await guardian.stopHelper();
    await eventually(() => !alive(helperPid), "helper exit after valid record restored");
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans a helper whose delayed boot finishes after parent IPC disconnect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-disconnect-"));
  const output: string[] = [];
  const guardian = new ProcessGuardian({ onOutput: (_source, text) => output.push(text) });
  const boot = guardian.bootHelper({
    command: process.execPath,
    args: [fixture, "live"],
    cwd: root,
    env: { ...process.env, GUARDIAN_BOOT_DELAY_MS: "2300" },
  });
  await eventually(() => output.includes("Helper boot started."), "helper boot acceptance");
  const child = (guardian as unknown as { child: { pid?: number; disconnect(): void } }).child;
  child.disconnect();
  if (child.pid) process.kill(child.pid, "SIGTERM");
  await assert.rejects(boot, /guardian|channel|closed|exited/i);
  await eventually(() => exists(path.join(root, ".guardian-stopped")), "late helper cleanup", 7_000);
  const helperPid = Number(await readFile(path.join(root, ".guardian-helper.pid"), "utf8"));
  await eventually(() => !alive(helperPid), "late helper process exit");
  assert.equal(await exists(path.join(root, ".impeccable/live/server.json")), false);
  await rm(root, { recursive: true, force: true });
});

test("does not leak a development process when shutdown races its launch", async () => {
  const roots: string[] = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const root = await mkdtemp(path.join(tmpdir(), "guardian-start-race-"));
      roots.push(root);
      const pidFile = path.join(root, "development.pid");
      const guardian = new ProcessGuardian();
      const start = guardian.startDevelopment({ command: process.execPath, args: [fixture, "dev-record", pidFile], cwd: root });
      const shutdown = guardian.shutdown();
      const [startResult, shutdownResult] = await Promise.allSettled([start, shutdown]);
      assert.equal(shutdownResult.status, "fulfilled");
      if (startResult.status === "fulfilled") {
        await eventually(() => !alive(startResult.value.pid), "started process exit after raced shutdown");
      }
      if (await exists(pidFile)) {
        const pid = Number(await readFile(pidFile, "utf8"));
        await eventually(() => !alive(pid), "recorded process exit after raced shutdown");
      }
      assert.equal(guardian.hasDevelopment, false);
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("bounds command output and reports command failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-command-"));
  const guardian = new ProcessGuardian();
  try {
    assert.deepEqual(await guardian.command({ command: process.execPath, args: [fixture, "output", "hello"], cwd: root }), { stdout: "hello", stderr: "" });
    assert.deepEqual(await guardian.command({ command: process.execPath, args: [fixture, "env"], cwd: root, env: { GUARDIAN_CUSTOM: "yes" } }), { stdout: "yes|path", stderr: "" });
    await assert.rejects(guardian.command({ command: process.execPath, args: [fixture, "fail"], cwd: root }), /code 7/);
    await assert.rejects(guardian.command({ command: process.execPath, args: [fixture, "huge"], cwd: root }), /exceeded 1 MiB/);
  } finally {
    await guardian.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
