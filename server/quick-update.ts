import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { inspectDependency } from "./dependency.ts";
import { redactLog } from "./dev-server.ts";
import { readInstalledSkillVersion } from "./update.ts";

export const QUICK_UPDATE_PACKAGE = "impeccable@4.8.2";
export const QUICK_UPDATE_VERSION = "4.8.2";
const PROVIDERS = [
  ".claude", ".cursor", ".devin", ".dsh", ".gemini", ".agents", ".agent", ".github", ".grok", ".hermes",
  ".kiro", ".opencode", ".pi", ".omp", ".qoder", ".trae", ".trae-cn", ".rovodev", ".vibe",
] as const;
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const OFFICIAL_REGISTRY = "https://registry.npmjs.org";
const PACKAGE_INTEGRITY = "sha512-NCEL/OndWjqCgN1hhau4In7zLDMlk/NZim8IcBitSER56hx3/eQecXjRC5+kSV6iRd2d8G5kWwR5agGXse4b3w==";
const ENGINE_INTEGRITIES: Record<string, string> = {
  "linux-x64": "sha512-X7r/nQnk2imNF5QH8v0nMdraxnkCUh0XBchScolYODimuInezEKpLAPbCMmhTibpg7EkMgnfPuCA8/IvIDGjdw==",
  "linux-arm64": "sha512-Ia2L/Sm6qm9sexWyyUuUK3VUpEl83sfgO0UHKad9iWsZe2pDCxW3iIaBG8naQtfLCFgd+yrmGdG5KNZ0UDaD5w==",
  "windows-x64": "sha512-wWcmPBzh0HDWfSDtuJFi5RiGrXk7+8TfAuQOeePsNqqNLyQ4KTp0CR0JfzVvuLXEmRV/goY4g4Y2Hmaya0o/SA==",
  "darwin-x64": "sha512-p37+Anz1JrWlsDqNIutTKDGM1He9S2Y9aaxK1sT2zqfyH4xa5yFVJt5TBD0Z1ZPc+kNhEwsfffVWr3OQNRS8+w==",
  "darwin-arm64": "sha512-8gKNvi98N3pa1tD5+D70/p85Whcs18g1Fp0isPn0iEg1jGnHZnTdZSAdowOITzRTCuAWwRwDuk9gFCgZ8wXctg==",
};

export type QuickUpdateScope = "personal" | "project";
export type AffectedInstallation = { provider: string; path: string; version: string };
export type QuickUpdateGuidance = { status: "guidance"; selectedPath: string; reason: string };
export type QuickUpdatePlan = {
  status: "eligible";
  planId: string;
  scope: QuickUpdateScope;
  scopeLabel: string;
  selectedPath: string;
  workingDirectory: string;
  affectedInstallations: AffectedInstallation[];
  targetSkillVersion: string;
  updaterVersion: string;
};
export type QuickUpdatePreparation = QuickUpdatePlan | QuickUpdateGuidance;
export type QuickUpdateResult = {
  status: "succeeded";
  installedVersion: string;
  engineVersion: string;
  output: string;
  instruction: string;
};

type PreparedRecord = { plan: QuickUpdatePlan; fingerprint: string; resolvedCliPath: string };
type RunRequest = { command: string; args: string[]; cwd: string; signal: AbortSignal };
type RunResult = { code: number; output: string };
type Runner = (request: RunRequest) => Promise<RunResult>;
type Environment = Record<string, string | undefined>;

export class QuickUpdater {
  private static readonly scopeLocks = new Map<string, { planId: string; promise: Promise<QuickUpdateResult> }>();
  private readonly plans = new Map<string, PreparedRecord>();
  private readonly active = new Set<AbortController>();
  private readonly runner: Runner;
  private readonly env: Environment;
  private readonly home: string;
  private readonly timeoutMs: number;
  private readonly npmPath: string | undefined;
  private closed = false;

  constructor(options: { runner?: Runner; env?: Environment; home?: string; timeoutMs?: number; npmPath?: string } = {}) {
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? (request => runUpdaterProcess(request, this.timeoutMs, this.env));
    this.home = path.resolve(options.home ?? homedir());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.npmPath = options.npmPath;
  }

