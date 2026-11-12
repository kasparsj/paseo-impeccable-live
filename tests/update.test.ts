import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { UpdateChecker } from "../server/update.ts";

async function fixture(frontmatter?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "impeccable-update-"));
  const appRoot = path.join(root, "app");
  const skill = path.join(root, "skill");
  const cliPath = path.join(skill, "scripts", "impeccable");
  await Promise.all([mkdir(appRoot, { recursive: true }), mkdir(path.dirname(cliPath), { recursive: true })]);
  await writeFile(cliPath, "#!/bin/sh\nexit 0\n");
  await chmod(cliPath, 0o755);
  if (frontmatter !== undefined) await writeFile(path.join(skill, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`);
  await writeFile(path.join(skill, "scripts", "VERSION"), "99.0.0\n");
  return { root, appRoot, cliPath, close: () => rm(root, { recursive: true, force: true }) };
}

const response = (skills: unknown, init?: ResponseInit) => new Response(JSON.stringify({ skills }), {
  status: 200, headers: { "content-type": "application/json" }, ...init,
});

test("reads selected skill metadata version instead of the engine VERSION", async () => {
  const f = await fixture("name: impeccable\nmetadata:\n  version: 4.8.0");
  try {
    const checker = new UpdateChecker(async () => response("4.8.2"));
    assert.deepEqual(await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot }), {
      status: "available", installedVersion: "4.8.0", latestVersion: "4.8.2",
    });
  } finally { await f.close(); }
});

test("supports legacy frontmatter versions and quoted metadata versions", async () => {
  const legacy = await fixture("name: impeccable\nversion: 4.8.2");
  const metadata = await fixture("name: impeccable\nversion: 1.0.0\nmetadata:\n  version: '4.8.2'");
  try {
    const checker = new UpdateChecker(async () => response("4.8.2"));
    assert.equal((await checker.check({ cliPath: legacy.cliPath, appRoot: legacy.appRoot })).status, "current");
    assert.equal((await checker.check({ cliPath: metadata.cliPath, appRoot: metadata.appRoot })).installedVersion, "4.8.2");
  } finally { await Promise.all([legacy.close(), metadata.close()]); }
});

test("returns unknown without network access for missing or invalid local metadata", async () => {
  const missing = await fixture();
  const invalid = await fixture("metadata:\n  version: latest");
  let calls = 0;
  const checker = new UpdateChecker(async () => { calls++; return response("4.8.2"); });
  try {
    assert.equal((await checker.check({ cliPath: missing.cliPath, appRoot: missing.appRoot })).status, "unknown");
    assert.equal((await checker.check({ cliPath: invalid.cliPath, appRoot: invalid.appRoot })).status, "unknown");
    assert.equal((await checker.check({ cliPath: null, appRoot: missing.appRoot })).status, "unknown");
    assert.equal(calls, 0);
  } finally { await Promise.all([missing.close(), invalid.close()]); }
});

test("uses strict semantic version precedence including prereleases", async () => {
  const prerelease = await fixture("metadata:\n  version: 5.0.0-beta.2");
  const newerLocal = await fixture("metadata:\n  version: 5.1.0");
  try {
    assert.equal((await new UpdateChecker(async () => response("5.0.0")).check({ cliPath: prerelease.cliPath, appRoot: prerelease.appRoot })).status, "available");
    assert.equal((await new UpdateChecker(async () => response("5.0.0-beta.11")).check({ cliPath: prerelease.cliPath, appRoot: prerelease.appRoot })).status, "available");
    assert.equal((await new UpdateChecker(async () => response("5.0.0")).check({ cliPath: newerLocal.cliPath, appRoot: newerLocal.appRoot })).status, "current");
  } finally { await Promise.all([prerelease.close(), newerLocal.close()]); }
});

test("reports upstream failures, malformed responses, and oversized bodies as unavailable", async () => {
  const f = await fixture("metadata:\n  version: 4.8.0");
  try {
    const offline = new UpdateChecker(async () => { throw new Error("offline"); });
    const malformed = new UpdateChecker(async () => new Response("not json"));
    const oversized = new UpdateChecker(async () => new Response("x".repeat(8 * 1024 + 1)));
    assert.equal((await offline.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert.equal((await malformed.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert.equal((await oversized.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
  } finally { await f.close(); }
});

test("times out stalled requests", async () => {
  const f = await fixture("metadata:\n  version: 4.8.0");
  try {
    const checker = new UpdateChecker((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const started = Date.now();
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert(Date.now() - started >= 1_400 && Date.now() - started < 3_000);
  } finally { await f.close(); }
});

test("times out and cancels stalled response bodies", async () => {
  const f = await fixture("metadata:\n  version: 4.8.0");
  let cancelled = false;
  try {
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const checker = new UpdateChecker(async () => new Response(body as never));
    const started = Date.now();
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert(Date.now() - started >= 1_400 && Date.now() - started < 3_000);
    assert.equal(cancelled, true);
  } finally { await f.close(); }
});

test("caches successes, applies failure backoff, and force bypasses settled cache", async () => {
  const f = await fixture("metadata:\n  version: 4.8.0");
  let now = 1_000;
  let calls = 0;
  const checker = new UpdateChecker(async () => {
    calls++;
    if (calls === 3) throw new Error("offline");
    return response(calls === 1 ? "4.8.1" : "4.8.2");
  }, {}, () => now);
  try {
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).latestVersion, "4.8.1");
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).latestVersion, "4.8.1");
    assert.equal(calls, 1);
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot, force: true })).latestVersion, "4.8.2");
    assert.equal(calls, 2);
    now += 24 * 60 * 60 * 1_000 + 1;
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert.equal((await checker.check({ cliPath: f.cliPath, appRoot: f.appRoot })).status, "unavailable");
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test("deduplicates concurrent requests, including forced checks", async () => {
  const f = await fixture("metadata:\n  version: 4.8.0");
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const checker = new UpdateChecker(async () => { calls++; started(); await gate; return response("4.8.2"); });
  try {
    const first = checker.check({ cliPath: f.cliPath, appRoot: f.appRoot });
    const second = checker.check({ cliPath: f.cliPath, appRoot: f.appRoot, force: true });
    await requestStarted;
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await first, await second);
  } finally { await f.close(); }
});

test("respects environment and layered project opt-outs without network access", async () => {
  const envDisabled = await fixture("metadata:\n  version: 4.8.0");
  const configDisabled = await fixture("metadata:\n  version: 4.8.0");
  const localEnabled = await fixture("metadata:\n  version: 4.8.0");
  let calls = 0;
  const fetcher = async () => { calls++; return response("4.8.2"); };
  try {
    await mkdir(path.join(configDisabled.appRoot, ".impeccable"), { recursive: true });
    await writeFile(path.join(configDisabled.appRoot, ".impeccable", "config.json"), JSON.stringify({ updateCheck: false }));
    await mkdir(path.join(localEnabled.appRoot, ".impeccable"), { recursive: true });
    await writeFile(path.join(localEnabled.appRoot, ".impeccable", "config.json"), JSON.stringify({ updateCheck: false }));
    await writeFile(path.join(localEnabled.appRoot, ".impeccable", "config.local.json"), JSON.stringify({ updateCheck: true }));
    assert.equal((await new UpdateChecker(fetcher, { IMPECCABLE_NO_UPDATE_CHECK: "1" }).check({ cliPath: envDisabled.cliPath, appRoot: envDisabled.appRoot })).status, "disabled");
    assert.equal((await new UpdateChecker(fetcher, {}).check({ cliPath: configDisabled.cliPath, appRoot: configDisabled.appRoot })).status, "disabled");
    assert.equal(calls, 0);
    assert.equal((await new UpdateChecker(fetcher, {}).check({ cliPath: localEnabled.cliPath, appRoot: localEnabled.appRoot })).status, "available");
    assert.equal(calls, 1);
  } finally { await Promise.all([envDisabled.close(), configDisabled.close(), localEnabled.close()]); }
});
