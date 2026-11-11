import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DevelopmentTarget } from "../server/dev-discovery.ts";
import { DevelopmentLog, DevelopmentServer, ProbeError, extractLocalUrls, probeLocalUrl, redactLog } from "../server/dev-server.ts";

const fixture = path.resolve("tests/dev-server-fixture.mjs");

function response(status = 200, headers: Record<string, string> = { "content-type": "text/html" }, body: ConstructorParameters<typeof Response>[0] = "<html>ok</html>"): Response {
  return new Response(body, { status, headers });
}

async function withFetch<T>(implementation: typeof fetch, operation: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await operation(); }
  finally { globalThis.fetch = original; }
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Missing fixture port."));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function target(root: string, mode: string, port = 0, delay = 0, expectedUrls: string[] = []): DevelopmentTarget {
  const args = [fixture, mode, String(port), String(delay)];
  return { id: `${mode}-${port}-${delay}`, appRoot: root, appPath: ".", command: process.execPath, args,
    displayCommand: `${process.execPath} ${args.join(" ")}`, manager: "custom", script: null, evidence: ["test fixture"], expectedUrls };
}

test("validates every redirect before requesting it and caps redirect chains", async () => {
  const requested: string[] = [];
  await withFetch(async (input) => {
    const url = String(input);
    requested.push(url);
    return response(302, { location: "https://example.com/private" }, null);
  }, async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), /localhost|local HTTP/);
  });
  assert.deepEqual(requested, ["http://localhost:4100/"]);

  let redirects = 0;
  await withFetch(async () => {
    redirects++;
    return response(302, { location: `/next-${redirects}` }, null);
  }, async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), /excessive redirect/);
  });
  assert.equal(redirects, 6);
});

test("classifies authentication, non-HTML, timeout, empty and failed responses", async () => {
  await withFetch(async () => response(401), async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), (error: unknown) => error instanceof ProbeError && error.permanent && /authentication/.test(error.message));
  });
  await withFetch(async () => response(200, { "content-type": "application/json" }, "{}"), async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), (error: unknown) => error instanceof ProbeError && error.permanent && /HTML/.test(error.message));
  });
  await withFetch(async () => response(503), async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), (error: unknown) => error instanceof ProbeError && !error.permanent && /503/.test(error.message));
  });
  await withFetch(async () => response(200, { "content-type": "text/html" }, ""), async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/"), /empty page/);
  });
  await withFetch((_input, init) => new Promise((_resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("probe timeout signal did not fire")), 250);
    init?.signal?.addEventListener("abort", () => { clearTimeout(guard); reject(new Error("aborted")); }, { once: true });
  }), async () => {
    await assert.rejects(probeLocalUrl("http://localhost:4100/", undefined, 20), /timeout|aborted/i);
  });
});

test("bounds HTML reads and accepts a non-empty page", async () => {
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { canceled = true; },
  });
  await withFetch(async () => response(200, { "content-type": "text/html" }, body as unknown as NonNullable<ConstructorParameters<typeof Response>[0]>), async () => {
    assert.equal(await probeLocalUrl("http://localhost:4100/"), "http://localhost:4100/");
  });
  assert(pulls <= 6, `expected a bounded read, received ${pulls} pulls`);
  assert.equal(canceled, true);
});

test("extracts ANSI-wrapped loopback, wildcard and IPv6 URLs only", () => {
  assert.deepEqual(extractLocalUrls("\u001b[32mLocal http://0.0.0.0:5173/app\u001b[0m and http://[::1]:4173/ plus https://localhost:9 and http://example.com:3/"), [
    "http://127.0.0.1:5173/app", "http://[::1]:4173/",
  ]);
});

test("bounds log bytes and lines, tracks cursors, and strips controls and secrets", () => {
  const logs = new DevelopmentLog();
  logs.beginAttempt(7);
  logs.append("stdout", "\u001b[31mhello\u001b[0m token=super-secret http://u:p@localhost:4000/?api_key=abc\n");
  const first = logs.read();
  assert.equal(first.lines.length, 1);
  assert.equal(first.attempt, 7);
  assert.equal(first.lines[0].attempt, 7);
  assert.doesNotMatch(first.lines[0].text, /super-secret|u:p|api_key=abc|\u001b/);
  assert.match(first.lines[0].text, /token=\[redacted\]/);
  assert.match(first.lines[0].text, /api_key=\[redacted\]/);
  const cursor = first.cursor;
  for (let index = 0; index < 550; index++) logs.append("stderr", `${index}-${"x".repeat(400)}`);
  const bounded = logs.read(cursor);
  assert(bounded.lines.length <= 500);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.reset, true);
  assert(Buffer.byteLength(bounded.lines.map((line) => line.text).join("")) <= 128 * 1024);
  assert.equal(logs.read(Number.MAX_SAFE_INTEGER).reset, true);
  assert.doesNotMatch(redactLog("secret: value\u0000\u001b[2J"), /value|\u0000|\u001b/);
});