  async prepare(input: {
    selectedCliPath: string;
    resolvedCliPath: string;
    appRoot: string;
    targetSkillVersion: string;
  }): Promise<QuickUpdatePreparation> {
    if (this.closed) throw new Error("The updater is shutting down.");
    const discovered = await discoverPlan(input, this.home, this.env);
    if (this.closed) throw new Error("The updater is shutting down.");
    if (discovered.status === "guidance") return discovered;
    const plan: QuickUpdatePlan = { ...discovered.plan, planId: randomUUID() };
    this.plans.clear();
    this.plans.set(plan.planId, { plan, fingerprint: discovered.fingerprint, resolvedCliPath: input.resolvedCliPath });
    return plan;
  }

  execute(input: {
    planId: string;
    selectedCliPath: string;
    resolvedCliPath: string;
    appRoot: string;
    scope: QuickUpdateScope;
    targetSkillVersion: string;
    updaterVersion: string;
    verifyTarget: () => Promise<void>;
  }): Promise<QuickUpdateResult> {
    if (this.closed) return Promise.reject(new Error("The updater is shutting down."));
    const record = this.plans.get(input.planId);
    if (!record || record.plan.selectedPath !== input.selectedCliPath || record.resolvedCliPath !== input.resolvedCliPath ||
        record.plan.scope !== input.scope || record.plan.targetSkillVersion !== input.targetSkillVersion ||
        record.plan.updaterVersion !== input.updaterVersion) {
      return Promise.reject(new Error("This update plan is stale. Refresh update details before trying again."));
    }
    const key = `${record.plan.scope}:${record.plan.scope === "personal" ? this.home : record.plan.workingDirectory}`;
    const existing = QuickUpdater.scopeLocks.get(key);
    if (existing) return Promise.reject(new Error("Another Impeccable update is already running in this scope. Wait for it to finish and refresh update details."));
    const controller = new AbortController();
    this.active.add(controller);
    const operation = (async () => {
      if (record.plan.workingDirectory !== await findProjectRoot(input.appRoot)) {
        throw new Error("This update plan is stale. Refresh update details before trying again.");
      }
      const rediscovered = await discoverPlan({ ...input, selectedCliPath: input.selectedCliPath }, this.home, this.env);
      if (this.closed || controller.signal.aborted) throw new Error("The updater is shutting down.");
      if (rediscovered.status !== "eligible" || rediscovered.fingerprint !== record.fingerprint) {
        throw new Error("The selected installation or update scope changed. Refresh update details before trying again.");
      }
      return this.perform(record, controller, input.verifyTarget);
    })().finally(() => {
      if (QuickUpdater.scopeLocks.get(key)?.promise === operation) QuickUpdater.scopeLocks.delete(key);
      this.plans.delete(input.planId);
      this.active.delete(controller);
    });
    QuickUpdater.scopeLocks.set(key, { planId: input.planId, promise: operation });
    return operation;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...QuickUpdater.scopeLocks.values()].map(lock => lock.promise));
  }

  private async perform(record: PreparedRecord, controller: AbortController, verifyTarget: () => Promise<void>): Promise<QuickUpdateResult> {
    const npm = await resolveTrustedNpm(this.npmPath);
    if (this.closed || controller.signal.aborted) throw new Error("The updater is shutting down.");
    const toolRoot = await mkdtemp(path.join(tmpdir(), "paseo-impeccable-updater-"));
    try {
      const userConfig = path.join(toolRoot, "empty-npmrc");
      await writeFile(userConfig, "");
      const acquired = await this.runner({
        command: npm,
        args: ["install", "--prefix", toolRoot, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true",
          `--registry=${OFFICIAL_REGISTRY}`, `--userconfig=${userConfig}`, `--cache=${path.join(toolRoot, "cache")}`, QUICK_UPDATE_PACKAGE],
        cwd: toolRoot,
        signal: controller.signal,
      });
      if (acquired.code !== 0) throw new Error(`Could not acquire the pinned official updater (code ${acquired.code}). ${acquired.output}`.trim());
      const engine = await verifyAcquiredUpdater(toolRoot);
      await verifyTarget();
      if (this.closed || controller.signal.aborted) throw new Error("The updater is shutting down.");
      const flag = record.plan.scope === "personal" ? "--user" : "--project";
      const result = await this.runner({
        command: engine,
        args: ["update", flag, "--yes", "--no-hooks"],
        cwd: record.plan.workingDirectory,
        signal: controller.signal,
      });
      if (result.code !== 0) throw new Error(`Official updater exited with code ${result.code}. ${result.output}`.trim());
      const installedVersion = await readInstalledSkillVersion(record.resolvedCliPath);
      if (installedVersion !== record.plan.targetSkillVersion) {
        throw new Error(installedVersion
          ? `The updater finished, but the selected skill is still ${installedVersion} instead of ${record.plan.targetSkillVersion}. It may have skipped a linked or changed installation.`
          : "The updater finished, but the selected skill version could not be verified.");
      }
      const dependency = await inspectDependency({
        appRoot: record.plan.workingDirectory,
        workspaceRoot: record.plan.workingDirectory,
        override: record.plan.selectedPath,
        signal: controller.signal,
      });
      const blocked = dependency.checks.find(check => check.id === "engine" || check.id === "compatibility" ? check.status === "blocked" : false);
      if (!dependency.engineVersion || blocked) {
        throw new Error(`The skill updated, but engine readiness could not be verified. ${blocked?.message ?? "The engine version is unavailable."}`);
      }
      return {
        status: "succeeded",
        installedVersion,
        engineVersion: dependency.engineVersion,
        output: result.output,
        instruction: "Reload this coding agent or start a new agent session before using the updated skill.",
      };
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  }
}

