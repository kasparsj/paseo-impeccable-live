import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { PaseoApi } from "@getpaseo/client";
import { LiveBridge } from "../server/live.ts";

const fixtureCli = path.resolve("tests/backend-fixture.mjs");
type WaitResult = { status: "idle" | "error" | "permission" | "timeout"; final: null; error: string | null; lastMessage: string | null };

async function harness(t: TestContext, options: { frontend?: boolean; agentWorkspaceId?: string } = {}) {
  await chmod(fixtureCli, 0o755);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-live-plugin-")));
  const app = options.frontend ? path.join(root, "frontend") : root;
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "package.json"), "{}");
  await writeFile(path.join(app, ".fixture-control.json"), JSON.stringify({ events: [{ type: "wait" }] }));
  const sent: string[] = [];
  let send = async (message: string) => { sent.push(message); };
  let wait: () => Promise<WaitResult> = async () => ({ status: "idle", final: null, error: null, lastMessage: null });
  let refresh = async () => ({ agent: {} });
  const agent = {
    workspaceId: null as string | null,
    async refresh() { this.workspaceId = options.agentWorkspaceId ?? "workspace-1"; return refresh(); },
    async send(message: string) { return send(message); },
    async waitForFinish() { return wait(); },
  };
  const paseo = {
    workspaces: { ref: () => ({ directory: root, async refresh() { return {}; } }) },
    agents: { ref: () => agent },
  } as unknown as PaseoApi;
  const bridge = new LiveBridge();
  const bridges = [bridge];
  t.after(async () => {
    await Promise.all(bridges.map((owned) => owned.quiesce()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    bridge, root, app, sent, paseo,
    trackBridge(owned: LiveBridge) { bridges.push(owned); },
    input: { workspaceId: "workspace-1", agentId: "agent-1", appPath: ".", url: "http://localhost:5173/", cliPath: fixtureCli },
    setSend(next: (message: string) => Promise<void>) { send = next; },
    setWait(next: () => Promise<WaitResult>) { wait = next; },
    setRefresh(next: () => Promise<{ agent: object }>) { refresh = next; },
  };
}

async function setControl(app: string, control: object) {
  const file = path.join(app, ".fixture-control.json");
  await writeFile(`${file}.test.tmp`, JSON.stringify(control));
  await rename(`${file}.test.tmp`, file);
}
const setEvents = (app: string, events: unknown[]) => setControl(app, { events });
const fixtureState = async (app: string) => JSON.parse(await readFile(path.join(app, ".fixture-state.json"), "utf8")) as Record<string, number>;
async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("starts one owned helper, dispatches an event, and stops after identity revalidation", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "generate", eventId: "evt-1", sessionId: "session-1", prompt: "focus" }, { type: "wait" }]);
  const started = await h.bridge.start(h.input, h.paseo);
  assert.equal(started.phase, "running");
  assert.equal(started.message.includes("fixture-secret-token"), false);
  await waitFor(() => h.sent.length === 1, "event was not dispatched");
  assert.match(h.sent[0], /evt-1/);
  assert.match(h.sent[0], /session-1/);
  assert.match(h.sent[0], /plugin owns the ongoing live-poll/);
  assert.match(h.sent[0], /live-complete/);
  const stopped = await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(stopped.phase, "stopped");
  assert.equal((await fixtureState(h.app)).stop, 1);
  assert.doesNotMatch(await readFile(path.join(h.app, "index.html"), "utf8"), /impeccable-live/);
});

