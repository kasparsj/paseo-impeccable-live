import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function fixture(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "library-showcase-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await cp(path.join(repository, "scripts/prepare-library-showcase.mjs"), path.join(root, "scripts/prepare-library-showcase.mjs"));
  await cp(path.join(repository, "demo"), path.join(root, "demo"), { recursive: true });
  await cp(path.join(repository, ".gitignore"), path.join(root, ".gitignore"));
  return root;
}

function run(root: string, command: string, ...flags: string[]) {
  return spawnSync(process.execPath, ["scripts/prepare-library-showcase.mjs", command, ...flags], {
    cwd: root, encoding: "utf8", env: environment,
  });
}

test("showcase prepare creates a clean tracked demo on a fresh checkout and can run again", async (t) => {
  const root = await fixture(t);
  const first = run(root, "prepare");
  assert.equal(first.status, 0, first.stderr);
  const baseline = JSON.parse(first.stdout);
  assert.equal(baseline.demoRoot, path.join(root, ".demo/library-showcase-app"));
  assert.match(baseline.baselineCommit, /^[a-f0-9]{40}$/);
  assert.equal(await readFile(path.join(baseline.demoRoot, "index.html"), "utf8"),
    await readFile(path.join(root, "demo/library-showcase/index.html"), "utf8"));
  const status = run(root, "status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "");
  const evidencePath = path.join(root, "artifacts/library-video/baseline.json");
  const evidence = await readFile(evidencePath, "utf8");
  const second = run(root, "prepare");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).baselineCommit, baseline.baselineCommit);
  assert.equal(await readFile(evidencePath, "utf8"), evidence);
  await assert.rejects(readdir(path.join(root, ".omx")), { code: "ENOENT" });
});

test("showcase status on a fresh checkout creates no private directories", async (t) => {
  const root = await fixture(t);
  const before = await readdir(root);
  const status = run(root, "status");
  assert.notEqual(status.status, 0);
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(readFile(path.join(root, "artifacts/library-video/baseline.json")), { code: "ENOENT" });
});

test("showcase prepare preserves unrelated session data", async (t) => {
  const root = await fixture(t);
  const session = path.join(root, ".omx/other-session/state.json");
  await mkdir(path.dirname(session), { recursive: true });
  await writeFile(session, '{"active":true}\n');
  const otherDemo = path.join(root, ".demo/other-demo.txt");
  await mkdir(path.dirname(otherDemo));
  await writeFile(otherDemo, "preserve\n");
  const result = run(root, "prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(session, "utf8"), '{"active":true}\n');
  assert.deepEqual(await readdir(path.join(root, ".omx")), ["other-session"]);
  assert.equal(await readFile(otherDemo, "utf8"), "preserve\n");
});

test("showcase reset archives changes in artifacts before restoring the demo", async (t) => {
  const root = await fixture(t);
  const prepared = run(root, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  const stylesheet = path.join(root, ".demo/library-showcase-app/styles.css");
  const baseline = await readFile(stylesheet, "utf8");
  const changed = baseline + "\n/* rehearsal edit */\n";
  await writeFile(stylesheet, changed);
  assert.notEqual(run(root, "reset").status, 0);
  assert.equal(await readFile(stylesheet, "utf8"), changed);
  const reset = run(root, "reset", "--agent-finished");
  assert.equal(reset.status, 0, reset.stderr);
  const archive = JSON.parse(reset.stdout).archivedAt;
  assert(archive.startsWith(path.join(root, "artifacts/library-video/reset-archives") + path.sep));
  assert.equal(await readFile(path.join(archive, "source/styles.css"), "utf8"), changed);
  assert.equal(await readFile(stylesheet, "utf8"), baseline);
  await assert.rejects(readdir(path.join(root, ".omx")), { code: "ENOENT" });
});

test("showcase reset rejects a symlinked artifacts directory before restoring source", async (t) => {
  const root = await fixture(t);
  const prepared = run(root, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  const stylesheet = path.join(root, ".demo/library-showcase-app/styles.css");
  await writeFile(stylesheet, "rehearsal edit\n");
  await rename(path.join(root, "artifacts"), path.join(root, "saved-artifacts"));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "untouched\n");
  await symlink(outside, path.join(root, "artifacts"));
  const reset = run(root, "reset", "--agent-finished");
  assert.notEqual(reset.status, 0);
  assert.match(reset.stderr, /symlink/i);
  assert.equal(await readFile(stylesheet, "utf8"), "rehearsal edit\n");
  assert.deepEqual(await readdir(outside), ["sentinel"]);
});

test("showcase prepare refuses a symlinked .demo without writing to its target", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "untouched\n");
  await symlink(outside, path.join(root, ".demo"));
  const result = run(root, "prepare");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/i);
  assert.deepEqual(await readdir(outside), ["sentinel"]);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "untouched\n");
});

test("repository ignore rules protect private showcase data without global excludes", async (t) => {
  const root = await fixture(t);
  const init = spawnSync("git", ["init", "--quiet", "--template=", root], { encoding: "utf8", env: environment });
  assert.equal(init.status, 0, init.stderr);
  const privatePaths = [
    ".demo/library-showcase-app/index.html",
    "artifacts/library-video/raw-verified.mov",
    "artifacts/library-video/workflow-evidence.json",
    "artifacts/library-video/final-completed.snapshot.json",
  ];
  const ignored = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--stdin"], {
    cwd: root, encoding: "utf8", env: environment, input: privatePaths.join("\n") + "\n",
  });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split("\n"), privatePaths);
  for (const visible of ["demo/library-showcase/.impeccable/live/config.json", "docs/media/library-showcase/showcase.mp4"]) {
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", visible], {
      cwd: root, encoding: "utf8", env: environment,
    });
    assert.equal(result.status, 1, `${visible} must remain reviewable: ${result.stdout}${result.stderr}`);
  }
});