async function discoverPlan(input: {
  selectedCliPath: string;
  resolvedCliPath: string;
  appRoot: string;
  targetSkillVersion: string;
}, home: string, env: Environment): Promise<{ status: "eligible"; plan: Omit<QuickUpdatePlan, "planId">; fingerprint: string } | QuickUpdateGuidance> {
  const selected = path.resolve(input.selectedCliPath);
  const relativeOverride = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "DSH_HOME", "HERMES_HOME"]
    .find(name => env[name] && !path.isAbsolute(env[name]!));
  if (relativeOverride) {
    return guidance(selected, `${relativeOverride} is relative, so the official updater scope cannot be matched unambiguously. Use an absolute provider configuration path or update outside this panel.`);
  }
  const projectRoot = await findProjectRoot(input.appRoot);
  const candidates = [
    ...providerSkillsDirectories(home, "personal", env).map(item => ({ ...item, scope: "personal" as const })),
    ...providerSkillsDirectories(projectRoot, "project", env).map(item => ({ ...item, scope: "project" as const })),
  ];
  const match = candidates.find(candidate => selected === path.join(candidate.skillsDir, "impeccable", "scripts", "impeccable"));
  if (!match) {
    return guidance(selected, "This launcher is not a conventional upstream-recognized copied installation. Use its original marketplace, link, legacy, or custom update method.");
  }
  if (await pathHasLink(match.scope === "personal" ? home : projectRoot, selected) || await realpath(selected).catch(() => "") !== selected) {
    return guidance(selected, "Linked installations and paths with linked ancestors must be updated from their source checkout.");
  }
  if (await realpath(input.resolvedCliPath).catch(() => "") !== selected) {
    return guidance(selected, "The selected launcher identity no longer matches the copied installation.");
  }
  const scopeRoot = match.scope === "personal" ? home : projectRoot;
  const affected: AffectedInstallation[] = [];
  const identities: string[] = [];
  for (const candidate of providerSkillsDirectories(scopeRoot, match.scope, env)) {
    const skill = path.join(candidate.skillsDir, "impeccable");
    const skillStat = await lstat(skill).catch(() => null);
    if (!skillStat) continue;
    if (!isWithin(scopeRoot, skill)) {
      return guidance(selected, `The ${candidate.provider} installation uses a custom provider directory outside this scope, so automatic scoped updating is unavailable.`);
    }
    if (!skillStat.isDirectory() || skillStat.isSymbolicLink() || await pathHasLink(scopeRoot, skill)) {
      return guidance(selected, `The ${candidate.provider} installation in this scope is linked or unsupported, so the official scoped updater cannot be offered safely.`);
    }
    const entries = await readdir(candidate.skillsDir).catch(() => []);
    if (entries.some(name => name !== "impeccable" && (name === "teach-impeccable" || name.endsWith("-impeccable")))) {
      return guidance(selected, `The ${candidate.provider} scope contains a legacy or ambiguous Impeccable installation. Use the official updater directly after reviewing that scope.`);
    }
    const cli = path.join(skill, "scripts", "impeccable");
    const version = await readInstalledSkillVersion(cli);
    if (!version) return guidance(selected, `The ${candidate.provider} installation has no unambiguous skill version metadata.`);
    const identity = await Promise.all([
      statIdentity(skill), fileIdentity(path.join(skill, "SKILL.md")), fileIdentity(cli), fileIdentity(path.join(skill, "scripts", "VERSION")),
    ]);
    affected.push({ provider: candidate.provider, path: skill, version });
    identities.push(`${skill}:${identity.join(":")}`);
  }
  if (!affected.some(item => selected === path.join(item.path, "scripts", "impeccable"))) {
    return guidance(selected, "The selected copied installation is no longer present in the official updater scope.");
  }
  affected.sort((left, right) => left.path.localeCompare(right.path));
  identities.sort();
  const plan = {
    status: "eligible" as const,
    scope: match.scope,
    scopeLabel: match.scope === "personal" ? "personal installations" : "project installations",
    selectedPath: selected,
    workingDirectory: projectRoot,
    affectedInstallations: affected,
    targetSkillVersion: input.targetSkillVersion,
    updaterVersion: QUICK_UPDATE_VERSION,
  };
  return { status: "eligible", plan, fingerprint: JSON.stringify({ ...plan, identities }) };
}