test("labels retained development output with its originating attempt", () => {
  const logs = new DevelopmentLog();
  logs.beginAttempt(1);
  logs.append("system", "first attempt");
  logs.beginAttempt(2);
  logs.append("system", "current attempt");
  const result = logs.read();
  assert.equal(result.attempt, 2);
  assert.deepEqual(result.lines.map(line => [line.attempt, line.text]), [[1, "first attempt"], [2, "current attempt"]]);
});

test("starts a delayed real server from split ANSI output and stops its owned process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-start-"));
  const changed: string[] = [];
  const server = new DevelopmentServer(() => changed.push("changed"), 3_000);
  try {
    const result = await server.startOwned(target(root, "serve", 0, 100), undefined, new AbortController().signal);
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(server.snapshot().verified, true);
    assert(server.logs.read().lines.some((line) => line.text.includes("Local:")));
    assert(changed.length > 1);
    await server.stop();
    assert.equal(server.snapshot().phase, "stopped");
  } finally {
    await server.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a fallback port without disturbing an occupied listener", async () => {
  const blocker = createServer((_request, result) => { result.setHeader("content-type", "text/plain"); result.end("blocker"); });
  const occupied = await listen(blocker);
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-fallback-"));
  const development = new DevelopmentServer(undefined, 3_000);
  try {
    const result = await development.startOwned(target(root, "fallback", occupied), undefined, new AbortController().signal);
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") assert.notEqual(new URL(result.url).port, String(occupied));
    assert.equal(await fetch(`http://127.0.0.1:${occupied}/`).then((reply) => reply.text()), "blocker");
    await development.stop();
    assert.equal(await fetch(`http://127.0.0.1:${occupied}/`).then((reply) => reply.text()), "blocker");
  } finally {
    await development.shutdown().catch(() => undefined);
    await close(blocker);
    await rm(root, { recursive: true, force: true });
  }
});

test("never treats a framework default URL as proof that an owned silent child serves it", async () => {
  const decoy = createServer((_request, reply) => { reply.setHeader("content-type", "text/html"); reply.end("<html>unrelated</html>"); });
  const port = await listen(decoy);
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-decoy-"));
  const development = new DevelopmentServer(undefined, 200);
  const silent = { ...target(root, "silent"), args: ["-e", "setInterval(() => {}, 1000)"], expectedUrls: [`http://127.0.0.1:${port}/`] };
  try {
    await assert.rejects(development.startOwned(silent, undefined, new AbortController().signal), /did not become ready|No local URL/);
    assert.equal(development.snapshot().verified, false);
    assert.equal(await fetch(silent.expectedUrls[0]).then(reply => reply.text()), "<html>unrelated</html>");
  } finally {
    await development.shutdown().catch(() => undefined);
    await close(decoy);
    await rm(root, { recursive: true, force: true });
  }
});

test("reports strict occupied-port failure and child exit", async () => {
  const blocker = createServer((_request, result) => { result.setHeader("content-type", "text/html"); result.end("<html>blocker</html>"); });
  const occupied = await listen(blocker);
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-strict-"));
  const development = new DevelopmentServer(undefined, 2_000);
  try {
    await assert.rejects(development.startOwned(target(root, "serve", occupied), undefined, new AbortController().signal), /exited/);
    assert.equal(development.snapshot().phase, "error");
    assert.equal(await fetch(`http://127.0.0.1:${occupied}/`).then((reply) => reply.text()), "<html>blocker</html>");
  } finally {
    await development.shutdown().catch(() => undefined);
    await close(blocker);
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels delayed startup promptly and allows explicit owned cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-cancel-"));
  const development = new DevelopmentServer(undefined, 5_000);
  const controller = new AbortController();
  try {
    const startup = development.startOwned(target(root, "serve", 0, 2_000), undefined, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(startup, /abort|cancel/i);
    await development.stop();
    assert.equal(development.snapshot().phase, "stopped");
  } finally {
    await development.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces an immediate development child exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-server-exit-"));
  const development = new DevelopmentServer(undefined, 2_000);
  try {
    await assert.rejects(development.startOwned(target(root, "exit"), undefined, new AbortController().signal), /exited/);
    assert.equal(development.snapshot().verified, false);
    assert.match(development.snapshot().message, /exited/);
  } finally {
    await development.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
