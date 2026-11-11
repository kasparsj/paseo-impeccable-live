import type { DevelopmentStatus } from "../shared/live.ts";
import type { DevelopmentTarget } from "./dev-discovery.ts";
import { validateLocalUrl } from "./local-project.ts";
import { ProcessGuardian } from "./process-guardian.ts";
import { checkAbort, deadlineSignal } from "./abort.ts";

type Source = "stdout" | "stderr" | "system";
export interface LogLine { sequence: number; attempt: number; source: Source; text: string; time: string }
const MAX_BYTES = 128 * 1024;
const MAX_LINES = 500;

export function redactLog(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|api[_-]?key|password|secret|signature)=)[^\s&#]*/gi, "$1[redacted]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export class DevelopmentLog {
  private lines: LogLine[] = [];
  private sequence = 0;
  private bytes = 0;
  private dropped = false;
  private attempt = 0;

  beginAttempt(attempt: number): void { this.attempt = attempt; }

  append(source: Source, text: string): void {
    if (Buffer.byteLength(text) > MAX_BYTES) { text = Buffer.from(text).subarray(-MAX_BYTES).toString("utf8"); this.dropped = true; }
    for (const raw of redactLog(text).split(/\r?\n|\r/)) {
      if (!raw) continue;
      const line = Buffer.from(raw).subarray(-8192).toString("utf8");
      if (line !== raw) this.dropped = true;
      this.lines.push({ sequence: ++this.sequence, attempt: this.attempt, source, text: line, time: new Date().toISOString() });
      this.bytes += Buffer.byteLength(line);
      while (this.lines.length > MAX_LINES || this.bytes > MAX_BYTES) {
        this.bytes -= Buffer.byteLength(this.lines.shift()!.text); this.dropped = true;
      }
    }
  }

  read(cursor = 0, available = true) {
    const first = this.lines[0]?.sequence ?? this.sequence + 1;
    const reset = cursor > this.sequence || (cursor > 0 && cursor < first - 1);
    return { lines: this.lines.filter(line => reset || line.sequence > cursor), cursor: this.sequence, attempt: this.attempt,
      reset, truncated: this.dropped, available };
  }
}

export function extractLocalUrls(output: string): string[] {
  const urls: string[] = [];
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const match of clean.matchAll(/http:\/\/(?:\[[^\]\s]+\](?::\d{1,5})?|[^\s<>"'`/]+)(?:\/[^\s<>"'`]*)?/gi)) {
    try {
      const parsed = new URL(match[0].replace(/[),.;]+$/, ""));
      if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") parsed.hostname = "127.0.0.1";
      const url = validateLocalUrl(parsed.toString());
      if (!urls.includes(url)) urls.push(url);
    } catch { /* A network URL in runner output is not a local preview. */ }
  }
  return urls.slice(0, 16);
}

export class ProbeError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent = false) { super(message); this.permanent = permanent; }
}

/** Redirects are validated before fetching, so no request is sent outside loopback. */
export async function probeLocalUrl(value: string, signal?: AbortSignal, timeoutMs = 2000): Promise<string> {
  let url = validateLocalUrl(value);
  const deadline = deadlineSignal(timeoutMs, signal);
  const combined = deadline.signal;
  try {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal: combined, headers: { Accept: "text/html" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new ProbeError("The preview has an invalid or excessive redirect chain.", true);
      url = validateLocalUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ProbeError(`The preview needs authentication (HTTP ${response.status}).`, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProbeError(`The preview returned HTTP ${response.status}.`);
    }
    const html = /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") ?? "");
    if (!html) { await response.body?.cancel(); throw new ProbeError("The preview did not serve an HTML page.", true); }
    const reader = response.body?.getReader();
    if (!reader) throw new ProbeError("The preview returned an empty page.");
    let bytes = 0;
    try {
      while (bytes < 4096) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!bytes) throw new ProbeError("The preview returned an empty page.");
    return url;
  }
  throw new ProbeError("The preview could not be verified.");
  } finally { deadline.dispose(); }
}

