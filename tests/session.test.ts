import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { SessionCoordinator } from "../server/session.ts";

const cliFixture = path.resolve("tests/backend-fixture.mjs");
const devFixture = path.resolve("tests/dev-server-fixture.mjs");
type WaitResult = { status: "idle" | "error" | "permission" | "timeout"; final: null; error: string | null; lastMessage: string | null };

async function harness(devArgs: string[], control: Record<string, unknown> = {}, updates?: NonNullable<ConstructorParameters<typeof SessionCoordinator>[0]>["updates"]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-session-")));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "session-fixture", private: true }));
  await writeFile(path.join(root, "PRODUCT.md"), "# Product\n");
  await writeFile(path.join(root, "DESIGN.md"), "# Design\n");
  await mkdir(path.join(root, ".impeccable", "live"), { recursive: true });
  await writeFile(path.join(root, ".impeccable", "live", "config.json"), "{}\n");
  await writeFile(path.join(root, ".fixture-control.json"), JSON.stringify({ events: [{ type: "wait" }], ...control }));
  const sent: string[] = [];
  let send = async (message: string) => { sent.push(message); };
  let wait: () => Promise<WaitResult> = async () => ({ status: "idle", final: null, error: null, lastMessage: null });
  let workspaceRefreshCount = 0;
  let workspaceRefresh = async (_count: number) => ({});
  const agent = {
    workspaceId: null as string | null,
    async refresh() { this.workspaceId = "workspace-1"; return { agent: {} }; },
    async send(message: string) { return send(message); },
    async waitForFinish() { return wait(); },
  };
  let terminalEntries: Array<{ id: string; cwd: string }> = [];
  let terminalLines: string[] = [];
  const workspace = { directory: root, async refresh() { return workspaceRefresh(++workspaceRefreshCount); }, terminals: { async list() { return { entries: terminalEntries, requestId: "test" }; } } };
  const paseo = {
    workspaces: { ref: () => workspace },
    agents: { ref: () => agent },
    terminals: { ref: () => ({ async capture() { return { lines: terminalLines, totalLines: terminalLines.length, terminalId: "test", requestId: "test" }; } }) },
  } as unknown as PaseoApi;
  const coordinator = new SessionCoordinator({ startupMs: 5_000, updates });
  const binding = { workspaceId: "workspace-1", agentId: "agent-1" };
  const input = { ...binding, appPath: ".", command: process.execPath, args: [devFixture, ...devArgs], cliPath: cliFixture };
  return {
    root, sent, paseo, coordinator, binding, input,
    setSend(next: (message: string) => Promise<void>) { send = next; },
    setWait(next: () => Promise<WaitResult>) { wait = next; },
    setWorkspaceRefresh(next: (count: number) => Promise<object>) { workspaceRefresh = next; },
    get workspaceRefreshCount() { return workspaceRefreshCount; },
    setTerminalEvidence(lines: string[]) { terminalEntries = [{ id: "terminal-1", cwd: root }]; terminalLines = lines; },
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

async function externalHtmlServer(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>External</title>");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
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
    const beforeUpdateCheck = h.coordinator.status(h.binding);
    assert.equal((await h.coordinator.checkUpdates({ ...h.binding, attempt: h.coordinator.status(h.binding).attempt, cliPath: cliFixture, appRoot: h.root })).status, "unknown");
    assert.deepEqual(h.coordinator.status(h.binding), beforeUpdateCheck);
    await assert.rejects(h.coordinator.checkUpdates({ workspaceId: "foreign", agentId: "agent-1", attempt: 1, cliPath: cliFixture, appRoot: h.root }), /another workspace or agent/);
    assert.equal(JSON.parse(await readFile(path.join(h.root, ".fixture-state.json"), "utf8")).live, 1);
    assert.throws(() => h.coordinator.status({ workspaceId: "foreign", agentId: "agent-1" }), /another workspace or agent/);
  } finally { await h.close(); }
});

