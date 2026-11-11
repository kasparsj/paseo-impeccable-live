import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { SessionCoordinator } from "../server/session.ts";

const cliFixture = path.resolve("tests/backend-fixture.mjs");
const devFixture = path.resolve("tests/dev-server-fixture.mjs");
type WaitResult = { status: "idle" | "error" | "permission" | "timeout"; final: null; error: string | null; lastMessage: string | null };

async function harness(devArgs: string[], control: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-session-")));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "session-fixture", private: true }));
  await writeFile(path.join(root, ".fixture-control.json"), JSON.stringify({ events: [{ type: "wait" }], ...control }));
  const sent: string[] = [];
  let send = async (message: string) => { sent.push(message); };
  let wait: () => Promise<WaitResult> = async () => ({ status: "idle", final: null, error: null, lastMessage: null });
  const agent = {
    workspaceId: null as string | null,
    async refresh() { this.workspaceId = "workspace-1"; return { agent: {} }; },
    async send(message: string) { return send(message); },
    async waitForFinish() { return wait(); },
  };
  const workspace = { directory: root, async refresh() { return {}; }, terminals: { async list() { return { entries: [], requestId: "test" }; } } };
  const paseo = {
    workspaces: { ref: () => workspace },
    agents: { ref: () => agent },
    terminals: { ref: () => ({ async capture() { return { lines: [], totalLines: 0, terminalId: "test", requestId: "test" }; } }) },
  } as unknown as PaseoApi;
  const coordinator = new SessionCoordinator({ startupMs: 5_000 });
  const binding = { workspaceId: "workspace-1", agentId: "agent-1" };
  const input = { ...binding, appPath: ".", command: process.execPath, args: [devFixture, ...devArgs], cliPath: cliFixture };
  return {
    root, sent, paseo, coordinator, binding, input,
    setSend(next: (message: string) => Promise<void>) { send = next; },
    setWait(next: () => Promise<WaitResult>) { wait = next; },
    async close() { await coordinator.shutdown().catch(() => undefined); await rm(root, { recursive: true, force: true }); },
  };
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 7_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function externalHtmlServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>External</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

test("starts asynchronously, stays responsive, deduplicates Start, and boots helper after HTTP readiness", async () => {
  const h = await harness(["default", "0", "250"]);
  try {
    const initial = h.coordinator.start(h.input, h.paseo);
    assert.equal(initial.attempt, 1);
    const duplicate = h.coordinator.start(h.input, h.paseo);
    assert.equal(duplicate.attempt, 1);
    assert.notEqual(h.coordinator.status(h.binding).phase, "ready");
    const earlyState = await readFile(path.join(h.root, ".fixture-state.json"), "utf8").catch(() => "{}");
    assert.equal(JSON.parse(earlyState).live, undefined);
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "coordinator ready");
    assert.equal(ready.development.verified, true);
    assert.equal(ready.session.active, true);
    assert.equal(JSON.parse(await readFile(path.join(h.root, ".fixture-state.json"), "utf8")).live, 1);
    assert.throws(() => h.coordinator.status({ workspaceId: "foreign", agentId: "agent-1" }), /another workspace or agent/);
  } finally { await h.close(); }
});

test("keeps a monorepo launch at the root while explicitly targeting its unique frontend helper", async () => {
  const h = await harness(["default", "0", "0"]);
  const frontend = path.join(h.root, "frontend");
  try {
    await mkdir(frontend);
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(frontend, ".fixture-control.json"), JSON.stringify({ requireTarget: true, events: [{ type: "wait" }] }));
    h.coordinator.start(h.input, h.paseo);
    const first = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready" || state.phase === "selection-required", "monorepo startup or existing-server choice");
    if (first.phase === "selection-required") {
      assert(first.choices.some(choice => choice.id === "launch"));
      h.coordinator.select({ ...h.binding, attempt: first.attempt, selectionId: "launch" });
    }
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "monorepo frontend ready");
    assert.equal(ready.development.appRoot, h.root, "root command cwd must not be replaced by the frontend folder");
    assert.equal(ready.session.appRoot, frontend);
    assert.equal(ready.session.url, ready.development.url, "the actual emitted fallback URL must survive the target handoff");
    assert.deepEqual(JSON.parse(await readFile(path.join(frontend, ".fixture-boot-args.json"), "utf8")), ["live", "--target", frontend]);
    await assert.rejects(readFile(path.join(h.root, ".impeccable/live/server.json")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(frontend, ".fixture-state.json"), "utf8")).live, 1);
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "frontend helper stopped");
    assert.equal((await fetch(ready.development.url!)).status, 200);
    await assert.rejects(readFile(path.join(frontend, ".impeccable/live/server.json")), { code: "ENOENT" });
    h.coordinator.stopDevelopment(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.development.phase === "stopped", "root development process stopped");
  } finally { await h.close(); }
});

test("discovery can be canceled while the workspace SDK call is still pending", async () => {
  const h = await harness(["default", "0", "0"]);
  const workspace = h.paseo.workspaces.ref("workspace-1");
  workspace.refresh = async () => new Promise(() => {});
  try {
    const starting = h.coordinator.start(h.input, h.paseo);
    assert.equal(starting.phase, "discovering");
    assert.equal(starting.development.phase, "discovering");
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "canceled discovery");
    assert.equal(h.coordinator.status(h.binding).development.ownership, "none");
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
  } finally { await h.close(); }
});

