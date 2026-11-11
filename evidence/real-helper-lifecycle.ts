import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const { LiveBridge } = await import("../server/live.ts");
const cliPath = process.env.IMPECCABLE_CLI ?? path.join(homedir(), ".agents/skills/impeccable/scripts/impeccable");
const execute = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-bridge-evidence-")));
const index = "<!doctype html><html><head><title>Isolated live fixture</title></head><body><main>Lifecycle probe</main></body></html>\n";
const binding = { workspaceId: "isolated-fixture-workspace", agentId: "isolated-fixture-agent" };
let sentMessages = 0;
const agent = {
  ...binding,
  id: binding.agentId,
  cwd: root,
  status: "idle",
  async refresh() { return true; },
  async send() { sentMessages++; throw new Error("This fixture must not dispatch agent messages."); },
};
const paseo = {
  workspaces: { ref(id: string) {
    assert.equal(id, binding.workspaceId);
    return { directory: root, async refresh() { return true; } };
  } },
  agents: { ref(id: string) { assert.equal(id, binding.agentId); return agent; } },
} as unknown as Parameters<InstanceType<typeof LiveBridge>["start"]>[1];
const bridge = new LiveBridge();
const preview = createServer(async (_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(await readFile(path.join(root, "index.html"), "utf8"));
});
let helper: { pid: number; port: number; token: string } | null = null;
let completed = false;
const checks: string[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await mkdir(path.join(root, ".impeccable/live"), { recursive: true });
  await writeFile(path.join(root, "index.html"), index);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "isolated-live-fixture", private: true, type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "*" } }));
  await writeFile(path.join(root, "PRODUCT.md"), "# Product\n\n## Platform\n\nweb\n\nTemporary lifecycle validation fixture.\n");
  await writeFile(path.join(root, "DESIGN.md"), "# Design\n\n## Overview\n\nTemporary lifecycle validation fixture.\n");
  await writeFile(path.join(root, ".impeccable/live/config.json"), JSON.stringify({ files: ["index.html"], insertBefore: "</body>", commentSyntax: "html", cspChecked: true }));
  await new Promise<void>((resolve) => preview.listen(0, "127.0.0.1", resolve));
  const address = preview.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const start = await bridge.start({ ...binding, appPath: ".", url, cliPath }, paseo);
  assert.equal(start.phase, "running");
  assert.equal(start.appRoot, root);
  assert.equal(start.url, url);
  checks.push("LiveBridge.start returned running with canonical fixture root and preview URL");

  helper = JSON.parse(await readFile(path.join(root, ".impeccable/live/server.json"), "utf8"));
  assert(helper && alive(helper.pid));
  const captured = helper;
  const roots = JSON.parse(await readFile(path.join(root, ".impeccable/live/roots.json"), "utf8"));
  assert.equal(roots.appRoot, root);
  assert.equal(roots.sessionRoot, path.join(root, ".impeccable/live"));
  const helperUrl = `http://127.0.0.1:${captured.port}`;
  const health = await fetch(`${helperUrl}/health`).then((response) => response.json()) as { status: string; port: number };
  assert.equal(health.status, "ok");
  assert.equal(health.port, captured.port);
  assert.equal((await fetch(`${helperUrl}/status`)).status, 401);
  await eventually(async () => {
    const response = await fetch(`${helperUrl}/status?token=${encodeURIComponent(captured.token)}`);
    assert.equal(response.status, 200);
    const status = await response.json() as { agentPolling: boolean };
    return status.agentPolling === true;
  }, "bridge live-poll became active");
  checks.push("Real helper PID alive; roots matched; health succeeded; status required token; background polling active");

  const served = await fetch(url).then((response) => response.text());
  assert.match(served, /impeccable-live/);
  assert(served.includes(String(captured.port)));
  const status = await bridge.status(binding);
  assert.equal(status.phase, "running");
  assert(!JSON.stringify(status).includes(captured.token));
  checks.push("Preview served actual injected index; bridge status running and token-free");

  const stopped = await bridge.stop(binding);
  assert.equal(stopped.phase, "stopped");
  await eventually(async () => !alive(captured.pid), "helper process exited");
  await assert.rejects(readFile(path.join(root, ".impeccable/live/server.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "index.html"), "utf8"), index);
  assert.equal((await bridge.status(binding)).phase, "stopped");
  assert.equal(sentMessages, 0);
  checks.push("Stop returned stopped; helper exited; server record removed; index restored byte-for-byte; no agent messages");
  completed = true;
  console.log(JSON.stringify({ result: "PASS", node: process.version, fixture: root, helperPid: captured.pid, helperPort: captured.port, checks }, null, 2));
} finally {
  await bridge.shutdown().catch(() => undefined);
  if (helper && alive(helper.pid)) {
    const current = JSON.parse(await readFile(path.join(root, ".impeccable/live/server.json"), "utf8").catch(() => "null"));
    if (current?.pid === helper.pid && current?.port === helper.port && current?.token === helper.token) {
      await execute(cliPath, ["live-server", "stop"], { cwd: root, timeout: 15000 });
    }
  }
  await new Promise<void>((resolve, reject) => preview.close((error) => error ? reject(error) : resolve()));
  if (completed) await rm(root, { recursive: true, force: true });
}