test("a pending update check does not block connection or change readiness", async () => {
  let finish!: (value: { status: "unavailable"; installedVersion: null; latestVersion: null }) => void;
  const pending = new Promise<{ status: "unavailable"; installedVersion: null; latestVersion: null }>(resolve => { finish = resolve; });
  let checked: { cliPath: string | null; appRoot: string; force?: boolean } | undefined;
  const h = await harness(["default", "0", "0"], {}, { check: async input => { checked = input; return pending; } });
  try {
    assert.equal((await h.coordinator.checkUpdates({ ...h.binding, attempt: h.coordinator.status(h.binding).attempt, cliPath: cliFixture, appRoot: h.root })).status, "unknown");
    h.coordinator.inspect(h.input, h.paseo);
    const idle = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "idle", "inspection before update check");
    for (const wrong of [{ attempt: idle.attempt - 1 }, { cliPath: "/other/impeccable" }, { appRoot: "/other/app" }]) {
      assert.equal((await h.coordinator.checkUpdates({ ...h.binding, attempt: idle.attempt, cliPath: cliFixture, appRoot: h.root, ...wrong })).status, "unknown");
      assert.equal(checked, undefined);
    }
    const checking = h.coordinator.checkUpdates({ ...h.binding, force: true, attempt: idle.attempt, cliPath: cliFixture, appRoot: h.root });
    assert.deepEqual(checked, { cliPath: cliFixture, appRoot: h.root, force: true });
    h.coordinator.select({ ...h.binding, attempt: idle.attempt, selectionId: "launch" });
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "connect while update check is pending");
    assert.equal(ready.helperReadinessError, null);
    assert.equal(ready.session.active, true);
    finish({ status: "unavailable", installedVersion: null, latestVersion: null });
    assert.equal((await checking).status, "unavailable");
    assert.equal(h.coordinator.status(h.binding).phase, "ready");
  } finally {
    finish({ status: "unavailable", installedVersion: null, latestVersion: null });
    await h.close();
  }
});

test("read-only inspection discovers a launch without starting the development server or helper", async () => {
  const h = await harness(["default", "0", "0"]);
  try {
    const inspecting = h.coordinator.inspect(h.input, h.paseo);
    assert.equal(inspecting.phase, "discovering");
    const idle = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "idle", "read-only inspection");
    assert.deepEqual(idle.choices.map(choice => [choice.id, choice.kind]), [["launch", "launch"]]);
    assert.equal(idle.development.ownership, "none");
    assert.equal(idle.development.appRoot, h.root);
    assert.equal(idle.development.command?.includes(process.execPath), true);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));

    h.coordinator.select({ ...h.binding, attempt: idle.attempt, selectionId: "launch" });
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "explicit launch after inspection");
    assert.equal(ready.development.ownership, "owned");
    assert.equal(ready.session.active, true);
  } finally { await h.close(); }
});