test("canceling helper startup against an external server leaves the external app running", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"], { bootDelayMs: 300 });
  try {
    h.coordinator.start({ ...h.input, url: external.url }, h.paseo);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "starting-impeccable", "external helper boot");
    assert.equal(h.coordinator.status(h.binding).development.ownership, "external");
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "external helper cancellation");
    assert.equal((await fetch(external.url)).status, 200);
    assert.equal(h.coordinator.status(h.binding).session.active, false);
    await assert.rejects(readFile(path.join(h.root, ".impeccable/live/server.json")));
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("a stopped integration can bind a new agent without exposing the previous agent's logs or helper status", async () => {
  const h = await harness(["default", "0", "0"]);
  const next = { ...h.input, agentId: "agent-2" };
  try {
    h.coordinator.start(h.input, h.paseo);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "first agent ready");
    assert(h.coordinator.logs(h.binding).lines.length > 0);
    h.coordinator.stopDevelopment(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "first agent stopped");
    const starting = h.coordinator.start(next, h.paseo);
    assert.equal(starting.session.appRoot, null);
    assert.equal(starting.session.url, null);
    assert.equal(h.coordinator.logs(next).lines.length, 0);
    assert.throws(() => h.coordinator.logs(h.binding), /another workspace or agent/);
    h.coordinator.stopDevelopment(next);
    await eventually(() => h.coordinator.status(next), state => state.phase === "stopped", "new binding stopped");
  } finally { await h.close(); }
});

test("Stop session preserves the owned development server; Stop development server then removes it", async () => {
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.start(h.input, h.paseo);
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "ready");
    const url = ready.development.url!;
    h.coordinator.stopSession(h.binding);
    const sessionStopped = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "session stop");
    assert.equal(sessionStopped.session.active, false);
    assert.equal(sessionStopped.development.ownership, "owned");
    assert.equal((await fetch(url)).status, 200);
    h.coordinator.stopDevelopment(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped" && state.development.phase === "stopped", "development stop");
    await assert.rejects(fetch(url));
  } finally { await h.close(); }
});

test("reuses an explicit external URL and never stops that server", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.start({ ...h.input, url: external.url }, h.paseo);
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "external ready");
    assert.equal(ready.development.ownership, "external");
    assert.throws(() => h.coordinator.stopDevelopment(h.binding), /started outside/);
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "external session stop");
    assert.equal((await fetch(external.url)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>((resolve, reject) => external.server.close(error => error ? reject(error) : resolve()));
  }
});

test("changing app folders never silently carries an external-server association to the new app", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.start({ ...h.input, url: external.url }, h.paseo);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "first external app");
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "first helper stopped");
    const nextRoot = path.join(h.root, "second-app");
    await mkdir(nextRoot);
    await writeFile(path.join(nextRoot, "package.json"), "{}");
    h.coordinator.start({ ...h.input, appPath: "second-app" }, h.paseo);
    const next = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "second app");
    assert.equal(next.development.ownership, "owned");
    assert.notEqual(next.development.url, external.url);
    assert.equal(next.development.appRoot, nextRoot);
    assert.equal(next.session.appRoot, nextRoot);
    assert.equal((await fetch(external.url)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("helper startup failure leaves the verified development server running for retry", async () => {
  const h = await harness(["default", "0", "0"], { bootError: "fixture setup missing" });
  try {
    h.coordinator.start(h.input, h.paseo);
    const failed = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "helper failure");
    assert.equal(failed.development.verified, true);
    assert.equal(failed.development.ownership, "owned");
    assert.equal((await fetch(failed.development.url!)).status, 200);
    assert.equal(failed.session.active, false);
  } finally { await h.close(); }
});

test("Stop during delayed helper boot cleans the late helper and owned development process", async () => {
  const h = await harness(["default", "0", "0"], { bootDelayMs: 2300 });
  try {
    h.coordinator.start(h.input, h.paseo);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "starting-impeccable", "helper boot start");
    h.coordinator.stopDevelopment(h.binding);
    const stopped = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped" && state.development.phase === "stopped", "late boot cleanup", 8_000);
    assert.equal(stopped.session.active, false);
    await assert.rejects(readFile(path.join(h.root, ".impeccable/live/server.json")));
    assert.equal(JSON.parse(await readFile(path.join(h.root, ".fixture-state.json"), "utf8")).stop, 1);
  } finally { await h.close(); }
});

test("resumes on a fallback port without losing the helper or retained event", async () => {
  const port = await freePort();
  const h = await harness(["fallback", String(port), "0"], { events: [{ type: "steer", requestId: "retained-event" }, { type: "wait" }] });
  let blocker: Server | null = null;
  try {
    h.setSend(async message => { h.sent.push(message); throw new Error("uncertain delivery"); });
    h.coordinator.start(h.input, h.paseo);
    const paused = await eventually(() => h.coordinator.status(h.binding), state => state.session.phase === "dispatch-paused", "retained event");
    assert.match(paused.session.pendingEvent ?? "", /retained-event/);
    const firstUrl = paused.development.url!;
    const helperBefore = await readFile(path.join(h.root, ".impeccable/live/server.json"), "utf8");
    assert(paused.development.pid);
    process.kill(paused.development.pid, "SIGTERM");
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error" && !state.development.verified, "development crash");
    blocker = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Blocker</title>"); });
    await new Promise<void>((resolve) => blocker!.listen(port, "127.0.0.1", resolve));
    h.coordinator.start(h.input, h.paseo);
    const resumed = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "fallback resume");
    assert.notEqual(resumed.development.url, firstUrl);
    assert.equal(resumed.session.phase, "dispatch-paused");
    assert.match(resumed.session.pendingEvent ?? "", /retained-event/);
    assert.equal(await readFile(path.join(h.root, ".impeccable/live/server.json"), "utf8"), helperBefore);
    assert.equal(h.sent.length, 1);
  } finally {
    await h.close();
    if (blocker) await new Promise<void>((resolve, reject) => blocker!.close(error => error ? reject(error) : resolve()));
  }
});
