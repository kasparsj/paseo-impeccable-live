import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { QuickUpdater, QUICK_UPDATE_PACKAGE, QUICK_UPDATE_VERSION, runUpdaterProcess } from "../server/quick-update.ts";

const npmPath = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const processFixture = path.resolve("tests/quick-update-fixture.mjs");

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-quick-update-")));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await Promise.all([mkdir(path.join(project, ".git"), { recursive: true }), mkdir(home)]);
  return { root, project, home, close: () => rm(root, { recursive: true, force: true }) };
}

async function install(root: string, provider = ".agents", version = "4.8.1") {
  const skill = path.join(root, provider, "skills", "impeccable");
  const cli = path.join(skill, "scripts", "impeccable");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), skillMetadata(version));
  await writeFile(path.join(skill, "scripts", "VERSION"), "0.1.21\n");
  await writeFile(cli, "#!/bin/sh\n[ \"$1\" = engine-probe ] && echo impeccable-engine 0.1.21\n");
  await chmod(cli, 0o755);
  return { skill, cli };
}

function skillMetadata(version: string) {
  return `---\nname: impeccable\nmetadata:\n  version: ${version}\n---\n# Impeccable\n`;
}

async function simulateAcquisition(request: { args: string[] }): Promise<boolean> {
  if (request.args[0] !== "install") return false;
  const prefix = request.args[request.args.indexOf("--prefix") + 1];
  const cli = path.join(prefix, "node_modules", "impeccable", "cli", "bin", "cli.js");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, "// official fixture\n");
  const os = process.platform === "win32" ? "windows" : process.platform;
  const target = `${os}-${process.arch}`;
  const engine = path.join(prefix, "node_modules", `@impeccable/cli-${target}`, "bin", process.platform === "win32" ? "impeccable.exe" : "impeccable");
  await mkdir(path.dirname(engine), { recursive: true });
  await writeFile(engine, "#!/bin/sh\nexit 0\n");
  await chmod(engine, 0o755);
  const integrities: Record<string, string> = {
    "linux-x64": "sha512-X7r/nQnk2imNF5QH8v0nMdraxnkCUh0XBchScolYODimuInezEKpLAPbCMmhTibpg7EkMgnfPuCA8/IvIDGjdw==",
    "linux-arm64": "sha512-Ia2L/Sm6qm9sexWyyUuUK3VUpEl83sfgO0UHKad9iWsZe2pDCxW3iIaBG8naQtfLCFgd+yrmGdG5KNZ0UDaD5w==",
    "windows-x64": "sha512-wWcmPBzh0HDWfSDtuJFi5RiGrXk7+8TfAuQOeePsNqqNLyQ4KTp0CR0JfzVvuLXEmRV/goY4g4Y2Hmaya0o/SA==",
    "darwin-x64": "sha512-p37+Anz1JrWlsDqNIutTKDGM1He9S2Y9aaxK1sT2zqfyH4xa5yFVJt5TBD0Z1ZPc+kNhEwsfffVWr3OQNRS8+w==",
    "darwin-arm64": "sha512-8gKNvi98N3pa1tD5+D70/p85Whcs18g1Fp0isPn0iEg1jGnHZnTdZSAdowOITzRTCuAWwRwDuk9gFCgZ8wXctg==",
  };
  await writeFile(path.join(prefix, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/impeccable": { version: "4.8.2", integrity: "sha512-NCEL/OndWjqCgN1hhau4In7zLDMlk/NZim8IcBitSER56hx3/eQecXjRC5+kSV6iRd2d8G5kWwR5agGXse4b3w==" },
    [`node_modules/@impeccable/cli-${target}`]: { version: "0.1.21", integrity: integrities[target] },
  } }));
  return true;
}