test("inspection identifies an associated external server but connects only after explicit selection", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.inspect({ ...h.input, url: external.url }, h.paseo);
    const choice = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "external reuse choice");
    assert.equal(choice.development.ownership, "none");
    assert.equal(choice.choices[0]?.kind, "reuse");
    assert.equal(choice.choices[0]?.associated, true);
    assert.equal(choice.choices[0]?.recommended, true);
    assert.equal(choice.choices.at(-1)?.kind, "launch");
    assert.equal(choice.choices.at(-1)?.recommended, false);
    assert.equal(choice.choices[0]?.label, `Reuse ${external.url}`);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));

    h.coordinator.select({ ...h.binding, attempt: choice.attempt, selectionId: choice.choices[0]!.id });
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "external connection");
    assert.equal(ready.development.ownership, "external");
    assert.equal(ready.development.url, external.url);
    assert.equal(ready.session.active, true);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("starting another server never attributes an explicit external URL to the owned process", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.inspect({ ...h.input, url: external.url }, h.paseo);
    const choices = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "external and launch choices");
    assert(choices.choices.some(choice => choice.id === "launch"));
    h.coordinator.select({ ...h.binding, attempt: choices.attempt, selectionId: "launch" });
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "owned server chosen over external");
    assert.equal(ready.development.ownership, "owned");
    assert(ready.development.pid);
    assert.notEqual(ready.development.url, external.url);
    assert.equal((await fetch(ready.development.url!)).status, 200);
    assert.equal((await fetch(external.url)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("terminal output associates a responder while a framework default alone stays unassociated", async () => {
  const port = await freePort();
  const external = await externalHtmlServer(port);
  const h = await harness(["default", "0", "0"]);
  const discoveredInput = { ...h.input, command: undefined, args: undefined };
  try {
    await writeFile(path.join(h.root, "package.json"), JSON.stringify({ scripts: { dev: `vite --port ${port}` } }));
    h.coordinator.inspect(discoveredInput, h.paseo);
    const frameworkDefault = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "framework-default responder");
    assert.equal(frameworkDefault.choices.find(choice => choice.kind === "reuse")?.associated, false);
    assert.equal(frameworkDefault.choices.find(choice => choice.kind === "reuse")?.recommended, false);

    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "inspection reset");
    h.setTerminalEvidence([`Local: http://localhost:${port}/`]);
    h.coordinator.inspect(discoveredInput, h.paseo);
    const associated = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "terminal-associated responder");
    assert.equal(associated.choices.find(choice => choice.kind === "reuse")?.associated, true);
    assert.equal(associated.choices.find(choice => choice.kind === "reuse")?.recommended, true);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("inspection reports helper readiness separately while still discovering an existing server", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    await rm(path.join(h.root, "DESIGN.md"));
    h.coordinator.inspect({ ...h.input, url: external.url, cliPath: path.join(h.root, "missing-impeccable") }, h.paseo);
    const inspected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "server discovery with missing setup");
    assert.match(inspected.helperReadinessError ?? "", /setup is incomplete.*DESIGN\.md/i);
    assert.match(inspected.dependencyReadiness?.checks.find(check => check.id === "installation")?.detail ?? "", /unavailable/i);
    const reuse = inspected.choices.find(choice => choice.kind === "reuse");
    assert(reuse);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));

    h.coordinator.select({ ...h.binding, attempt: inspected.attempt, selectionId: reuse.id });
    const failed = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "connection blocked by helper readiness");
    assert.match(failed.helperReadinessError ?? "", /DESIGN\.md/);
    assert.equal(failed.development.ownership, "none");
    assert.equal((await fetch(external.url)).status, 200);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("inspection keeps server choices visible when another Impeccable helper already exists", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    await writeFile(path.join(h.root, ".impeccable", "live", "server.json"), JSON.stringify({ pid: 4242, port: 8400, token: "existing-token" }));
    h.coordinator.inspect({ ...h.input, url: external.url }, h.paseo);
    const inspected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "server choice despite existing helper");
    assert.match(inspected.helperReadinessError ?? "", /helper already exists/i);
    assert(inspected.choices.some(choice => choice.kind === "reuse"));
    assert.equal(inspected.development.ownership, "none");
    assert.equal((await fetch(external.url)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("choosing a discovered target is the explicit connect action", async () => {
  const h = await harness(["default", "0", "0"]);
  const app = path.join(h.root, "app-one");
  try {
    await mkdir(app);
    await writeFile(path.join(app, "package.json"), "{}\n");
    h.coordinator.inspect({ ...h.input, appPath: undefined }, h.paseo);
    const choices = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "target choices");
    const target = choices.choices.find(choice => choice.kind === "target" && choice.label.startsWith("app-one"));
    assert(target);
    await assert.rejects(readFile(path.join(app, ".fixture-state.json")));

    h.coordinator.select({ ...h.binding, attempt: choices.attempt, selectionId: target.id });
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "selected target connected");
    assert.equal(ready.development.appRoot, app);
    assert.equal(ready.session.active, true);
  } finally { await h.close(); }
});