export const stoppedDevelopment = (): DevelopmentStatus => ({ phase: "stopped", ownership: "none", appRoot: null,
  command: null, url: null, verified: false, pid: null, message: "Development server is stopped." });

export class DevelopmentServer {
  readonly logs = new DevelopmentLog();
  private state = stoppedDevelopment();
  private process: ProcessGuardian | null = null;
  private partial = { stdout: "", stderr: "" };
  private urls = new Set<string>();
  private exited = false;
  private health: ReturnType<typeof setInterval> | null = null;
  private healthBusy = false;
  private healthAbort: AbortController | null = null;
  private generation = 0;
  private targetId: string | null = null;

  private readonly changed: () => void;
  private readonly startupMs: number;
  constructor(changed: () => void = () => {}, startupMs = 60_000) { this.changed = changed; this.startupMs = startupMs; }

  get guardian(): ProcessGuardian {
    if (!this.process) this.process = new ProcessGuardian({
      onOutput: (source, text) => this.output(source, text),
      onExit: (code, signal) => {
        this.exited = true;
        this.set({ phase: "error", verified: false, message: `Development server exited (${signal ?? code ?? "unknown"}). Use Connect again to retry.` });
        this.logs.append("system", this.state.message);
      },
    });
    return this.process;
  }

  snapshot(): DevelopmentStatus { return { ...this.state }; }
  describe(target: DevelopmentTarget, url: string | null = null): void {
    if (this.state.ownership !== "none") return;
    this.set({ phase: "stopped", appRoot: target.appRoot, previewRoot: target.previewRoot ?? target.appRoot,
      command: target.displayCommand, url, verified: false,
      message: "Ready to connect to the selected application." });
  }
  matchesTarget(target: DevelopmentTarget): boolean { return this.targetId === target.id; }
  releaseExternal(): void {
    if (this.state.ownership !== "external") return;
    this.generation++;
    this.stopHealth();
    this.targetId = null;
    this.state = stoppedDevelopment();
    this.changed();
  }
  mark(phase: DevelopmentStatus["phase"], message: string): void { this.set({ phase, message }); }
  private set(patch: Partial<DevelopmentStatus>): void { this.state = { ...this.state, ...patch }; this.changed(); }

  private output(source: Source, text: string): void {
    if (source === "system") { this.logs.append(source, text); return; }
    // Search the raw bounded buffer, before redacting tokens in the visible copy.
    const buffer = (this.partial[source] + text).slice(-32768);
    for (const url of extractLocalUrls(buffer)) this.urls.add(url);
    while (this.urls.size > 16) this.urls.delete(this.urls.values().next().value!);
    const end = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
    this.partial[source] = end >= 0 ? buffer.slice(end + 1) : buffer.slice(-8192);
    this.logs.append(source, text);
  }

  useExternal(target: DevelopmentTarget, url: string, logsAvailable = false): void {
    this.targetId = target.id;
    this.generation++;
    this.stopHealth();
    this.set({ phase: "ready", ownership: "external", appRoot: target.appRoot, previewRoot: target.previewRoot ?? target.appRoot, command: target.displayCommand,
      url: validateLocalUrl(url), verified: true, pid: null,
      message: logsAvailable ? "Reusing a development server started outside this plugin." : "Reusing an external development server. Its output is not available here." });
    this.logs.append("system", this.state.message);
    this.monitor();
  }