function providerSkillsDirectories(root: string, scope: QuickUpdateScope, env: Environment): Array<{ provider: string; skillsDir: string }> {
  return PROVIDERS.map(provider => {
    if (scope === "project") return { provider, skillsDir: path.join(root, provider, "skills") };
    switch (provider) {
      case ".agent": return { provider, skillsDir: path.join(root, ".gemini", "config", "skills") };
      case ".devin": return { provider, skillsDir: path.join(env.XDG_CONFIG_HOME || path.join(root, ".config"), "devin", "skills") };
      case ".dsh": return { provider, skillsDir: path.join(validHomeOverride(env.DSH_HOME, root) ?? path.join(root, ".dsh"), "skills") };
      case ".hermes": return { provider, skillsDir: path.join(validHomeOverride(env.HERMES_HOME, root) ?? path.join(root, ".hermes"), "skills") };
      case ".pi": return { provider, skillsDir: path.join(root, ".pi", "agent", "skills") };
      case ".omp": return { provider, skillsDir: path.join(root, ".omp", "agent", "skills") };
      case ".opencode": return { provider, skillsDir: path.join(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(root, ".config"), "opencode"), "skills") };
      default: return { provider, skillsDir: path.join(root, provider, "skills") };
    }
  });
}

function validHomeOverride(value: string | undefined, home: string): string | null {
  if (!value) return null;
  const resolved = path.resolve(value);
  return isWithin(home, resolved) ? resolved : null;
}

async function findProjectRoot(appRoot: string): Promise<string> {
  let cursor = await realpath(appRoot);
  while (true) {
    if (await lstat(path.join(cursor, ".git")).then(() => true, () => false)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return await realpath(appRoot);
    cursor = parent;
  }
}

async function pathHasLink(root: string, target: string): Promise<boolean> {
  const relation = path.relative(root, target);
  if (!isWithin(root, target)) return true;
  let cursor = root;
  for (const part of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) return true;
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation));
}

