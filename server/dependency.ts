import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactLog } from "./dev-server.ts";

export type DependencyCheck = {
  id: "installation" | "engine" | "compatibility";
  status: "ready" | "blocked" | "warning";
  message: string;
  detail?: string;
};

export type DependencyInspection = {
  cliPath: string | null;
  selectedCliPath: string | null;
  engineVersion: string | null;
  checks: DependencyCheck[];
};

type ResolveOptions = {
  workspaceRoot?: string;
  appRoot?: string;
  override?: string;
  home?: string;
};

type InspectOptions = ResolveOptions & { signal?: AbortSignal };

const CLI_RELATIVE_PATHS = [
  path.join(".agents", "skills", "impeccable", "scripts", "impeccable"),
  path.join(".claude", "skills", "impeccable", "scripts", "impeccable"),
] as const;
const PERSONAL_RELATIVE_PATHS = [
  path.join(".agents", "skills", "impeccable", "scripts", "impeccable"),
  path.join(".codex", "skills", "impeccable", "scripts", "impeccable"),
  path.join(".claude", "skills", "impeccable", "scripts", "impeccable"),
] as const;
const MAX_PROBE_OUTPUT = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const ENGINE_RESPONSE = /^impeccable-engine ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export async function resolveDependencyCli(options: ResolveOptions = {}): Promise<string> {
  return (await resolveDependencySelection(options)).resolved;
}

async function resolveDependencySelection(options: ResolveOptions = {}): Promise<{ selected: string; resolved: string }> {
  if (!["linux", "darwin", "freebsd"].includes(process.platform)) {
    throw new Error("Impeccable helper automation requires a Linux, macOS or FreeBSD development host.");
  }
  if (options.override !== undefined && options.override.trim()) {
    if (!path.isAbsolute(options.override)) throw new Error("The selected Impeccable executable path must be absolute.");
    const resolved = await executableFile(options.override).catch(() => null);
    if (!resolved) throw new Error("The selected Impeccable executable is unavailable or not executable.");
    return { selected: path.resolve(options.override), resolved };
  }

  const candidates: Array<{ path: string; workspace: boolean }> = [];
  if (options.workspaceRoot && options.appRoot) {
    const workspaceRoot = await realpath(options.workspaceRoot);
    const appRoot = await realpath(options.appRoot);
    if (!isWithin(workspaceRoot, appRoot)) throw new Error("The preview app is outside the selected workspace.");
    let current = appRoot;
    while (true) {
      for (const relative of CLI_RELATIVE_PATHS) candidates.push({ path: path.join(current, relative), workspace: true });
      if (current === workspaceRoot) break;
      const parent = path.dirname(current);
      if (parent === current || !isWithin(workspaceRoot, parent)) break;
      current = parent;
    }
  }
  const personalRoot = options.home ?? homedir();
  for (const relative of PERSONAL_RELATIVE_PATHS) candidates.push({ path: path.join(personalRoot, relative), workspace: false });

  for (const candidate of candidates) {
    const resolved = await executableFile(candidate.path).catch(() => null);
    if (!resolved) continue;
    if (candidate.workspace && options.workspaceRoot) {
      const workspaceRoot = await realpath(options.workspaceRoot);
      if (!isWithin(workspaceRoot, resolved)) continue;
    }
    return { selected: candidate.path, resolved };
  }
  throw new Error("No installed Impeccable skill launcher was found.");
}

