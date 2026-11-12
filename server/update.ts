import { readFile } from "node:fs/promises";
import path from "node:path";

export type UpdateStatus = "available" | "current" | "unknown" | "disabled" | "unavailable";

export type UpdateCheck = {
  status: UpdateStatus;
  installedVersion: string | null;
  latestVersion: string | null;
};

type CheckOptions = { cliPath: string | null; appRoot: string; force?: boolean };
type Environment = Record<string, string | undefined>;
type CachedVersion = { version: string; checkedAt: number };

const VERSION_URL = "https://impeccable.style/api/version";
const CACHE_MS = 24 * 60 * 60 * 1_000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1_000;
const TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 8 * 1_024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class UpdateChecker {
  private cache: CachedVersion | null = null;
  private failureAt: number | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly env: Environment;
  private readonly now: () => number;

  constructor(fetcher: typeof fetch = fetch, env: Environment = process.env, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.env = env;
    this.now = now;
  }

  async check(options: CheckOptions): Promise<UpdateCheck> {
    const installedVersion = await readInstalledSkillVersion(options.cliPath);
    if (await updateCheckDisabled(options.appRoot, this.env)) {
      return { status: "disabled", installedVersion, latestVersion: null };
    }
    if (!installedVersion) return { status: "unknown", installedVersion: null, latestVersion: null };

    let latestVersion: string;
    try {
      latestVersion = await this.latest(Boolean(options.force));
    } catch {
      return { status: "unavailable", installedVersion, latestVersion: null };
    }
    return {
      status: compareSemver(latestVersion, installedVersion) > 0 ? "available" : "current",
      installedVersion,
      latestVersion,
    };
  }

  private async latest(force: boolean): Promise<string> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.checkedAt < CACHE_MS) return this.cache.version;
    if (!force && this.failureAt !== null && now - this.failureAt < FAILURE_BACKOFF_MS) {
      throw new Error("Update check is in failure backoff.");
    }
    if (this.inFlight) return this.inFlight;

    const request = this.fetchLatest().then(version => {
      this.cache = { version, checkedAt: this.now() };
      this.failureAt = null;
      return version;
    }).catch(error => {
      this.failureAt = this.now();
      throw error;
    }).finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
    this.inFlight = request;
    return request;
  }

  private async fetchLatest(): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Update check timed out."));
      }, TIMEOUT_MS);
    });
    try {
      const operation = (async () => {
        const response = await this.fetcher(VERSION_URL, {
          signal: controller.signal, redirect: "error", headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Update check returned HTTP ${response.status}.`);
        const body = await readBoundedBody(response, controller.signal);
        const parsed: unknown = JSON.parse(body);
        const version = parsed && typeof parsed === "object" && "skills" in parsed
          ? (parsed as { skills?: unknown }).skills : null;
        if (typeof version !== "string" || !parseSemver(version)) throw new Error("Update check returned an invalid version.");
        return version;
      })();
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function readInstalledSkillVersion(cliPath: string | null): Promise<string | null> {
  if (!cliPath) return null;
  try {
    const content = await readFile(path.resolve(path.dirname(cliPath), "..", "SKILL.md"), "utf8");
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/.exec(content)?.[1];
    if (!frontmatter) return null;
    let inMetadata = false;
    let metadataIndent: number | null = null;
    let metadataVersion: string | null = null;
    let legacyVersion: string | null = null;
    for (const line of frontmatter.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const indent = line.match(/^[ \t]*/)?.[0].replaceAll("\t", "  ").length ?? 0;
      if (indent === 0) {
        inMetadata = /^metadata:\s*(?:#.*)?$/.test(line);
        metadataIndent = null;
        const match = /^version:\s*(.+?)\s*$/.exec(line);
        if (match) legacyVersion = unquote(match[1].trim());
        continue;
      }
      if (!inMetadata) continue;
      metadataIndent ??= indent;
      if (indent !== metadataIndent) continue;
      const match = /^version:\s*(.+?)\s*$/.exec(line.trim());
      if (match) metadataVersion = unquote(match[1].trim());
    }
    const version = metadataVersion ?? legacyVersion;
    return version && parseSemver(version) ? version : null;
  } catch {
    return null;
  }
}

async function updateCheckDisabled(appRoot: string, env: Environment): Promise<boolean> {
  if (env.IMPECCABLE_NO_UPDATE_CHECK) return true;
  let enabled: boolean | undefined;
  for (const name of ["config.json", "config.local.json"]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(appRoot, ".impeccable", name), "utf8"));
      const value = parsed && typeof parsed === "object" ? (parsed as { updateCheck?: unknown }).updateCheck : undefined;
      if (typeof value === "boolean") enabled = value;
    } catch {
      // Missing or malformed project configuration does not disable checks.
    }
  }
  return enabled === false;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

type ParsedSemver = { core: [string, string, string]; prerelease: string[] };

function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { core: [match[1], match[2], match[3]], prerelease: match[4]?.split(".") ?? [] };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("Cannot compare invalid semantic versions.");
  for (let index = 0; index < 3; index++) {
    const order = compareNumericIdentifier(a.core[index], b.core[index]);
    if (order !== 0) return order;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return compareNumericIdentifier(av, bv);
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Update response is too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel("Update check aborted."); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("Update response is too large.");
        throw new Error("Update response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}
