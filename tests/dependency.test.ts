import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectDependency, resolveDependencyCli } from "../server/dependency.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "impeccable-dependency-"));
  const workspace = path.join(root, "workspace");
  const app = path.join(workspace, "apps", "web");
  const home = path.join(root, "home");
  await Promise.all([mkdir(app, { recursive: true }), mkdir(home, { recursive: true })]);
  return { root, workspace, app, home, close: () => rm(root, { recursive: true, force: true }) };
}

async function launcher(base: string, body: string, provider = ".agents", version?: string) {
  const skill = path.join(base, provider, "skills", "impeccable");
  const command = path.join(skill, "scripts", "impeccable");
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  if (version) await writeFile(path.join(skill, "scripts", "VERSION"), `${version}\n`);
  return realpath(command);
}

test("discovers project installations before personal installations in deterministic provider order", async () => {
  const f = await fixture();
  try {
    const personal = await launcher(f.home, "echo impeccable-engine 1.0.0");
    const workspaceClaude = await launcher(f.workspace, "echo impeccable-engine 1.0.0", ".claude");
    const appAgents = await launcher(f.app, "echo impeccable-engine 1.0.0");
    assert.equal(await resolveDependencyCli({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home }), appAgents);
    await rm(appAgents);
    assert.equal(await resolveDependencyCli({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home }), workspaceClaude);
    await rm(workspaceClaude);
    assert.equal(await resolveDependencyCli({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home }), personal);
  } finally { await f.close(); }
});

test("rejects invalid explicit overrides without falling back", async () => {
  const f = await fixture();
  try {
    await launcher(f.home, "echo impeccable-engine 1.0.0");
    await assert.rejects(resolveDependencyCli({ override: path.join(f.root, "missing"), home: f.home }), /selected.*unavailable/i);
    await assert.rejects(resolveDependencyCli({ override: "relative/impeccable", home: f.home }), /absolute/i);
  } finally { await f.close(); }
});

test("ignores project launcher symlinks that resolve outside the workspace", async () => {
  const f = await fixture();
  try {
    const external = await launcher(f.root, "echo impeccable-engine 1.0.0", ".external");
    const project = path.join(f.app, ".agents", "skills", "impeccable", "scripts", "impeccable");
    await mkdir(path.dirname(project), { recursive: true });
    await symlink(external, project);
    const personal = await launcher(f.home, "echo impeccable-engine 2.0.0");
    assert.equal(await resolveDependencyCli({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home }), personal);
  } finally { await f.close(); }
});

test("reports a missing launcher as guided blocked checks", async () => {
  const f = await fixture();
  try {
    const result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.cliPath, null);
    assert.deepEqual(result.checks.map(check => check.status), ["blocked", "warning", "warning"]);
    assert.match(result.checks[0].message, /Install Impeccable/i);
  } finally { await f.close(); }
});

test("verifies engine identity and reports unversioned protocol compatibility honestly", async () => {
  const f = await fixture();
  try {
    const command = await launcher(f.home, "echo impeccable-engine 4.8.0", ".agents", "4.8.0");
    const result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.cliPath, command);
    assert.equal(result.engineVersion, "4.8.0");
    assert.deepEqual(result.checks.map(check => check.status), ["ready", "ready", "warning"]);
    assert.match(result.checks[2].detail ?? "", /both report 4\.8\.0/);
  } finally { await f.close(); }
});

test("blocks a skill and engine version mismatch", async () => {
  const f = await fixture();
  try {
    await launcher(f.home, "echo impeccable-engine 4.7.0", ".agents", "4.8.0");
    const result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.engineVersion, "4.7.0");
    assert.equal(result.checks[2].status, "blocked");
    assert.match(result.checks[2].detail ?? "", /expects 4\.8\.0.*reported 4\.7\.0/);
  } finally { await f.close(); }
});

test("blocks invalid or failed probes and redacts bounded diagnostics", async () => {
  const f = await fixture();
  try {
    const invalid = await launcher(f.home, "echo not-an-engine");
    let result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.checks[1].status, "blocked");
    assert.match(result.checks[1].detail ?? "", /valid Impeccable engine identity/);
    await writeFile(invalid, "#!/bin/sh\necho 'token=super-secret' >&2\nexit 9\n");
    await chmod(invalid, 0o755);
    result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.checks[1].status, "blocked");
    assert.doesNotMatch(result.checks[1].detail ?? "", /super-secret/);
    assert.match(result.checks[1].detail ?? "", /token=\[redacted\]/);
  } finally { await f.close(); }
});

test("cancels an in-flight engine probe", async () => {
  const f = await fixture();
  try {
    await launcher(f.home, "sleep 30");
    const controller = new AbortController();
    const inspection = inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home, signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(inspection, /cancelled/i);
  } finally { await f.close(); }
});


test("does not execute a project launcher until its absolute path is explicitly selected", async () => {
  const f = await fixture();
  try {
    const command = await launcher(f.app, 'echo "impeccable-engine 1.0.0"; touch "$PWD/probe-ran"');
    const detected = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(detected.cliPath, command);
    assert.equal(detected.engineVersion, null);
    assert.match(detected.checks[0].message, /Select it explicitly/);
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(path.join(f.app, "probe-ran")));
    const selected = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, override: command, home: f.home });
    assert.equal(selected.engineVersion, "1.0.0");
    await access(path.join(f.app, "probe-ran"));
  } finally { await f.close(); }
});

test("bounds stalled probes and terminates children holding inherited pipes", async () => {
  const f = await fixture();
  try {
    await launcher(f.home, 'sleep 30 & wait');
    const started = Date.now();
    const result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert(Date.now() - started < 7_000);
    assert.match(result.checks.find(check => check.id === "engine")?.detail ?? "", /timed out/);
  } finally { await f.close(); }
});

test("uses a non-download probe environment with structured engine arguments", async () => {
  const f = await fixture();
  try {
    await launcher(f.home, '[ "$1" = engine-probe ] && [ "$IMPECCABLE_LAUNCHER_PROBE" = 1 ] && [ "$COREPACK_ENABLE_NETWORK" = 0 ] && echo impeccable-engine 1.0.0');
    const result = await inspectDependency({ workspaceRoot: f.workspace, appRoot: f.app, home: f.home });
    assert.equal(result.engineVersion, "1.0.0");
  } finally { await f.close(); }
});
