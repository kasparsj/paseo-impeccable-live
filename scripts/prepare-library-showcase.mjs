import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoStorageRoot = path.join(repositoryRoot, ".demo");
const artifactsRoot = path.join(repositoryRoot, "artifacts");
const templateRoot = path.join(repositoryRoot, "demo", "library-showcase");
const demoRoot = path.join(demoStorageRoot, "library-showcase-app");
const evidenceRoot = path.join(artifactsRoot, "library-video");
const markerPath = path.join(demoRoot, ".library-showcase-demo.json");
const helperRecordPath = path.join(demoRoot, ".impeccable", "live", "server.json");
const command = process.argv[2] ?? "prepare";
const flags = new Set(process.argv.slice(3));

const fixtureFiles = [
  ".gitignore",
  ".impeccable/live/config.json",
  "DESIGN.md",
  "PRODUCT.md",
  "README.md",
  "index.html",
  "package.json",
  "server.mjs",
  "styles.css",
];

if (!new Set(["prepare", "reset", "status", "refresh-baseline", "safety-probe"]).has(command)) {
  fail("Usage: node scripts/prepare-library-showcase.mjs <prepare|reset|status|refresh-baseline|safety-probe> [--agent-finished]");
}

if (command === "safety-probe") {
  await runSymlinkSafetyProbe();
  process.exit(0);
}

if (command === "prepare") await createSafeDirectory(repositoryRoot, demoStorageRoot);
else await assertSafeDirectoryTree(repositoryRoot, demoStorageRoot);
await assertTemplateComplete();

if (command === "prepare") await prepare();
if (command === "reset") await reset();
if (command === "status") await showStatus();
if (command === "refresh-baseline") await refreshBaseline();

async function prepare() {
  if (await pathEntryExists(demoRoot)) {
    await assertOwnedDemo();
    await assertHelperStopped();
    const status = await git(["status", "--short"]);
    if (status.trim()) fail(`The existing demo has changes. Reset it explicitly before preparing again:\n${status}`);
    const description = await describeBaseline();
    await storeBaseline(description);
    console.log(JSON.stringify(description, null, 2));
    return;
  }

  await createSafeDirectory(demoStorageRoot, demoRoot);
  await copyFixtureFiles();
  await writeSafeFile(demoRoot, markerPath, `${JSON.stringify({ schema: 1, demoRoot, templateRoot }, null, 2)}\n`, true);

  await git(["-c", "init.defaultBranch=showcase", "init"]);
  await git(["config", "user.name", "Paseo Library Showcase"]);
  await git(["config", "user.email", "showcase@invalid.local"]);
  await git(["add", "-f", "--", ...fixtureFiles, path.basename(markerPath)]);
  await git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "chore: establish showcase baseline"]);

  const description = await describeBaseline();
  await storeBaseline(description);
  console.log(JSON.stringify(description, null, 2));
}

async function reset() {
  if (!flags.has("--agent-finished")) {
    fail("Reset requires --agent-finished after the dedicated Paseo agent has completed its turn.");
  }
  await assertOwnedDemo();
  await assertHelperStopped();

  const changed = await changedFixtureFiles();
  let archive = null;
  if (changed.length > 0) archive = await archiveCurrentState(changed);
  await copyFixtureFiles();

  const remaining = await git(["status", "--short", "--", ...fixtureFiles]);
  if (remaining.trim()) fail(`Reset did not restore the explicit fixture files:\n${remaining}`);
  console.log(JSON.stringify({ ok: true, demoRoot, restored: fixtureFiles, archivedAt: archive }, null, 2));
}

async function showStatus() {
  await assertOwnedDemo();
  console.log(JSON.stringify({ ...(await describeDemo()), status: await git(["status", "--short"]) }, null, 2));
}

async function refreshBaseline() {
  await assertOwnedDemo();
  const description = await describeBaseline();
  await storeBaseline(description);
  console.log(JSON.stringify(description, null, 2));
}

async function assertTemplateComplete() {
  const missing = [];
  await assertSafeDirectoryTree(repositoryRoot, templateRoot);
  for (const relative of fixtureFiles) {
    const source = path.join(templateRoot, relative);
    if (!(await pathEntryExists(source))) {
      missing.push(relative);
      continue;
    }
    await assertSafeRegularFile(templateRoot, source);
  }
  if (missing.length) fail(`The fixture template is incomplete: ${missing.join(", ")}`);
}

