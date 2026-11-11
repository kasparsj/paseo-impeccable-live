import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveContainedDirectory } from "./local-project.ts";

export interface DevelopmentTarget {
  id: string;
  appRoot: string;
  appPath: string;
  previewRoot?: string;
  previewPath?: string;
  command: string;
  args: string[];
  displayCommand: string;
  manager: string;
  script: string | null;
  evidence: string[];
  expectedUrls: string[];
}

export interface DiscoveryChoice {
  id: string;
  label: string;
  detail: string;
}

export type DiscoveryResult =
  | { kind: "resolved"; target: DevelopmentTarget }
  | { kind: "selection-required"; message: string; choices: DiscoveryChoice[] }
  | { kind: "unsupported"; message: string };

export interface DiscoveryOverrides {
  appPath?: string;
  command?: string;
  args?: string[];
  selectionId?: string;
}

interface PackageFile {
  packageManager?: unknown;
  scripts?: unknown;
}

interface AppCandidate {
  root: string;
  relative: string;
  pkg: PackageFile;
  raw: string;
}

interface CommandCandidate {
  target: DevelopmentTarget;
  automatic: boolean;
}

interface PreviewCandidate {
  root: string;
  path: string;
  relativeToLaunch: string;
  metadata: unknown;
  expectedUrls: string[];
}

interface PackageManagerDeclaration {
  manager: "npm" | "pnpm" | "yarn" | "bun";
  version: string;
}

class UnsupportedDiscoveryError extends Error {}