async function statIdentity(value: string): Promise<string> {
  const info = await stat(value);
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

async function fileIdentity(value: string): Promise<string> {
  const [info, content] = await Promise.all([stat(value), readFile(value)]);
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${createHash("sha256").update(content).digest("hex")}`;
}

function guidance(selectedPath: string, reason: string): QuickUpdateGuidance {
  return { status: "guidance", selectedPath, reason };
}

async function resolveTrustedNpm(explicit?: string): Promise<string> {
  const candidate = path.resolve(explicit ?? path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm"));
  if (path.dirname(candidate) !== path.dirname(process.execPath)) throw new Error("The trusted npm executable must come from the active Node.js runtime.");
  await access(candidate, fsConstants.X_OK).catch(() => { throw new Error("The active Node.js runtime does not provide a trusted npm executable."); });
  const info = await stat(await realpath(candidate));
  if (!info.isFile()) throw new Error("The trusted npm path is not a file.");
  return candidate;
}

async function verifyAcquiredUpdater(toolRoot: string): Promise<string> {
  const lock: unknown = JSON.parse(await readFile(path.join(toolRoot, "package-lock.json"), "utf8"));
  const packages = lock && typeof lock === "object" && "packages" in lock ? (lock as { packages?: Record<string, unknown> }).packages : null;
  const main = lockPackage(packages ?? null, "node_modules/impeccable");
  if (main?.version !== QUICK_UPDATE_VERSION || main.integrity !== PACKAGE_INTEGRITY) {
    throw new Error("The acquired updater did not match the reviewed impeccable@4.8.2 package integrity.");
  }
  const os = process.platform === "win32" ? "windows" : process.platform;
  const target = `${os}-${process.arch}`;
  const platformPackage = `@impeccable/cli-${target}`;
  const engine = lockPackage(packages ?? null, `node_modules/${platformPackage}`);
  if (engine?.version !== "0.1.21" || engine.integrity !== ENGINE_INTEGRITIES[target]) {
    throw new Error("The acquired updater did not match the reviewed Impeccable engine 0.1.21 package integrity.");
  }
  const cli = path.join(toolRoot, "node_modules", "impeccable", "cli", "bin", "cli.js");
  const info = await lstat(cli);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The acquired updater CLI is not a regular package file.");
  const enginePath = path.join(toolRoot, "node_modules", platformPackage, "bin", process.platform === "win32" ? "impeccable.exe" : "impeccable");
  const engineInfo = await lstat(enginePath);
  if (!engineInfo.isFile() || engineInfo.isSymbolicLink()) throw new Error("The acquired updater engine is not a regular package file.");
  await access(enginePath, fsConstants.X_OK);
  return enginePath;
}

function lockPackage(packages: Record<string, unknown> | null, suffix: string): { version?: unknown; integrity?: unknown } | undefined {
  if (!packages) return undefined;
  const matches = Object.entries(packages).filter(([name]) => name === suffix || name.endsWith(`/${suffix}`));
  return matches.length === 1 ? matches[0][1] as { version?: unknown; integrity?: unknown } : undefined;
}

export function runUpdaterProcess(request: RunRequest, timeoutMs: number, environment: Environment = process.env): Promise<RunResult> {
  if (request.signal.aborted) return Promise.reject(new Error("The update was cancelled before it started."));
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanNpmEnvironment(environment),
    });
    let output = "";
    let settled = false;
    let forced: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => terminate(new Error("The official updater timed out. Its changes were not rolled back.")), timeoutMs);
    const abort = () => terminate(new Error("The update was cancelled. Any changes already made by the updater were not rolled back."));
    request.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", finishError);
    child.on("close", code => forced ? finishError(forced) : finish(code ?? -1));

    function append(chunk: Buffer): void {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_OUTPUT) output = Buffer.from(output).subarray(-MAX_OUTPUT).toString("utf8");
      output = redactLog(output);
    }
    function terminate(error: Error): void {
      if (settled || forced) return;
      forced = error;
      signalChild("SIGTERM");
      killTimer = setTimeout(() => signalChild("SIGKILL"), 1_000);
    }
    function signalChild(signal: NodeJS.Signals): void {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { child.kill(signal); }
    }
    function cleanup(): void {
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      request.signal.removeEventListener("abort", abort);
    }
    function finish(code: number): void { if (!settled) { cleanup(); resolve({ code, output: output.trim() }); } }
    function finishError(error: Error): void { if (!settled) { cleanup(); reject(error); } }
  });
}

function cleanNpmEnvironment(source: Environment): NodeJS.ProcessEnv {
  const blocked = new Set(["IMPECCABLE_BIN", "IMPECCABLE_DOWNLOAD_BASE", "IMPECCABLE_SKILL_DIR"]);
  return Object.fromEntries(Object.entries(source).filter(([name]) => !name.toLowerCase().startsWith("npm_config_") && !blocked.has(name))
    .concat([["npm_config_update_notifier", "false"]]));
}