test("lifecycle cleanup owns a missing helper record and permits a clean restart", async (t) => {
  const h = await harness(t);
  let bootCount = 0;
  let stopCount = 0;
  const bridge = new LiveBridge({
    async boot(binding) {
      const helper = { pid: 999_991 + bootCount++, port: 8400 + bootCount, token: `token-${bootCount}` };
      await mkdir(path.join(binding.appRoot, ".impeccable", "live"), { recursive: true });
      await writeFile(path.join(binding.appRoot, ".impeccable", "live", "server.json"), JSON.stringify(helper));
      return { ok: true, serverPort: helper.port, serverToken: helper.token };
    },
    async stop(binding) {
      stopCount++;
      await rm(path.join(binding.appRoot, ".impeccable", "live", "server.json"), { force: true });
    },
  });
  h.trackBridge(bridge);
  await bridge.start(h.input, h.paseo);
  await rm(path.join(h.app, ".impeccable", "live", "server.json"), { force: true });
  assert.equal((await bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" })).phase, "stopped");
  assert.equal(stopCount, 1);
  assert.equal((await bridge.start(h.input, h.paseo)).phase, "running");
  await bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(stopCount, 2);
});

test("lifecycle cleanup surfaces a missing live helper record and retains the active run", async (t) => {
  const h = await harness(t);
  let refuse = true;
  const bridge = new LiveBridge({
    async boot(binding) {
      const helper = { pid: 999_990, port: 8490, token: "retained-token" };
      await mkdir(path.join(binding.appRoot, ".impeccable", "live"), { recursive: true });
      await writeFile(path.join(binding.appRoot, ".impeccable", "live", "server.json"), JSON.stringify(helper));
      return { ok: true, serverPort: helper.port, serverToken: helper.token };
    },
    async stop() { if (refuse) throw new Error("record is missing while its process is still running"); },
  });
  h.trackBridge(bridge);
  await bridge.start(h.input, h.paseo);
  await rm(path.join(h.app, ".impeccable", "live", "server.json"), { force: true });
  await assert.rejects(bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" }), /process is still running/);
  assert.equal(bridge.peek({ workspaceId: "workspace-1", agentId: "agent-1" }).active, true);
  refuse = false;
  await bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("retains an uncertain dispatch and retries only explicitly", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "steer", requestId: "request-2" }, { type: "wait" }]);
  let attempts = 0;
  h.setSend(async (message) => {
    h.sent.push(message);
    if (++attempts === 1) throw new Error("connection dropped");
  });
  await h.bridge.start(h.input, h.paseo);
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "dispatch-paused", "dispatch did not pause");
  const paused = await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.match(paused.pendingEvent ?? "", /request-2/);
  assert.equal((await fixtureState(h.app)).poll, 1);
  const retried = await h.bridge.retry({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(retried.phase, "dispatching");
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).pendingEvent === null, "retry did not finish");
  assert.match(h.sent[1], /explicit retry/i);
  assert.equal(attempts, 2);
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("stop interrupts a hung explicit retry", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "steer", eventId: "retry-stop-event" }]);
  let attempts = 0;
  h.setSend(async (message) => {
    h.sent.push(message);
    if (++attempts === 1) throw new Error("uncertain first delivery");
  });
  await h.bridge.start(h.input, h.paseo);
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "dispatch-paused", "first delivery did not pause");
  h.setWait(async () => new Promise(() => {}));
  const retrying = await h.bridge.retry({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(retrying.phase, "dispatching");
  await waitFor(() => h.sent.length === 2, "retry was not delivered");
  const stopped = await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(stopped.phase, "stopped");
});

test("stop aborts a hung agent completion wait and still cleans up the owned helper", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "generate", eventId: "hung-event" }]);
  h.setWait(async () => new Promise(() => {}));
  await h.bridge.start(h.input, h.paseo);
  await waitFor(() => h.sent.length === 1, "hung event was not sent");
  const stopped = await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(stopped.phase, "stopped");
  assert.equal((await fixtureState(h.app)).stop, 1);
});

test("stop during a blocked dispatch refresh prevents agent send", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "delay", ms: 100, event: { type: "generate", eventId: "refresh-stop-event" } }]);
  await h.bridge.start(h.input, h.paseo);
  h.setRefresh(async () => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const stopped = await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(stopped.phase, "stopped");
  assert.equal(h.sent.length, 0);
});