function executeInput(plan: Extract<Awaited<ReturnType<QuickUpdater["prepare"]>>, { status: "eligible" }>, cli: string, appRoot: string) {
  return {
    planId: plan.planId, selectedCliPath: cli, resolvedCliPath: cli, appRoot,
    scope: plan.scope, targetSkillVersion: plan.targetSkillVersion, updaterVersion: plan.updaterVersion,
    verifyTarget: async () => {},
  };
}

test("prepares exact project scope disclosure and invokes only the pinned structured updater", async () => {
  const f = await fixture();
  const selected = await install(f.project, ".agents");
  const other = await install(f.project, ".claude", "4.8.0");
  const requests: Array<{ command: string; args: string[]; cwd: string; signal: AbortSignal }> = [];
  await mkdir(path.join(f.project, "node_modules", "impeccable", "cli", "bin"), { recursive: true });
  await writeFile(path.join(f.project, "node_modules", "impeccable", "cli", "bin", "cli.js"), "throw new Error('LOCAL PACKAGE MUST NOT RUN');\n");
  const updater = new QuickUpdater({ home: f.home, npmPath, runner: async next => {
    requests.push(next);
    if (await simulateAcquisition(next)) return { code: 0, output: "installed official package" };
    await Promise.all([selected, other].map(item => writeFile(path.join(item.skill, "SKILL.md"), skillMetadata("4.8.2"))));
    return { code: 0, output: "Updated 2 skills." };
  } });
  try {
    const prepared = await updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "eligible");
    if (prepared.status !== "eligible") return;
    assert.equal(prepared.scope, "project");
    assert.equal(prepared.workingDirectory, f.project);
    assert.deepEqual(prepared.affectedInstallations.map(item => [item.provider, item.version]), [[".agents", "4.8.1"], [".claude", "4.8.0"]]);
    assert.equal(prepared.updaterVersion, QUICK_UPDATE_VERSION);
    const result = await updater.execute(executeInput(prepared, selected.cli, f.project));
    assert.equal(result.status, "succeeded");
    assert.equal(result.installedVersion, "4.8.2");
    assert.equal(result.engineVersion, "0.1.21");
    assert.equal(requests[0]?.command, npmPath);
    assert(requests[0]?.args.includes(QUICK_UPDATE_PACKAGE));
    assert(requests[0]?.args.includes("--registry=https://registry.npmjs.org"));
    assert.match(requests[1]?.command ?? "", /paseo-impeccable-updater-.*node_modules.*@impeccable.*bin.*impeccable/);
    assert.deepEqual(requests[1]?.args, ["update", "--project", "--yes", "--no-hooks"]);
    assert.doesNotMatch(requests[1]?.command ?? "", new RegExp(f.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(requests[1]?.cwd, f.project);
    assert.doesNotMatch(requests[1]?.args.join(" ") ?? "", /force|latest/);
  } finally { await updater.shutdown(); await f.close(); }
});

test("prepares personal scope while custom, linked, ancestor-linked and unsupported scope entries fail closed", async () => {
  const f = await fixture();
  try {
    const personal = await install(f.home, ".agents");
    let updater = new QuickUpdater({ home: f.home, npmPath, runner: async () => ({ code: 1, output: "unused" }) });
    let prepared = await updater.prepare({ selectedCliPath: personal.cli, resolvedCliPath: personal.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "eligible");
    if (prepared.status === "eligible") assert.equal(prepared.scope, "personal");

    const custom = await install(path.join(f.root, "custom"));
    prepared = await updater.prepare({ selectedCliPath: custom.cli, resolvedCliPath: custom.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "guidance");

    const codex = await install(f.home, ".codex");
    prepared = await updater.prepare({ selectedCliPath: codex.cli, resolvedCliPath: codex.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "guidance");

    const linkedSource = await install(path.join(f.root, "linked-source"));
    await rm(personal.skill, { recursive: true });
    await symlink(linkedSource.skill, personal.skill);
    prepared = await updater.prepare({ selectedCliPath: personal.cli, resolvedCliPath: linkedSource.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "guidance");
    assert.match(prepared.status === "guidance" ? prepared.reason : "", /linked/i);

    await rm(personal.skill);
    const restored = await install(f.home, ".agents");
    const linkedParentSource = path.join(f.root, "claude-skills");
    const other = await install(path.join(f.root, "other"), ".claude");
    await mkdir(path.dirname(path.join(f.home, ".claude", "skills")), { recursive: true });
    await symlink(path.dirname(other.skill), path.join(f.home, ".claude", "skills"));
    prepared = await updater.prepare({ selectedCliPath: restored.cli, resolvedCliPath: restored.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "guidance");
    assert.match(prepared.status === "guidance" ? prepared.reason : "", /unsupported|linked/i);
    void linkedParentSource;
    await updater.shutdown();
  } finally { await f.close(); }
});

test("invalidates plans when identity, content, scope, target or package binding changes", async () => {
  const f = await fixture();
  const selected = await install(f.project);
  const updater = new QuickUpdater({ home: f.home, npmPath, runner: async () => ({ code: 0, output: "unused" }) });
  try {
    const prepared = await updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "eligible");
    if (prepared.status !== "eligible") return;
    for (const changed of [
      { updaterVersion: "latest" }, { targetSkillVersion: "9.9.9" }, { scope: "personal" as const }, { selectedCliPath: path.join(f.root, "other") },
    ]) {
      await assert.rejects(updater.execute({ ...executeInput(prepared, selected.cli, f.project), ...changed }), /stale/i);
    }
    await writeFile(path.join(selected.skill, "SKILL.md"), skillMetadata("4.7.0"));
    await assert.rejects(updater.execute(executeInput(prepared, selected.cli, f.project)), /changed/i);
    await writeFile(path.join(selected.skill, "SKILL.md"), skillMetadata("4.8.1"));
    const second = await updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(second.status, "eligible");
    if (second.status !== "eligible") return;
    await writeFile(path.join(selected.skill, "scripts", "VERSION"), "0.1.22\n");
    await assert.rejects(updater.execute(executeInput(second, selected.cli, f.project)), /changed/i);
  } finally { await updater.shutdown(); await f.close(); }
});

test("rejects relative provider overrides and a remote target change before updater mutation", async () => {
  const f = await fixture();
  const selected = await install(f.project);
  let updaterCalls = 0;
  const updater = new QuickUpdater({ home: f.home, npmPath, env: { ...process.env, XDG_CONFIG_HOME: "relative-config" }, runner: async request => {
    if (await simulateAcquisition(request)) return { code: 0, output: "installed" };
    updaterCalls++; return { code: 0, output: "unexpected" };
  } });
  try {
    const unsupported = await updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(unsupported.status, "guidance");
    assert.match(unsupported.status === "guidance" ? unsupported.reason : "", /XDG_CONFIG_HOME is relative/);
  } finally { await updater.shutdown(); }

  const guarded = new QuickUpdater({ home: f.home, npmPath, runner: async request => {
    if (await simulateAcquisition(request)) return { code: 0, output: "installed" };
    updaterCalls++; return { code: 0, output: "unexpected" };
  } });
  try {
    const prepared = await guarded.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "eligible");
    if (prepared.status !== "eligible") return;
    await assert.rejects(guarded.execute({ ...executeInput(prepared, selected.cli, f.project),
      verifyTarget: async () => { throw new Error("available skill version changed"); } }), /version changed/i);
    assert.equal(updaterCalls, 0);
  } finally { await guarded.shutdown(); await f.close(); }
});

test("shutdown reserves and cancels validation before any future updater spawn", async () => {
  const f = await fixture();
  const selected = await install(f.project);
  let calls = 0;
  const updater = new QuickUpdater({ home: f.home, npmPath, runner: async request => {
    calls++;
    if (request.signal.aborted) throw new Error("aborted before spawn");
    if (await simulateAcquisition(request)) return { code: 0, output: "installed" };
    return { code: 0, output: "unexpected" };
  } });
  try {
    const prepared = await updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(prepared.status, "eligible");
    if (prepared.status !== "eligible") return;
    const execution = updater.execute(executeInput(prepared, selected.cli, f.project));
    await updater.shutdown();
    await assert.rejects(execution, /shutting down|aborted/i);
    assert(calls <= 1);
    await assert.rejects(updater.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" }), /shutting down/i);
  } finally { await f.close(); }
});

test("serializes a scope and treats exit zero without selected skill and engine verification as failure", async () => {
  const f = await fixture();
  const selected = await install(f.project);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const first = new QuickUpdater({ home: f.home, npmPath, runner: async request => {
    if (await simulateAcquisition(request)) return { code: 0, output: "installed" };
    await pending; return { code: 0, output: "Skipped linked install." };
  } });
  const second = new QuickUpdater({ home: f.home, npmPath, runner: async request => {
    if (await simulateAcquisition(request)) return { code: 0, output: "installed" };
    return { code: 0, output: "unexpected" };
  } });
  try {
    const p1 = await first.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    const p2 = await second.prepare({ selectedCliPath: selected.cli, resolvedCliPath: selected.cli, appRoot: f.project, targetSkillVersion: "4.8.2" });
    assert.equal(p1.status, "eligible"); assert.equal(p2.status, "eligible");
    if (p1.status !== "eligible" || p2.status !== "eligible") return;
    const running = first.execute(executeInput(p1, selected.cli, f.project));
    await assert.rejects(second.execute(executeInput(p2, selected.cli, f.project)), /already running/i);
    release();
    await assert.rejects(running, /still 4\.8\.1/i);
  } finally { release(); await Promise.all([first.shutdown(), second.shutdown()]); await f.close(); }
});

test("subprocess runner reports failure, bounds and redacts output, and kills a timed-out process group", async () => {
  const failed = await runUpdaterProcess({ command: process.execPath, args: [processFixture, "fail"], cwd: process.cwd(), signal: new AbortController().signal }, 2_000);
  assert.equal(failed.code, 7);
  assert.match(failed.output, /token=\[redacted\]/);
  assert.doesNotMatch(failed.output, /fixture-secret/);
  const large = await runUpdaterProcess({ command: process.execPath, args: [processFixture, "large"], cwd: process.cwd(), signal: new AbortController().signal }, 2_000);
  assert.equal(large.code, 0);
  assert(Buffer.byteLength(large.output) <= 64 * 1024);
  const previous = { bin: process.env.IMPECCABLE_BIN, base: process.env.IMPECCABLE_DOWNLOAD_BASE, skill: process.env.IMPECCABLE_SKILL_DIR, home: process.env.IMPECCABLE_HOME };
  process.env.IMPECCABLE_BIN = "/tmp/untrusted-engine";
  process.env.IMPECCABLE_DOWNLOAD_BASE = "https://invalid.example";
  process.env.IMPECCABLE_SKILL_DIR = "/tmp/untrusted-skill";
  process.env.IMPECCABLE_HOME = "/tmp/retained-impeccable-home";
  const environment = await runUpdaterProcess({ command: process.execPath, args: [processFixture, "env"], cwd: process.cwd(), signal: new AbortController().signal }, 2_000);
  assert.deepEqual(JSON.parse(environment.output), { home: "/tmp/retained-impeccable-home" });
  for (const [name, value] of Object.entries({ IMPECCABLE_BIN: previous.bin, IMPECCABLE_DOWNLOAD_BASE: previous.base, IMPECCABLE_SKILL_DIR: previous.skill, IMPECCABLE_HOME: previous.home })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const started = Date.now();
  await assert.rejects(runUpdaterProcess({ command: process.execPath, args: [processFixture, "hang"], cwd: process.cwd(), signal: new AbortController().signal }, 100), /timed out.*not rolled back/i);
  assert(Date.now() - started < 2_500);
});
