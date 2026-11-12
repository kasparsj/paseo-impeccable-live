import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QuickUpdater, QUICK_UPDATE_PACKAGE, runUpdaterProcess } from "../server/quick-update.ts";
import { readInstalledSkillVersion } from "../server/update.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "impeccable-real-update-")));
const project = path.join(root, "project");
const bootstrap = path.join(root, "bootstrap-tool");
const engineHome = path.join(root, "engine-home");
const npmPath = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const environment = { ...process.env, IMPECCABLE_HOME: engineHome };

try {
  await Promise.all([mkdir(path.join(project, ".git"), { recursive: true }), mkdir(bootstrap, { recursive: true }), mkdir(engineHome, { recursive: true })]);
  const npmrc = path.join(bootstrap, "empty-npmrc");
  await writeFile(npmrc, "");
  const acquired = await runUpdaterProcess({
    command: npmPath,
    args: ["install", "--prefix", bootstrap, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
      "--registry=https://registry.npmjs.org", `--userconfig=${npmrc}`, `--cache=${path.join(root, "npm-cache")}`, QUICK_UPDATE_PACKAGE],
    cwd: bootstrap,
    signal: new AbortController().signal,
  }, 120_000, environment);
  if (acquired.code !== 0) throw new Error(`Bootstrap acquisition failed: ${acquired.output}`);
  const os = process.platform === "win32" ? "windows" : process.platform;
  const engine = path.join(bootstrap, "node_modules", `@impeccable/cli-${os}-${process.arch}`, "bin", process.platform === "win32" ? "impeccable.exe" : "impeccable");
  if (process.platform !== "win32") await chmod(engine, 0o755);
  const installed = await runUpdaterProcess({
    command: engine,
    args: ["install", "--project", "--providers=codex", "--yes", "--no-hooks"],
    cwd: project,
    signal: new AbortController().signal,
  }, 120_000, environment);
  if (installed.code !== 0) throw new Error(`Disposable project install failed: ${installed.output}`);

  const cli = path.join(project, ".agents", "skills", "impeccable", "scripts", "impeccable");
  const skill = path.join(project, ".agents", "skills", "impeccable", "SKILL.md");
  const officialInstalledVersion = await readInstalledSkillVersion(cli);
  const content = await readFile(skill, "utf8");
  await writeFile(skill, content.replace(/(\n\s*version:\s*)[^\r\n]+/, (_match, prefix: string) => `${prefix}4.8.1`));
  const before = await readInstalledSkillVersion(cli);

  const updater = new QuickUpdater({ home: path.join(root, "unused-personal-home"), npmPath, env: environment });
  const prepared = await updater.prepare({ selectedCliPath: cli, resolvedCliPath: cli, appRoot: project, targetSkillVersion: "4.8.2" });
  if (prepared.status !== "eligible") throw new Error(`Disposable project was unexpectedly ineligible: ${prepared.reason}`);
  const result = await updater.execute({
    planId: prepared.planId, selectedCliPath: cli, resolvedCliPath: cli, appRoot: project, scope: prepared.scope,
    targetSkillVersion: prepared.targetSkillVersion, updaterVersion: prepared.updaterVersion, verifyTarget: async () => {},
  });
  await updater.shutdown();
  const after = await readInstalledSkillVersion(cli);
  process.stdout.write(`${JSON.stringify({
    isolatedRoot: root,
    scope: prepared.scope,
    affected: prepared.affectedInstallations.map(item => item.path),
    officialInstalledVersion,
    before,
    after,
    engineVersion: result.engineVersion,
    updaterVersion: prepared.updaterVersion,
    invocation: ["<isolated reviewed engine 0.1.21>", "update", "--project", "--yes", "--no-hooks"],
    output: result.output,
    personalInstallTouched: false,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