export async function inspectDependency(options: InspectOptions): Promise<DependencyInspection> {
  let cliPath: string;
  let selectedCliPath: string;
  try {
    const selection = await resolveDependencySelection(options);
    cliPath = selection.resolved;
    selectedCliPath = selection.selected;
  } catch (error) {
    const detail = safeDetail(error);
    return {
      cliPath: null,
      selectedCliPath: null,
      engineVersion: null,
      checks: [
        { id: "installation", status: "blocked", message: "Install Impeccable or locate an existing installation.", ...(detail ? { detail } : {}) },
        { id: "engine", status: "warning", message: "The Impeccable engine cannot be checked until its skill launcher is available." },
        { id: "compatibility", status: "warning", message: "Compatibility cannot be checked until the Impeccable engine is available." },
      ],
    };
  }

  if (!options.override?.trim() && options.workspaceRoot && isWithin(await realpath(options.workspaceRoot), cliPath)) {
    return {
      cliPath, selectedCliPath, engineVersion: null,
      checks: [{ id: "installation", status: "blocked",
        message: "A project-local Impeccable launcher was detected. Select it explicitly before running it with the daemon's permissions.", detail: cliPath }],
    };
  }

  const installation: DependencyCheck = {
    id: "installation", status: "ready", message: "Impeccable launcher found.", detail: cliPath,
  };
  let engineVersion: string;
  try {
    const output = await runEngineProbe(cliPath, options.appRoot ?? options.workspaceRoot ?? path.dirname(cliPath), options.signal);
    const match = ENGINE_RESPONSE.exec(output.trim());
    if (!match) throw new Error("The executable did not return a valid Impeccable engine identity.");
    engineVersion = match[1];
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Dependency inspection was cancelled.");
    const detail = safeDetail(error);
    return {
      cliPath, selectedCliPath,
      engineVersion: null,
      checks: [
        installation,
        { id: "engine", status: "blocked", message: "The Impeccable launcher was found, but its engine could not be verified.", ...(detail ? { detail } : {}) },
        { id: "compatibility", status: "warning", message: "Compatibility cannot be checked until the Impeccable engine is available." },
      ],
    };
  }

  const pinnedVersion = await readPinnedVersion(cliPath);
  let compatibility: DependencyCheck;
  if (pinnedVersion && pinnedVersion !== engineVersion) {
    compatibility = {
      id: "compatibility", status: "blocked", message: "The Impeccable engine does not match the installed skill.",
      detail: `Skill expects ${pinnedVersion}; engine reported ${engineVersion}.`,
    };
  } else {
    compatibility = {
      id: "compatibility", status: "warning", message: "Live protocol compatibility has not been verified for this engine version.",
      detail: pinnedVersion ? `Skill and engine both report ${engineVersion}.` : `Engine reported ${engineVersion}; the skill has no readable VERSION metadata.`,
    };
  }
  return {
    cliPath, selectedCliPath,
    engineVersion,
    checks: [installation, { id: "engine", status: "ready", message: `Impeccable engine ${engineVersion} is available.` }, compatibility],
  };
}

async function executableFile(candidate: string): Promise<string> {
  const resolved = await realpath(candidate);
  await access(resolved, fsConstants.X_OK);
  if (!(await stat(resolved)).isFile()) throw new Error("not a file");
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation));
}

async function readPinnedVersion(cliPath: string): Promise<string | null> {
  try {
    const value = (await readFile(path.resolve(path.dirname(cliPath), "VERSION"), "utf8")).trim();
    return ENGINE_RESPONSE.test(`impeccable-engine ${value}`) ? value : null;
  } catch {
    return null;
  }
}

function safeDetail(error: unknown): string | undefined {
  const message = redactLog(error instanceof Error ? error.message : String(error)).trim();
  return message ? Buffer.from(message).subarray(0, 2_048).toString("utf8") : undefined;
}

function runEngineProbe(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Dependency inspection was cancelled."));
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["engine-probe"], {
      cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IMPECCABLE_LAUNCHER_PROBE: "1", COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forced: Error | null = null;
    const timer = setTimeout(() => terminate(new Error("The Impeccable engine check timed out.")), PROBE_TIMEOUT_MS);
    const abort = () => terminate(new Error("Dependency inspection was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    child.on("error", finish);
    child.on("close", code => {
      if (forced) finish(forced);
      else if (code === 0) finish(null);
      else finish(new Error(`Engine check exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
    });

    function append(stream: "stdout" | "stderr", chunk: Buffer): void {
      const current = stream === "stdout" ? stdout : stderr;
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_PROBE_OUTPUT) {
        terminate(new Error("The Impeccable engine check produced too much output."));
      } else if (stream === "stdout") stdout = next;
      else stderr = next;
    }
    function terminate(error: Error): void {
      if (settled || forced) return;
      forced = error;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }
    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    }
  });
}