async function assertOwnedDemo() {
  await assertSafeDirectoryTree(demoStorageRoot, demoRoot);
  if (!(await pathEntryExists(markerPath))) fail(`Refusing to operate on an unmarked directory: ${demoRoot}`);
  await assertSafeRegularFile(demoRoot, markerPath);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.schema !== 1 || marker.demoRoot !== demoRoot || marker.templateRoot !== templateRoot) {
    fail(`The demo ownership marker does not match the exact expected paths: ${markerPath}`);
  }
}

async function assertHelperStopped() {
  if (await pathEntryExists(helperRecordPath)) {
    fail(`An Impeccable helper record is still present. Stop this demo session first: ${helperRecordPath}`);
  }
}

async function copyFixtureFiles() {
  for (const relative of fixtureFiles) {
    const source = path.join(templateRoot, relative);
    const destination = path.join(demoRoot, relative);
    await assertSafeRegularFile(templateRoot, source);
    await createSafeDirectory(demoRoot, path.dirname(destination));
    await assertSafeOptionalRegularFile(demoRoot, destination);
    await copyFile(source, destination);
    await assertSafeRegularFile(demoRoot, destination);
  }
}

async function changedFixtureFiles() {
  const changed = [];
  for (const relative of fixtureFiles) {
    const source = path.join(templateRoot, relative);
    const current = path.join(demoRoot, relative);
    await assertSafeRegularFile(templateRoot, source);
    if (!(await pathEntryExists(current))) {
      changed.push(relative);
      continue;
    }
    await assertSafeRegularFile(demoRoot, current);
    if (hash(await readFile(source)) !== hash(await readFile(current))) changed.push(relative);
  }
  return changed;
}

async function archiveCurrentState(changed) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const archiveRoot = path.join(evidenceRoot, "reset-archives", timestamp);
  const sourceRoot = path.join(archiveRoot, "source");
  await createSafeDirectory(repositoryRoot, artifactsRoot);
  await createSafeDirectory(artifactsRoot, sourceRoot);
  for (const relative of changed) {
    const current = path.join(demoRoot, relative);
    if (!(await pathEntryExists(current))) continue;
    await assertSafeRegularFile(demoRoot, current);
    const destination = path.join(sourceRoot, relative);
    await createSafeDirectory(sourceRoot, path.dirname(destination));
    await assertSafeOptionalRegularFile(sourceRoot, destination);
    await copyFile(current, destination);
    await assertSafeRegularFile(sourceRoot, destination);
  }
  await writeSafeFile(archiveRoot, path.join(archiveRoot, "status.txt"), await git(["status", "--short"]));
  await writeSafeFile(archiveRoot, path.join(archiveRoot, "changes.patch"), await git(["diff", "--binary", "--", ...fixtureFiles]));
  await writeSafeFile(archiveRoot, path.join(archiveRoot, "manifest.json"), `${JSON.stringify({ schema: 1, demoRoot, changed }, null, 2)}\n`);
  return archiveRoot;
}

async function describeDemo() {
  const hashes = {};
  for (const relative of fixtureFiles) {
    const current = path.join(demoRoot, relative);
    await assertSafeRegularFile(demoRoot, current);
    hashes[relative] = hash(await readFile(current));
  }
  return {
    ok: true,
    demoRoot,
    baselineCommit: (await git(["rev-parse", "HEAD"])).trim(),
    hashes,
  };
}

async function describeBaseline() {
  const baselineCommit = (await git(["rev-parse", "HEAD"])).trim();
  const hashes = {};
  for (const relative of fixtureFiles) hashes[relative] = hash(await gitBuffer(["show", `${baselineCommit}:${relative}`]));
  return { ok: true, demoRoot, baselineCommit, hashes };
}

async function storeBaseline(description) {
  await createSafeDirectory(repositoryRoot, artifactsRoot);
  await createSafeDirectory(artifactsRoot, evidenceRoot);
  await writeSafeFile(evidenceRoot, path.join(evidenceRoot, "baseline.json"), `${JSON.stringify(description, null, 2)}\n`);
}

async function git(args) {
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: demoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

async function gitBuffer(args) {
  const result = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: demoRoot,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathEntryExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return false;
  }
}