const SKIPPED_DIRECTORIES = new Set([
  ".cache", ".git", ".next", ".nuxt", ".omx", ".paseo", ".svelte-kit", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target",
]);
const LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"],
];
const SCRIPT_PRIORITY = ["dev", "start:dev", "serve", "start"];
const KNOWN_WEB_RUNNERS = /(^|[\s;&|])(?:vite|next\s+dev|astro\s+dev|nuxt\s+dev|svelte-kit\s+dev|react-scripts\s+start|webpack-dev-server)(?=$|[\s;&|])/i;
const ORCHESTRATOR = /(^|[\s;&|])(?:turbo|nx|concurrently|lerna|rush)(?:\s|$)|\b(?:pnpm|yarn|npm)\b[^;&|]*(?:--recursive|-r\b|workspaces?)/i;
const SHELL_WRAPPER_OR_CHAIN = /(^|\s)(?:sh|bash|zsh|fish|cmd|powershell|pwsh)(?:\s|$)|(?:&&|\|\||[;|<>`])/i;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const MUTATING_OPERATIONS = new Set(["install", "i", "add", "ci", "update", "upgrade", "remove", "uninstall", "link", "unlink", "dedupe", "rebuild", "import", "prepare", "publish", "deploy"]);
const DOWNLOAD_OPERATIONS = new Set(["exec", "dlx", "x"]);
const ROUTING_OPTIONS = new Set(["--prefix", "--workspace", "-w", "--dir", "-c", "--cwd", "--workspace-dir", "--filter", "-f"]);
const OPTIONS_WITH_VALUES = new Set([...ROUTING_OPTIONS, "--registry", "--userconfig", "--cache"]);
const MAX_DIRECTORIES = 500;
const MAX_DEPTH = 4;
const FRAMEWORK_CONFIG_NAMES = [
  "astro.config.js", "astro.config.mjs", "astro.config.cjs", "astro.config.ts", "astro.config.mts", "astro.config.cts",
  "next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts",
  "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs", "nuxt.config.ts",
  "svelte.config.js", "svelte.config.mjs", "svelte.config.cjs", "svelte.config.ts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "webpack.config.js", "webpack.config.mjs", "webpack.config.cjs", "webpack.config.ts",
];

export async function discoverDevelopment(
  workspaceRoot: string,
  overrides: DiscoveryOverrides = {},
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  abortIfNeeded(signal);
  const root = await realpath(workspaceRoot);
  const appRoots = overrides.appPath
    ? [await resolveContainedDirectory(root, overrides.appPath)]
    : await findPackageApplications(root, signal);

  if (overrides.command?.trim()) {
    if (overrides.args !== undefined && (!Array.isArray(overrides.args) || overrides.args.some((value) => typeof value !== "string"))) {
      return { kind: "unsupported", message: "Development command arguments must be a structured string list." };
    }
    const args = overrides.args ?? [];
    if (isDownloadLauncher(overrides.command, args) || hasForbiddenCommand([overrides.command, ...args].join(" "))) {
      return { kind: "unsupported", message: "The development command may not install or modify dependencies, prepare, publish, or deploy." };
    }
    const executable = await findExecutable(overrides.command);
    if (!executable) return { kind: "unsupported", message: `The development executable “${overrides.command}” is not available on PATH.` };
    const targets: DevelopmentTarget[] = [];
    const unsafeHooks: string[] = [];
    for (const appRoot of appRoots.length > 0 ? appRoots : [root]) {
      const unsafeHook = await unsafePackageManagerHook(appRoot, overrides.command, args);
      if (unsafeHook) { unsafeHooks.push(unsafeHook); continue; }
      const target = buildTarget({
        root,
        appRoot,
        command: executable,
        args,
        manager: "custom",
        script: null,
        evidence: ["Development command supplied in advanced settings."],
        metadata: { override: true },
      });
      targets.push(...await attachPreviewTargets(root, target));
    }
    if (targets.length === 0 && unsafeHooks.length > 0) {
      return { kind: "unsupported", message: `The selected package-manager command cannot be verified as a safe local development script (${unsafeHooks[0]}). Remove routing options or choose a direct executable under advanced settings.` };
    }
    return selectedOrResolved(targets, overrides.selectionId, true);
  }

  if (appRoots.length === 0) {
    return { kind: "unsupported", message: "No package.json application with a supported development command was found. Set a command under advanced settings." };
  }

  const candidates: CommandCandidate[] = [];
  const managerAmbiguities: DevelopmentTarget[] = [];
  const unavailableManagers = new Set<string>();
  for (const appRoot of appRoots) {
    abortIfNeeded(signal);
    const app = await readPackageCandidate(root, appRoot);
    if (!app) continue;
    let managers: string[];
    try {
      managers = await resolveManagers(root, app, signal);
    } catch (error) {
      if (error instanceof UnsupportedDiscoveryError) return { kind: "unsupported", message: error.message };
      throw error;
    }
    for (const manager of managers) {
      if (!(await findExecutable(manager))) {
        unavailableManagers.add(manager);
        continue;
      }
      const commands = await resolveCommands(root, app, manager);
      for (const candidate of commands) {
        const previewTargets = await attachPreviewTargets(root, candidate.target);
        for (const target of previewTargets) {
          candidates.push({ target, automatic: candidate.automatic });
          if (managers.length > 1) managerAmbiguities.push(target);
        }
      }
    }
  }

  const targets = dedupeTargets(candidates.map((candidate) => candidate.target));
  if (targets.length === 0) {
    if (unavailableManagers.size > 0) {
      return { kind: "unsupported", message: `The selected package manager is unavailable on PATH: ${[...unavailableManagers].sort().join(", ")}. Install it outside this integration or choose an existing executable under advanced settings.` };
    }
    return { kind: "unsupported", message: "No safe supported development command was found. Choose an executable and arguments under advanced settings." };
  }
  if (overrides.selectionId) return selectedOrResolved(targets, overrides.selectionId, true);
  const automatic = candidates.filter((candidate) => candidate.automatic).map((candidate) => candidate.target.id);
  if (targets.length === 1 && automatic.includes(targets[0].id) && managerAmbiguities.length === 0) {
    return { kind: "resolved", target: targets[0] };
  }
  return selection(targets, "Choose the application and development command to run.");
}

async function findPackageApplications(root: string, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRECTORIES) {
    abortIfNeeded(signal);
    const current = queue.shift()!;
    visited++;
    if (await exists(path.join(current.directory, "package.json"))) found.push(current.directory);
    if (current.depth >= MAX_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(current.directory, entry.name);
      try {
        if ((await lstat(child)).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      queue.push({ directory: child, depth: current.depth + 1 });
    }
  }
  return found.sort();
}

async function readPackageCandidate(workspaceRoot: string, appRoot: string): Promise<AppCandidate | null> {
  try {
    const raw = await readFile(path.join(appRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageFile;
    return { root: appRoot, relative: relativePath(workspaceRoot, appRoot), pkg, raw };
  } catch {
    return null;
  }
}

async function resolveManagers(workspaceRoot: string, app: AppCandidate, signal?: AbortSignal): Promise<string[]> {
  let declared: string | null = null;
  const lockManagers = new Set<string>();
  let cursor = app.root;
  while (true) {
    abortIfNeeded(signal);
    if (!declared) {
      try {
        const parsed = JSON.parse(await readFile(path.join(cursor, "package.json"), "utf8")) as PackageFile;
        if (typeof parsed.packageManager === "string") declared = parsePackageManagerDeclaration(parsed.packageManager).manager;
      } catch (error) {
        if (error instanceof UnsupportedDiscoveryError) throw error;
      }
    }
    for (const [file, manager] of LOCKFILES) {
      if (await exists(path.join(cursor, file))) {
        lockManagers.add(manager);
      }
    }
    if (cursor === workspaceRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isPathWithin(workspaceRoot, parent)) break;
    cursor = parent;
  }
  if (declared) {
    return [...new Set([declared, ...lockManagers])].sort((left, right) => left === declared ? -1 : right === declared ? 1 : left.localeCompare(right));
  }
  return lockManagers.size > 0 ? [...lockManagers].sort() : ["npm"];
}

async function resolveCommands(workspaceRoot: string, app: AppCandidate, manager: string): Promise<CommandCandidate[]> {
  const executable = await findExecutable(manager);
  if (!executable) return [];
  const scripts = stringScripts(app.pkg.scripts);
  const result: CommandCandidate[] = [];
  for (const script of SCRIPT_PRIORITY) {
    const body = scripts[script];
    if (!body) continue;
    const hooks = [scripts[`pre${script}`], body, scripts[`post${script}`]].filter((value): value is string => Boolean(value));
    if (hooks.some(hasForbiddenCommand)) continue;
    const known = KNOWN_WEB_RUNNERS.test(body);
    const automatic = script === "dev" && !ORCHESTRATOR.test(body) && !SHELL_WRAPPER_OR_CHAIN.test(body);
    const args = packageManagerArgs(manager, script);
    result.push({
      automatic,
      target: buildTarget({
        root: workspaceRoot,
        appRoot: app.root,
        command: executable,
        args,
        manager,
        script,
        evidence: [
          `${manager} selected from package manager metadata or lockfiles.`,
          `package.json script “${script}”: ${body}`,
          ...(automatic ? [known ? "Unique conventional web development script." : "Unique declared development script."] : ["Explicit selection required for this script."]),
        ],
        metadata: { package: app.raw, manager, script, body, hooks },
        expectedUrls: inferExpectedUrls(body),
      }),
    });
    break;
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (!name.startsWith("dev:") || [scripts[`pre${name}`], value, scripts[`post${name}`]].filter(Boolean).some(hasForbiddenCommand)) continue;
    result.push({
      automatic: false,
      target: buildTarget({ root: workspaceRoot, appRoot: app.root, command: executable, args: packageManagerArgs(manager, name), manager, script: name,
        evidence: [`${manager} selected from package manager metadata or lockfiles.`, `package.json script “${name}”: ${value}`, "Development variants require selection."],
        metadata: { package: app.raw, manager, script: name, body: value }, expectedUrls: inferExpectedUrls(value) }),
    });
  }
  return result;
}

function buildTarget(input: { root: string; appRoot: string; command: string; args: string[]; manager: string; script: string | null; evidence: string[]; metadata: unknown; expectedUrls?: string[] }): DevelopmentTarget {
  const appPath = relativePath(input.root, input.appRoot);
  const id = stableId({ appPath, command: input.command, args: input.args, manager: input.manager, script: input.script, metadata: input.metadata });
  return { id, appRoot: input.appRoot, appPath, command: input.command, args: [...input.args], displayCommand: formatCommand(input.command, input.args), manager: input.manager,
    script: input.script, evidence: [...input.evidence], expectedUrls: input.expectedUrls ?? [] };
}

async function attachPreviewTargets(workspaceRoot: string, target: DevelopmentTarget): Promise<DevelopmentTarget[]> {
  const previews = await findPreviewCandidates(workspaceRoot, target.appRoot);
  return previews.map((preview) => {
    const id = stableId({ launchId: target.id, previewRoot: preview.root, previewPath: preview.path, previewMetadata: preview.metadata });
    const previewEvidence = preview.relativeToLaunch === "."
      ? ["Preview target is the launch application."]
      : [`Preview target detected at “${preview.path}”.`];
    return {
      ...target,
      id,
      previewRoot: preview.root,
      previewPath: preview.path,
      evidence: [...target.evidence, ...previewEvidence],
      expectedUrls: target.expectedUrls.length > 0 ? target.expectedUrls : preview.expectedUrls,
    };
  });
}

async function findPreviewCandidates(workspaceRoot: string, launchRoot: string): Promise<PreviewCandidate[]> {
  const launch = await previewCandidate(workspaceRoot, launchRoot, launchRoot);
  if (launch) return [launch];

  const packages = await findPackageApplications(launchRoot);
  const children: PreviewCandidate[] = [];
  for (const packageRoot of packages) {
    if (packageRoot === launchRoot) continue;
    const candidate = await previewCandidate(workspaceRoot, launchRoot, packageRoot);
    if (candidate) children.push(candidate);
  }
  if (children.length > 0) return children.sort((left, right) => left.path.localeCompare(right.path));

  return [{
    root: launchRoot,
    path: relativePath(workspaceRoot, launchRoot),
    relativeToLaunch: ".",
    metadata: { fallback: "launch-application" },
    expectedUrls: [],
  }];
}

async function previewCandidate(workspaceRoot: string, launchRoot: string, candidateRoot: string): Promise<PreviewCandidate | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(candidateRoot);
  } catch {
    return null;
  }
  if (!isPathWithin(workspaceRoot, canonicalRoot) || !isPathWithin(launchRoot, canonicalRoot)) return null;

  const app = await readPackageCandidate(workspaceRoot, canonicalRoot);
  const scripts = stringScripts(app?.pkg.scripts);
  const directScripts = Object.entries(scripts)
    .filter(([name, body]) => (SCRIPT_PRIORITY.includes(name) || name.startsWith("dev:")) && directWebRunner(body))
    .sort(([left], [right]) => left.localeCompare(right));
  const files = [path.join(canonicalRoot, ".impeccable", "live", "config.json"), ...FRAMEWORK_CONFIG_NAMES.map((name) => path.join(canonicalRoot, name))];
  const configMetadata: Array<{ name: string; raw: string }> = [];
  for (const file of files) {
    try {
      const canonicalFile = await realpath(file);
      if (!isPathWithin(canonicalRoot, canonicalFile) || !(await lstat(canonicalFile)).isFile()) continue;
      configMetadata.push({ name: relativePath(canonicalRoot, canonicalFile), raw: await readFile(canonicalFile, "utf8") });
    } catch { /* Missing and escaped configuration files are not preview evidence. */ }
  }
  if (directScripts.length === 0 && configMetadata.length === 0) return null;

  const expectedUrls = directScripts.flatMap(([, body]) => inferExpectedUrls(body));
  return {
    root: canonicalRoot,
    path: relativePath(workspaceRoot, canonicalRoot),
    relativeToLaunch: relativePath(launchRoot, canonicalRoot),
    metadata: { package: app?.raw ?? null, directScripts, configs: configMetadata },
    expectedUrls: [...new Set(expectedUrls)],
  };
}

function selectedOrResolved(targets: DevelopmentTarget[], selectionId: string | undefined, staleIsSelection: boolean): DiscoveryResult {
  if (!selectionId) return targets.length === 1 ? { kind: "resolved", target: targets[0] } : selection(targets, "Choose the development command to run.");
  const target = targets.find((candidate) => candidate.id === selectionId);
  if (target) return { kind: "resolved", target };
  return staleIsSelection
    ? selection(targets, "The saved development choice changed. Choose it again.")
    : { kind: "unsupported", message: "The saved development choice is no longer valid." };
}

function selection(targets: DevelopmentTarget[], message: string): DiscoveryResult {
  return { kind: "selection-required", message, choices: targets.map((target) => {
    const preview = target.previewRoot && target.previewRoot !== target.appRoot ? ` → ${relativePath(target.appRoot, target.previewRoot)}` : "";
    const previewDetail = target.previewPath && target.previewPath !== target.appPath ? ` · preview ${target.previewPath}` : "";
    return { id: target.id, label: `${target.appPath} — ${target.script ?? "custom"}${preview}`, detail: `${target.displayCommand}${previewDetail}` };
  }) };
}

function stringScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeManager(value: string): PackageManagerDeclaration["manager"] | null {
  if (value === "npm" || value === "pnpm" || value === "yarn" || value === "bun") return value;
  return null;
}

function parsePackageManagerDeclaration(value: string): PackageManagerDeclaration {
  const separator = value.lastIndexOf("@");
  const manager = normalizeManager(separator > 0 ? value.slice(0, separator) : value);
  const versionWithIntegrity = separator > 0 ? value.slice(separator + 1) : "";
  const version = versionWithIntegrity.split("+", 1)[0];
  if (!manager) {
    throw new UnsupportedDiscoveryError(`The declared package manager “${value}” is not supported. Choose an already-installed executable under advanced settings.`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new UnsupportedDiscoveryError(`The packageManager declaration “${value}” must include an exact version so it can be verified without downloading anything.`);
  }
  return { manager, version };
}

/** Revalidates local launch metadata after external-server reuse is ruled out. */
export async function preflightTarget(target: DevelopmentTarget, workspaceRoot: string): Promise<void> {
  const root = await realpath(workspaceRoot);
  const appRoot = await resolveContainedDirectory(root, target.appPath);
  if (await realpath(target.appRoot) !== appRoot) {
    throw new Error("The selected development application changed. Run discovery again.");
  }
  if (target.previewPath || target.previewRoot) {
    if (!target.previewPath || !target.previewRoot) throw new Error("The selected preview application changed. Run discovery again.");
    let previewRoot: string;
    let recordedPreviewRoot: string;
    try {
      previewRoot = await resolveContainedDirectory(root, target.previewPath);
      recordedPreviewRoot = await realpath(target.previewRoot);
    } catch {
      throw new Error("The selected preview application changed. Run discovery again.");
    }
    if (!isPathWithin(appRoot, previewRoot) || recordedPreviewRoot !== previewRoot) {
      throw new Error("The selected preview application changed. Run discovery again.");
    }
    const currentPreviews = await findPreviewCandidates(root, appRoot);
    if (!currentPreviews.some((candidate) => candidate.root === previewRoot)) {
      throw new Error("The selected preview application changed. Run discovery again.");
    }
  }
  if (target.manager === "custom") {
    const unsafeHook = await unsafePackageManagerHook(appRoot, target.command, target.args);
    if (unsafeHook) {
      throw new Error(`The selected package-manager command changed to an unsafe script (${unsafeHook}). Refresh discovery and choose again.`);
    }
    return;
  }

  const declaration = await nearestPackageManagerDeclaration(appRoot, root);
  if (declaration && target.manager === declaration.manager) {
    const installedVersion = await installedManagerVersion(target.command, declaration.manager);
    if (!installedVersion) {
      throw new Error(`Cannot verify ${declaration.manager}@${declaration.version} from the installed executable. Corepack downloads are disabled; install that exact manager outside this integration or choose an explicit executable under advanced settings.`);
    }
    if (installedVersion !== declaration.version) {
      throw new Error(`The project requires ${declaration.manager}@${declaration.version}, but the selected installed executable is ${declaration.manager}@${installedVersion}. Install the exact version outside this integration or choose another executable under advanced settings.`);
    }
  }

  if (!target.script) return;
  const app = await readPackageCandidate(root, appRoot);
  if (!app) throw new Error("The selected package.json is no longer available. Run discovery again.");
  const scripts = stringScripts(app.pkg.scripts);
  const body = scripts[target.script];
  if (!body) throw new Error(`The selected package script “${target.script}” changed. Run discovery again.`);
  if ([scripts[`pre${target.script}`], body, scripts[`post${target.script}`]].filter((value): value is string => Boolean(value)).some(hasForbiddenCommand)) {
    throw new Error(`The selected package script “${target.script}” changed to an unsafe command. Refresh discovery and choose again.`);
  }
  const runner = directWebRunner(body);
  if (runner && !(await findRunnerExecutable(runner, appRoot, root))) {
    throw new Error(`The development runner “${runner}” is not installed. Install project dependencies outside this integration, or choose an existing executable under advanced settings.`);
  }
}

async function nearestPackageManagerDeclaration(appRoot: string, workspaceRoot: string): Promise<PackageManagerDeclaration | null> {
  let cursor = appRoot;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(cursor, "package.json"), "utf8")) as PackageFile;
      if (typeof pkg.packageManager === "string") return parsePackageManagerDeclaration(pkg.packageManager);
    } catch (error) {
      if (error instanceof UnsupportedDiscoveryError) throw error;
    }
    if (cursor === workspaceRoot) return null;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isPathWithin(workspaceRoot, parent)) return null;
    cursor = parent;
  }
}

async function installedManagerVersion(command: string, manager: string): Promise<string | null> {
  let cursor: string;
  try {
    cursor = path.dirname(await realpath(command));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 12; depth++) {
    try {
      const pkg = JSON.parse(await readFile(path.join(cursor, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === manager && typeof pkg.version === "string") return pkg.version;
    } catch { /* Walk only the existing package tree. */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function directWebRunner(body: string): string | null {
  if (SHELL_WRAPPER_OR_CHAIN.test(body)) return null;
  const tokens = body.trim().split(/\s+/);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift();
  const runner = executableName(tokens[0] ?? "");
  if (runner === "vite" || runner === "webpack-dev-server") return runner;
  if ((runner === "next" || runner === "astro" || runner === "nuxt" || runner === "svelte-kit") && tokens[1] === "dev") return runner;
  if (runner === "react-scripts" && tokens[1] === "start") return runner;
  return null;
}

async function findRunnerExecutable(runner: string, appRoot: string, workspaceRoot: string): Promise<string | null> {
  let cursor = appRoot;
  while (true) {
    const local = await findExecutable(path.join(cursor, "node_modules", ".bin", runner));
    if (local) return local;
    if (cursor === workspaceRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isPathWithin(workspaceRoot, parent)) break;
    cursor = parent;
  }
  return findExecutable(runner);
}

function packageManagerArgs(manager: string, script: string): string[] {
  return manager === "yarn" ? ["run", script] : ["run", script];
}

function inferExpectedUrls(body: string): string[] {
  const portMatch = body.match(/(?:--port(?:=|\s+)|-p\s+)(\d{2,5})(?=$|\s)/);
  const port = portMatch ? Number(portMatch[1])
    : /\b(?:next|nuxt)\s+dev\b/i.test(body) ? 3000
    : /\bastro\s+dev\b/i.test(body) ? 4321
    : /\bvite\b/i.test(body) ? 5173
    : null;
  if (!port || port > 65535) return [];
  const hostMatch = body.match(/--host(?:=|\s+)([^\s]+)/);
  const rawHost = hostMatch?.[1]?.replace(/^['"]|['"]$/g, "") ?? "localhost";
  const host = rawHost === "0.0.0.0" || rawHost === "::" ? "localhost" : rawHost;
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(host)) return [];
  return [`http://${host}:${port}/`];
}

function hasForbiddenCommand(value: string, depth = 0): boolean {
  const tokens = shellTokens(value);
  for (let index = 0; index < tokens.length; index++) {
    if (isShellSeparator(tokens[index])) continue;
    if (depth < 4 && /\s/.test(tokens[index]) && hasForbiddenCommand(tokens[index], depth + 1)) return true;
    const launcher = executableName(tokens[index]);
    if (launcher === "npx" || launcher === "bunx") return true;
    if (!PACKAGE_MANAGERS.has(launcher)) continue;
    const end = tokens.findIndex((token, tokenIndex) => tokenIndex > index && isShellSeparator(token));
    if (isUnsafePackageManagerArgs(tokens.slice(index + 1, end < 0 ? undefined : end))) return true;
  }
  return false;
}

function executableName(command: string): string {
  const base = path.basename(command).replace(/\.(?:cmd|bat|exe)$/i, "").toLowerCase();
  const packageManagerCli = base.match(/^(npm(?:-cli)?|npx(?:-cli)?|pnpm|yarn|bunx?)(?:\.(?:js|cjs|mjs))?$/);
  if (packageManagerCli?.[1]) return packageManagerCli[1].replace("-cli", "");
  return base;
}

function isDownloadLauncher(command: string, args: string[]): boolean {
  const launcher = executableName(command);
  if (launcher === "npx" || launcher === "bunx") return true;
  return PACKAGE_MANAGERS.has(launcher) && isUnsafePackageManagerArgs(args);
}

async function unsafePackageManagerHook(appRoot: string, command: string, args: string[]): Promise<string | null> {
  const manager = executableName(command);
  if (!PACKAGE_MANAGERS.has(manager)) return null;
  const invocation = parsePackageManagerArgs(args);
  if (invocation.routing) return "package-manager routing options";
  const operation = invocation.operation;
  const script = operation === "run"
    ? nextPositional(args, invocation.operationIndex + 1)
    : operation === "start" || operation === "dev" || operation === "serve" ? operation : null;
  if (!script) return "unverified package-manager operation";
  const app = await readPackageCandidate(appRoot, appRoot);
  if (!app) return "missing package metadata";
  const scripts = stringScripts(app.pkg.scripts);
  for (const [label, value] of [[`pre${script}`, scripts[`pre${script}`]], [script, scripts[script]], [`post${script}`, scripts[`post${script}`]]] as const) {
    if (value && hasForbiddenCommand(value)) return label;
  }
  return null;
}

function isUnsafePackageManagerArgs(args: string[]): boolean {
  if (args.some((token) => {
    const normalized = token.toLowerCase();
    return MUTATING_OPERATIONS.has(normalized) || DOWNLOAD_OPERATIONS.has(normalized);
  })) return true;
  const parsed = parsePackageManagerArgs(args);
  if (!parsed.operation) return false;
  if (MUTATING_OPERATIONS.has(parsed.operation) || DOWNLOAD_OPERATIONS.has(parsed.operation)) return true;
  if (parsed.operation === "run") {
    const script = nextPositional(args, parsed.operationIndex + 1)?.toLowerCase();
    return Boolean(script && (MUTATING_OPERATIONS.has(script) || DOWNLOAD_OPERATIONS.has(script)));
  }
  return false;
}

function parsePackageManagerArgs(args: string[]): { operation: string | null; operationIndex: number; routing: boolean } {
  const routing = args.some((token) => {
    const normalized = token.toLowerCase();
    const option = normalized.split("=", 1)[0];
    return ROUTING_OPTIONS.has(option) || /^-(?:w|c|f).+/.test(normalized);
  });
  for (let index = 0; index < args.length; index++) {
    const token = args[index].toLowerCase();
    if (token === "--") continue;
    if (!token.startsWith("-") || token === "-") return { operation: token, operationIndex: index, routing };
    const option = token.split("=", 1)[0];
    if (!token.includes("=") && OPTIONS_WITH_VALUES.has(option)) index++;
  }
  return { operation: null, operationIndex: -1, routing };
}

function nextPositional(args: string[], start: number): string | null {
  for (let index = start; index < args.length; index++) {
    const token = args[index];
    if (token === "--") continue;
    if (!token.startsWith("-") || token === "-") return token;
    const option = token.toLowerCase().split("=", 1)[0];
    if (!token.includes("=") && OPTIONS_WITH_VALUES.has(option)) index++;
  }
  return null;
}

function shellTokens(value: string): string[] {
  return (value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||[;|]|[^\s;&|]+/g) ?? [])
    .map((token) => {
      const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"));
      const value = quoted ? token.slice(1, -1) : token;
      return value.replace(/\\"/g, '"').replace(/\\'/g, "'");
    });
}

function isShellSeparator(token: string): boolean {
  return token === ";" || token === "|" || token === "&&" || token === "||";
}

async function findExecutable(command: string): Promise<string | null> {
  if (command.includes("/") || command.includes("\\")) {
    try { await access(command, fsConstants.X_OK); return await realpath(command); } catch { return null; }
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""]) {
      const candidate = path.join(directory, `${command}${suffix}`);
      try { await access(candidate, fsConstants.X_OK); return await realpath(candidate); } catch { /* Try next. */ }
    }
  }
  return null;
}

function stableId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => /^[A-Za-z0-9_./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg))].join(" ");
}

function relativePath(root: string, value: string): string {
  const relative = path.relative(root, value);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function isPathWithin(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Development discovery was canceled.");
}

function dedupeTargets(targets: DevelopmentTarget[]): DevelopmentTarget[] {
  return [...new Map(targets.map((target) => [target.id, target])).values()];
}