  async startOwned(target: DevelopmentTarget, override: string | undefined, signal: AbortSignal): Promise<{ kind: "ready"; url: string } | { kind: "selection-required"; urls: string[] }> {
    this.targetId = target.id;
    const generation = ++this.generation;
    this.stopHealth();
    if (this.exited) await this.process?.stopDevelopment();
    checkAbort(signal);
    if (!this.state.pid || this.exited) {
      this.urls.clear(); this.partial = { stdout: "", stderr: "" }; this.exited = false;
      this.set({ phase: "starting", ownership: "owned", appRoot: target.appRoot, previewRoot: target.previewRoot ?? target.appRoot, command: target.displayCommand,
        url: null, verified: false, pid: null, message: `Starting ${target.displayCommand}…` });
      this.logs.append("system", this.state.message);
      const started = await this.guardian.startDevelopment({ command: target.command, args: target.args, cwd: target.appRoot,
        env: { COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "1" } });
      this.set({ pid: started.pid });
    }
    checkAbort(signal);
    this.mark("verifying", "Waiting for the development server to serve an HTML page…");
    const timeout = deadlineSignal(this.startupMs, signal);
    const lifetime = timeout.signal;
    let lastError = "No local URL was emitted. Set a preview URL under Advanced settings if this command does not print one.";
    try {
    while (!lifetime.aborted && generation === this.generation) {
      if (this.exited) throw new Error(this.state.message);
      // Defaults are only prelaunch reuse hints. They cannot associate a responder
      // with this process, even if the default port was free before we spawned it.
      const candidates = override ? [validateLocalUrl(override)] : [...this.urls];
      const ready: string[] = [];
      for (const candidate of candidates.slice(0, 16)) {
        try {
          const url = await probeLocalUrl(candidate, lifetime);
          if (!ready.includes(url)) ready.push(url);
        } catch (error) {
          lastError = error instanceof Error ? error.message : "Preview verification failed.";
          if (error instanceof ProbeError && error.permanent) throw error;
        }
      }
      checkAbort(lifetime);
      if (this.exited) throw new Error(this.state.message);
      if (generation !== this.generation) throw new Error("Development server startup was canceled.");
      if (ready.length > 1) {
        this.mark("selection-required", "This command serves several local pages. Choose the app preview.");
        return { kind: "selection-required", urls: ready };
      }
      if (ready.length === 1) {
        this.set({ phase: "ready", url: ready[0], verified: true, message: "Development server is ready." });
        this.monitor();
        return { kind: "ready", url: ready[0] };
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); lifetime.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); lifetime.removeEventListener("abort", abort); reject(new Error("Startup was canceled.")); };
        const timer = setTimeout(finish, 200);
        lifetime.addEventListener("abort", abort, { once: true });
      });
    }
    } catch (error) {
      if (!lifetime.aborted) throw error;
    } finally { timeout.dispose(); }
    checkAbort(signal);
    throw new Error(`Development server did not become ready within ${Math.round(this.startupMs / 1000)} seconds. ${lastError}`);
  }

  private monitor(): void {
    const generation = this.generation;
    this.healthAbort = new AbortController();
    const signal = this.healthAbort.signal;
    this.health = setInterval(() => {
      if (this.healthBusy || !this.state.url || !this.state.verified) return;
      this.healthBusy = true;
      void probeLocalUrl(this.state.url, signal).catch(() => {
        if (generation === this.generation && !signal.aborted) this.set({ phase: "error", verified: false,
          message: "The development server is no longer reachable. Use Connect again to reconnect." });
      }).finally(() => { this.healthBusy = false; });
    }, 5000);
    this.health.unref();
  }

  private stopHealth(): void {
    if (this.health) clearInterval(this.health);
    this.health = null; this.healthAbort?.abort(); this.healthAbort = null;
  }

  fail(error: unknown): void {
    this.set({ phase: "error", verified: false, message: redactLog(error instanceof Error ? error.message : "Development server failed.").slice(0, 1000) });
    this.logs.append("system", this.state.message);
  }

  async stop(): Promise<void> {
    this.generation++; this.stopHealth();
    if (this.state.ownership === "external") return;
    this.mark("stopping", "Stopping the owned development server…");
    try { await this.process?.stopDevelopment(); }
    catch (error) { this.fail(error); throw error; }
    this.exited = false;
    this.targetId = null;
    this.state = { ...stoppedDevelopment(), appRoot: this.state.appRoot, previewRoot: this.state.previewRoot, command: this.state.command };
    this.logs.append("system", this.state.message); this.changed();
  }

  async shutdown(): Promise<void> {
    this.generation++; this.stopHealth();
    await this.process?.shutdown();
    this.process = null;
  }
}