async function createSafeDirectory(boundary, target) {
  if (path.resolve(boundary) === path.resolve(target)) {
    await assertSafeDirectoryTree(boundary, target);
    return;
  }
  await assertSafeDirectoryTree(boundary, path.dirname(target), true);
  await mkdir(target, { recursive: true });
  await assertSafeDirectoryTree(boundary, target);
}

async function assertSafeDirectoryTree(boundary, target, allowMissing = false) {
  if (!isContainedPath(boundary, target)) throw new Error(`Path escapes its allowed boundary: ${target}`);
  const boundaryMetadata = await lstat(boundary);
  if (boundaryMetadata.isSymbolicLink() || !boundaryMetadata.isDirectory()) {
    throw new Error(`Boundary must be a real directory, not a symlink: ${boundary}`);
  }
  const canonicalBoundary = await realpath(boundary);
  let current = boundary;
  const relative = path.relative(boundary, target);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Symlinked directory is not allowed: ${current}`);
    if (!metadata.isDirectory()) throw new Error(`Expected a directory: ${current}`);
    const canonicalCurrent = await realpath(current);
    if (!isContainedPath(canonicalBoundary, canonicalCurrent)) {
      throw new Error(`Directory resolves outside its allowed boundary: ${current}`);
    }
  }
}

async function assertSafeRegularFile(boundary, target) {
  await assertSafeDirectoryTree(boundary, path.dirname(target));
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error(`Symlinked file is not allowed: ${target}`);
  if (!metadata.isFile()) throw new Error(`Expected a regular file: ${target}`);
  const canonicalBoundary = await realpath(boundary);
  const canonicalTarget = await realpath(target);
  if (!isContainedPath(canonicalBoundary, canonicalTarget)) {
    throw new Error(`File resolves outside its allowed boundary: ${target}`);
  }
}

async function assertSafeOptionalRegularFile(boundary, target) {
  await assertSafeDirectoryTree(boundary, path.dirname(target));
  if (!(await pathEntryExists(target))) return;
  await assertSafeRegularFile(boundary, target);
}

async function writeSafeFile(boundary, target, contents, exclusive = false) {
  await createSafeDirectory(boundary, path.dirname(target));
  await assertSafeOptionalRegularFile(boundary, target);
  await writeFile(target, contents, { flag: exclusive ? "wx" : "w" });
  await assertSafeRegularFile(boundary, target);
}

function isContainedPath(boundary, target) {
  const relative = path.relative(boundary, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function runSymlinkSafetyProbe() {
  const probeRoot = await mkdtemp(path.join(tmpdir(), "paseo-library-showcase-symlink-"));
  const safeRoot = path.join(probeRoot, "safe");
  const outsideRoot = path.join(probeRoot, "outside");
  const rejected = [];
  try {
    await mkdir(safeRoot);
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, "outside.txt"), "must remain untouched\n");

    const linkedRoot = path.join(probeRoot, "linked-root");
    await symlink(safeRoot, linkedRoot);
    await expectSafetyRejection(() => assertSafeDirectoryTree(probeRoot, linkedRoot), "symlinked root", rejected);
    await rm(linkedRoot);

    const nestedLink = path.join(safeRoot, "nested-link");
    await symlink(outsideRoot, nestedLink);
    await expectSafetyRejection(() => assertSafeDirectoryTree(safeRoot, nestedLink), "symlinked ancestor", rejected);
    await rm(nestedLink);

    const sourceLink = path.join(safeRoot, "source.txt");
    await symlink(path.join(outsideRoot, "outside.txt"), sourceLink);
    await expectSafetyRejection(() => assertSafeRegularFile(safeRoot, sourceLink), "symlinked source file", rejected);
    await rm(sourceLink);

    const targetLink = path.join(safeRoot, "target.txt");
    await symlink(path.join(outsideRoot, "outside.txt"), targetLink);
    await expectSafetyRejection(() => assertSafeOptionalRegularFile(safeRoot, targetLink), "symlinked target file", rejected);

    const untouched = await readFile(path.join(outsideRoot, "outside.txt"), "utf8");
    if (untouched !== "must remain untouched\n") throw new Error("Safety probe modified the external target.");
    console.log(JSON.stringify({ ok: true, rejected, externalTargetUntouched: true }, null, 2));
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function expectSafetyRejection(operation, label, rejected) {
  try {
    await operation();
  } catch (error) {
    rejected.push({ label, message: error.message });
    return;
  }
  throw new Error(`Safety probe did not reject ${label}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