test("does not repoll until the dispatched agent turn finishes", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "generate", eventId: "gated-event" }, { type: "timeout" }, { type: "wait" }]);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  h.setWait(async () => {
    await gate;
    return { status: "idle", final: null, error: null, lastMessage: null };
  });
  await h.bridge.start(h.input, h.paseo);
  await waitFor(() => h.sent.length === 1, "gated event was not delivered");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fixtureState(h.app)).poll, 1);
  finish();
  await waitFor(async () => (await fixtureState(h.app)).poll >= 2, "polling did not resume after agent completion");
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("retains the event when the agent turn needs permission", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "generate", eventId: "permission-event" }]);
  h.setWait(async () => ({ status: "permission", final: null, error: null, lastMessage: null }));
  await h.bridge.start(h.input, h.paseo);
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "dispatch-paused", "permission did not pause dispatch");
  const paused = await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.match(paused.pendingEvent ?? "", /permission-event/);
  assert.equal((await fixtureState(h.app)).poll, 1);
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("keeps carbonize completion gated and rechecks without resending", async (t) => {
  const h = await harness(t);
  const event = { type: "accept", id: "carbon-session", _completionAck: { ok: true, requiresComplete: true } };
  await setControl(h.app, { events: [event, { type: "wait" }], activeSessions: [{ id: "carbon-session", phase: "accepted" }] });
  await h.bridge.start(h.input, h.paseo);
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "completion-paused", "completion gate did not pause polling");
  assert.equal(h.sent.length, 1);
  assert.equal((await fixtureState(h.app)).poll, 1);
  await setControl(h.app, { events: [{ type: "wait" }], activeSessions: [] });
  const checking = await h.bridge.retry({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(checking.phase, "completion-checking");
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).pendingEvent === null, "completion gate did not clear");
  assert.equal(h.sent.length, 1);
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("serializes concurrent starts and discovers a frontend child", async (t) => {
  const h = await harness(t, { frontend: true });
  const [left, right] = await Promise.all([h.bridge.start(h.input, h.paseo), h.bridge.start(h.input, h.paseo)]);
  assert.equal(left.appRoot, h.app);
  assert.equal(right.appRoot, h.app);
  assert.equal((await fixtureState(h.app)).live, 1);
  await assert.rejects(h.bridge.start({ ...h.input, url: "http://localhost:3000/" }, h.paseo), /different settings/);
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("refuses a foreign or corrupt helper record without stopping it", async (t) => {
  for (const contents of [JSON.stringify({ pid: 9001, port: 9999, token: "foreign-token" }), "not-json"]) {
    const h = await harness(t);
    await mkdir(path.join(h.app, ".impeccable/live"), { recursive: true });
    await writeFile(path.join(h.app, ".impeccable/live/server.json"), contents);
    await assert.rejects(h.bridge.start(h.input, h.paseo), /already exists/);
    assert.equal(await readFile(path.join(h.app, ".impeccable/live/server.json"), "utf8"), contents);
    await assert.rejects(readFile(path.join(h.app, ".fixture-state.json"), "utf8"));
  }
});

test("refuses path escapes, remote URLs, and foreign agents before start", async (t) => {
  const h = await harness(t);
  const outside = await mkdtemp(path.join(tmpdir(), "impeccable-live-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(h.root, "escape"));
  await assert.rejects(h.bridge.start({ ...h.input, appPath: "escape" }, h.paseo), /escapes/);
  await assert.rejects(h.bridge.start({ ...h.input, appPath: outside }, h.paseo), /relative/);
  await assert.rejects(h.bridge.start({ ...h.input, url: "https://localhost:5173/" }, h.paseo), /must use http/);
  await assert.rejects(h.bridge.start({ ...h.input, url: "http://example.com:5173/" }, h.paseo), /must use http/);
  assert.equal((await h.bridge.start({ ...h.input, url: "http://[::1]:5173/" }, h.paseo)).phase, "running");
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  const foreign = await harness(t, { agentWorkspaceId: "workspace-2" });
  await assert.rejects(foreign.bridge.start(foreign.input, foreign.paseo), /belongs to another workspace/);
});

test("refuses to stop a replaced helper", async (t) => {
  const h = await harness(t);
  await h.bridge.start(h.input, h.paseo);
  const serverPath = path.join(h.app, ".impeccable/live/server.json");
  await writeFile(serverPath, JSON.stringify({ pid: 7777, port: 8400, token: "replacement-token" }));
  await assert.rejects(h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" }), /identity changed/);
  assert.equal(JSON.parse(await readFile(serverPath, "utf8")).token, "replacement-token");
  assert.equal((await fixtureState(h.app)).stop, undefined);
});

test("poll failures become bounded public errors without stderr leakage", async (t) => {
  for (const event of [{ type: "invalid" }, { type: "failure" }]) {
    const h = await harness(t);
    await setEvents(h.app, [event]);
    await h.bridge.start(h.input, h.paseo);
    await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "error", "poll error was not surfaced");
    const status = await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" });
    assert.equal(status.message.includes("sensitive fixture stderr"), false);
    await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
  }
});

test("preflight failure leaves a retryable error status instead of starting forever", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.bridge.start({ ...h.input, url: "https://localhost:5173/" }, h.paseo));
  const failed = await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" });
  assert.equal(failed.phase, "error");
  assert.match(failed.message, /must use http/);
  const started = await h.bridge.start(h.input, h.paseo);
  assert.equal(started.phase, "running");
  await h.bridge.stop({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("exit events end the run and remove the owned helper", async (t) => {
  const h = await harness(t);
  await setEvents(h.app, [{ type: "exit" }]);
  await h.bridge.start(h.input, h.paseo);
  await waitFor(async () => (await h.bridge.status({ workspaceId: "workspace-1", agentId: "agent-1" })).phase === "stopped", "exit did not stop the run");
  assert.equal((await fixtureState(h.app)).stop, 1);
});

// Exercise the actual cross-process fixture protocol while a reader polls its state.
test("fixture state remains valid JSON while commands update it", async (t) => {
  const h = await harness(t);
  const statePath = path.join(h.app, ".fixture-state.json");
  await writeFile(statePath, JSON.stringify({ status: 0 }));
  for (let index = 0; index < 20; index++) {
    const child = spawn(process.execPath, [fixtureCli, "live-status"], {
      cwd: h.app, stdio: "ignore", timeout: 5_000, killSignal: "SIGKILL",
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const closed = once(child, "close");
    let reading = true;
    void closed.then(() => { reading = false; }, () => { reading = false; });
    let readError: unknown;
    while (reading) {
      try { JSON.parse(await readFile(statePath, "utf8")); } catch (error) { readError = error; break; }
    }
    const [code] = await closed;
    assert.equal(code, 0);
    if (readError) throw readError;
  }
  assert.equal((await fixtureState(h.app)).status, 20);
});