test("keeps a monorepo launch at the root while explicitly targeting its unique frontend helper", async () => {
  const h = await harness(["default", "0", "0"]);
  const frontend = path.join(h.root, "frontend");
  try {
    await rm(path.join(h.root, ".impeccable"), { recursive: true, force: true });
    await mkdir(frontend);
    await writeFile(path.join(frontend, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(frontend, "PRODUCT.md"), "# Frontend product\n");
    await writeFile(path.join(frontend, "DESIGN.md"), "# Frontend design\n");
    await mkdir(path.join(frontend, ".impeccable", "live"), { recursive: true });
    await writeFile(path.join(frontend, ".impeccable", "live", "config.json"), "{}\n");
    await writeFile(path.join(frontend, ".fixture-control.json"), JSON.stringify({ requireTarget: true, events: [{ type: "wait" }] }));
    h.coordinator.start(h.input, h.paseo);
    const first = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready" || state.phase === "selection-required", "monorepo startup or existing-server choice");
    if (first.phase === "selection-required") {
      assert(first.choices.some(choice => choice.id === "launch"));
      h.coordinator.select({ ...h.binding, attempt: first.attempt, selectionId: "launch" });
    }
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "monorepo frontend ready");
    assert.equal(ready.development.appRoot, h.root, "root command cwd must not be replaced by the frontend folder");
    assert.equal(ready.development.previewRoot, frontend, "preview app identity must remain distinct from the launch directory");
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

test("cancel aborts the second prelaunch workspace refresh", async () => {
  const h = await harness(["default", "0", "0"]);
  h.setWorkspaceRefresh(async count => count === 1 ? {} : new Promise(() => {}));
  try {
    h.coordinator.start(h.input, h.paseo);
    await eventually(() => h.workspaceRefreshCount, count => count >= 2, "second workspace refresh started");
    h.coordinator.stopSession(h.binding);
    const stopped = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "prelaunch refresh cancellation");
    assert.equal(stopped.development.ownership, "none");
    assert.equal(stopped.session.active, false);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
  } finally { await h.close(); }
});

test("cancel aborts a postlaunch workspace refresh and cleans the owned development process", async () => {
  const h = await harness(["default", "0", "0"]);
  h.setWorkspaceRefresh(async count => count < 3 ? {} : new Promise(() => {}));
  try {
    h.coordinator.start(h.input, h.paseo);
    const launched = await eventually(() => h.coordinator.status(h.binding), state =>
      h.workspaceRefreshCount >= 3 && state.development.ownership === "owned" && state.development.verified,
    "owned server before postlaunch refresh cancellation");
    const url = launched.development.url!;
    h.coordinator.stopDevelopment(h.binding);
    const stopped = await eventually(() => h.coordinator.status(h.binding), state =>
      state.phase === "stopped" && state.development.phase === "stopped",
    "postlaunch refresh cleanup");
    assert.equal(stopped.development.ownership, "none");
    assert.equal(stopped.session.active, false);
    await assert.rejects(fetch(url));
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

test("read-only target switching clears stale external metadata without stopping the external server", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"]);
  try {
    h.coordinator.start({ ...h.input, url: external.url }, h.paseo);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "external connected");
    h.coordinator.stopSession(h.binding);
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "stopped", "external session stopped");

    const second = path.join(h.root, "second-app");
    await mkdir(second);
    await writeFile(path.join(second, "package.json"), "{}\n");
    h.coordinator.inspect({ ...h.input, appPath: "second-app", url: "" }, h.paseo);
    const inspected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "idle", "second target inspected");
    assert.equal(inspected.development.ownership, "none");
    assert.equal(inspected.development.appRoot, second);
    assert.equal(inspected.development.previewRoot, second);
    assert.equal(inspected.development.url, null);
    assert.equal((await fetch(external.url)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>(resolve => external.server.close(() => resolve()));
  }
});

test("explicit start rechecks edited target readiness before launching a development process", async () => {
  const h = await harness(["default", "0", "0"]);
  const app = path.join(h.root, "edited-app");
  try {
    await mkdir(app);
    await writeFile(path.join(app, "package.json"), "{}\n");
    await rm(path.join(h.root, "DESIGN.md"));
    h.coordinator.start({ ...h.input, appPath: "edited-app" }, h.paseo);
    const failed = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "edited target readiness failure");
    assert.match(failed.helperReadinessError ?? "", /DESIGN\.md/);
    assert.equal(failed.development.ownership, "none");
    assert.equal(failed.development.pid, null);
    await assert.rejects(readFile(path.join(app, ".fixture-state.json")));
  } finally { await h.close(); }
});

test("connect rejects a development script that becomes mutating after inspection", async () => {
  const h = await harness(["default", "0", "0"]);
  const automatic = { ...h.input, command: undefined, args: undefined };
  try {
    await writeFile(path.join(h.root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    h.coordinator.inspect(automatic, h.paseo);
    const inspected = await eventually(() => h.coordinator.status(h.binding), state =>
      (state.phase === "idle" || state.phase === "selection-required") && state.choices.some(choice => choice.id === "launch"),
    "safe script inspected");

    await writeFile(path.join(h.root, "package.json"), JSON.stringify({ scripts: { predev: "npm install", dev: "vite" } }));
    h.coordinator.select({ ...h.binding, attempt: inspected.attempt, selectionId: "launch" });
    const rejected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "mutating script rejected");
    assert.match(rejected.message, /changed after discovery|unsafe/i);
    assert.equal(rejected.development.ownership, "none");
    assert.equal(rejected.development.pid, null);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
  } finally { await h.close(); }
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
    await eventually(async () => readFile(path.join(h.root, ".fixture-state.json"), "utf8").then(value => JSON.parse(value).live === 1, () => false), value => value, "fixture boot entered");
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

test("missing engine blocks app startup and rechecking after repair enables connection", async () => {
  const h = await harness(["default", "0", "0"], { engineError: "Engine not cached; token=private-value" });
  try {
    h.coordinator.start(h.input, h.paseo);
    const blocked = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "engine preflight rejection");
    assert.equal(blocked.development.ownership, "none");
    assert(blocked.dependencyReadiness?.checks.some(check => check.id === "engine" && check.status === "blocked"));
    assert(!JSON.stringify(blocked).includes("private-value"));
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
    await writeFile(path.join(h.root, ".fixture-control.json"), JSON.stringify({ events: [{ type: "wait" }] }));
    h.coordinator.inspect(h.input, h.paseo);
    const repaired = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "idle", "repaired dependency inspection");
    assert.equal(repaired.helperReadinessError, null);
    assert.equal(repaired.dependencyReadiness?.engineVersion, "4.8.0");
    assert(repaired.dependencyReadiness?.checks.some(check => check.id === "compatibility" && check.status === "warning"));
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
    h.coordinator.start(h.input, h.paseo);
    const connected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "connection after engine repair");
    assert.equal(connected.session.active, true);
    assert.equal(connected.development.ownership, "owned");
  } finally { await h.close(); }
});

test("engine failure leaves an external preview running and prevents helper boot", async () => {
  const external = await externalHtmlServer();
  const h = await harness(["default", "0", "0"], { engineError: "Engine unavailable" });
  try {
    h.coordinator.inspect({ ...h.input, url: external.url }, h.paseo);
    const inspected = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "selection-required", "external preview with unavailable engine");
    assert(inspected.dependencyReadiness?.checks.some(check => check.id === "engine" && check.status === "blocked"));
    const reuse = inspected.choices.find(choice => choice.kind === "reuse")!;
    h.coordinator.select({ ...h.binding, attempt: inspected.attempt, selectionId: reuse.id });
    await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "external connection engine rejection");
    assert.equal((await fetch(external.url)).status, 200);
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
    await h.coordinator.stopSession(h.binding);
    assert.equal((await fetch(external.url)).status, 200);
  } finally { await h.close(); await new Promise<void>(resolve => external.server.close(() => resolve())); }
});


test("project-local launcher requires explicit selection before probing or starting the app", async () => {
  const h = await harness(["default", "0", "0"]);
  try {
    const launcher = path.join(h.root, ".agents/skills/impeccable/scripts/impeccable");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, await readFile(cliFixture));
    await chmod(launcher, 0o755);
    const input = { ...h.input, cliPath: undefined };
    h.coordinator.start(input, h.paseo);
    const blocked = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "error", "unselected project launcher");
    assert.equal(blocked.dependencyReadiness?.cliPath, launcher);
    assert.equal(blocked.dependencyReadiness?.engineVersion, null);
    assert.equal(blocked.development.ownership, "none");
    await assert.rejects(readFile(path.join(h.root, ".fixture-state.json")));
    h.coordinator.start({ ...input, cliPath: launcher }, h.paseo);
    const ready = await eventually(() => h.coordinator.status(h.binding), state => state.phase === "ready", "explicitly selected project launcher");
    assert.equal(ready.dependencyReadiness?.engineVersion, "4.8.0");
    assert.equal(ready.session.active, true);
  } finally { await h.close(); }
});
