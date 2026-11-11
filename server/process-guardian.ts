import { spawnProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;

export interface GuardianCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProcessGuardianOptions {
  onOutput?: (source: "stdout" | "stderr" | "system", text: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
}

interface GuardianResponse {
  type: "response";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface GuardianEvent {
  type: "output" | "dev-exit";
  source?: "stdout" | "stderr" | "system";
  text?: string;
  code?: number | null;
  signal?: string | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs in a separate Node process. Keep this function capture-free: Paseo may
 * bundle the plugin, so the guardian cannot depend on sibling source files.
 */
async function guardianMain(): Promise<void> {
  const childProcess = process.getBuiltinModule("node:child_process");
  const crypto = process.getBuiltinModule("node:crypto");
  const fs = process.getBuiltinModule("node:fs/promises");
  const path = process.getBuiltinModule("node:path");
  const MAX_OUTPUT = 1024 * 1024;
  type OwnedHelper = { pid: number; port: number; token: string; command: string; baseArgs: string[]; cwd: string; env?: NodeJS.ProcessEnv };
  type Running = import("node:child_process").ChildProcess;
  let dev: Running | null = null;
  let devPid: number | null = null;
  let devLaunch: Promise<void> | null = null;
  let stoppingDev: Promise<void> | null = null;
  let helper: OwnedHelper | null = null;
  let helperBoot: Promise<{ stdout: string; stderr: string }> | null = null;
  let closing = false;
  let cleanupTask: Promise<void> | null = null;
  let diagnosticRoot: string | null = null;
  let diagnosticBytes = 0;

  const send = (message: unknown) => {
    if (typeof process.send === "function" && process.connected) {
      try { process.send(message); } catch { /* Parent already left. */ }
    }
  };
  const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 1000) : "Guardian operation failed.";
  const diagnose = async (text: string) => {
    if (!diagnosticRoot) return;
    try {
      const directory = path.join(diagnosticRoot, ".impeccable/live");
      await fs.mkdir(directory, { recursive: true });
      const line = `${new Date().toISOString()} ${text.slice(0, 1000)}\n`;
      if (diagnosticBytes + Buffer.byteLength(line) > 32 * 1024) return;
      const file = path.join(directory, "guardian.log");
      if (diagnosticBytes === 0) await fs.writeFile(file, line);
      else await fs.appendFile(file, line);
      diagnosticBytes += Buffer.byteLength(line);
    } catch { /* Diagnostics must not prevent cleanup. */ }
  };
  const validCommand = (value: unknown): value is { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record.command === "string" && record.command.length > 0 && Array.isArray(record.args)
      && record.args.every((arg) => typeof arg === "string") && typeof record.cwd === "string" && path.isAbsolute(record.cwd)
      && (record.timeoutMs === undefined || (Number.isSafeInteger(record.timeoutMs) && Number(record.timeoutMs) > 0 && Number(record.timeoutMs) <= 120_000));
  };
  const isCommandScript = (value: string) => /\.(cmd|bat)$/i.test(value);
  const spawnOwned = (input: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }, detached: boolean) => {
    if (process.platform === "win32" && isCommandScript(input.command)) {
      throw new Error("Windows .cmd and .bat commands are unsupported; configure the executable or Node CLI entry point directly.");
    }
    return childProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      shell: false,
      windowsHide: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const append = (current: string, chunk: Buffer) => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > MAX_OUTPUT) throw new Error("Command output exceeded 1 MiB.");
    return next;
  };
  const runCommand = (input: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let child: Running;
    try { child = spawnOwned(input, false); } catch (error) { reject(error); return; }
    let stdout = "";
    let stderr = "";
    let failed: Error | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      failed = new Error("Command timed out.");
      child.kill("SIGKILL");
    }, input.timeoutMs ?? 30_000);
    child.stdout?.on("data", (chunk: Buffer) => { try { stdout = append(stdout, chunk); } catch (error) { failed = error as Error; child.kill("SIGKILL"); } });
    child.stderr?.on("data", (chunk: Buffer) => { try { stderr = append(stderr, chunk); } catch (error) { failed = error as Error; child.kill("SIGKILL"); } });
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
      else resolve({ stdout, stderr });
    });
  });
  const readHelper = async (cwd: string) => {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(cwd, ".impeccable/live/server.json"), "utf8")) as Record<string, unknown>;
      if (!Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || !Number.isSafeInteger(raw.port) || Number(raw.port) <= 0 || typeof raw.token !== "string" || raw.token.length === 0) return null;
      return { pid: Number(raw.pid), port: Number(raw.port), token: raw.token };
    } catch { return null; }
  };
  const sameHelper = (left: { pid: number; port: number; token: string }, right: { pid: number; port: number; token: string }) => left.pid === right.pid && left.port === right.port && left.token === right.token;
  const helperCarriesBootMarker = async (pid: number, marker: string) => {
    const expected = `IMPECCABLE_GUARDIAN_BOOT_ID=${marker}`;
    if (process.platform === "linux") {
      try {
        const environment = await fs.readFile(`/proc/${pid}/environ`, "utf8");
        return environment.split("\0").includes(expected);
      } catch { return false; }
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      try {
        const result = await runCommand({ command: "ps", args: ["eww", "-p", String(pid), "-o", "command="], cwd: process.cwd(), timeoutMs: 2_000 });
        return result.stdout.split(/\s+/).includes(expected);
      } catch { return false; }
    }
    return false;
  };
  const pidAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  const stopHelper = async () => {
    await diagnose(`stop-helper owned=${helper ? "yes" : "no"}`);
    if (!helper) return;
    const current = await readHelper(helper.cwd);
    if (!current) {
      const recordExists = await fs.access(path.join(helper.cwd, ".impeccable/live/server.json")).then(() => true, () => false);
      if (recordExists) throw new Error("The helper record is invalid; the guardian refused to stop it.");
      if (pidAlive(helper.pid)) throw new Error("The owned helper record is missing while its process is still running; the guardian retained ownership and refused blind cleanup.");
      const owned = helper;
      await runCommand({ command: owned.command, args: [...owned.baseArgs, "live-inject", "--remove"], cwd: owned.cwd, env: owned.env, timeoutMs: 10_000 });
      helper = null; return;
    }
    if (!sameHelper(current, helper)) throw new Error("The helper identity changed, so the guardian refused to stop it.");
    const owned = helper;
    await runCommand({ command: owned.command, args: [...owned.baseArgs, "live-server", "stop"], cwd: owned.cwd, env: owned.env, timeoutMs: 10_000 });
    const remaining = await readHelper(owned.cwd);
    if (remaining && sameHelper(remaining, owned)) throw new Error("The owned helper did not stop.");
    await waitUntil(() => pidAlive(owned.pid), 500);
    if (pidAlive(owned.pid)) throw new Error("The owned helper removed its record but its retained process is still running.");
    helper = null;
  };
  const groupAlive = (pid: number) => {
    try { process.kill(-pid, 0); return true; } catch { return false; }
  };
  const waitUntil = async (check: () => boolean, timeoutMs: number) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (!check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  };
  const stopDevelopment = async () => {
    if (stoppingDev) return stoppingDev;
    stoppingDev = (async () => {
      const child = dev;
      await devLaunch?.catch(() => undefined);
      const pid = devPid ?? child?.pid ?? null;
      if (!pid) { dev = null; return; }
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          const killer = childProcess.spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            killer.kill();
            reject(new Error("taskkill timed out while stopping the owned development process tree."));
          }, 5_000);
          killer.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          });
          killer.once("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0 || code === 128) resolve();
            else reject(new Error(`taskkill exited with code ${code}.`));
          });
        });
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch { /* The group may already be gone. */ }
        await waitUntil(() => groupAlive(pid), 500);
        if (groupAlive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* The group raced to exit. */ } }
        // After SIGKILL, group membership can remain observable briefly while
        // init reaps orphaned descendants, especially under concurrent tests.
        await waitUntil(() => groupAlive(pid), 2_000);
        if (groupAlive(pid)) throw new Error("The owned development process group did not exit.");
      }
      child?.removeAllListeners();
      dev = null;
      devPid = null;
      devLaunch = null;
    })();
    try { await stoppingDev; } finally { stoppingDev = null; }
  };
  const cleanup = (): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    closing = true;
    cleanupTask = (async () => {
      await diagnose(`cleanup-start boot=${helperBoot ? "yes" : "no"} launch=${devLaunch ? "yes" : "no"}`);
      const errors: string[] = [];
      await devLaunch?.catch((error) => errors.push(safeError(error)));
      await stopDevelopment().catch((error) => errors.push(safeError(error)));
      await helperBoot?.catch((error) => errors.push(safeError(error)));
      await diagnose(`cleanup-after-boot owned=${helper ? "yes" : "no"}`);
      await stopHelper().catch((error) => errors.push(safeError(error)));
      if (errors.length) send({ type: "output", source: "system", text: `Guardian cleanup: ${errors.join(" ")}` });
      await diagnose(`cleanup-finished errors=${errors.join(" ") || "none"}`);
    })();
    return cleanupTask;
  };

  process.on("message", async (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; id?: unknown; op?: unknown; input?: unknown };
    if (request.type !== "request" || !Number.isSafeInteger(request.id) || typeof request.op !== "string") return;
    const respond = (ok: boolean, value?: unknown, error?: string) => send({ type: "response", id: request.id, ok, value, error });
    try {
      if (closing && request.op !== "shutdown") throw new Error("The guardian is shutting down.");
      if (request.op === "start-development") {
        if (!validCommand(request.input)) throw new Error("Invalid development command.");
        if (devPid) throw new Error("A development process is already running.");
        const input = request.input;
        diagnosticRoot = input.cwd;
        const child = spawnOwned(input, process.platform !== "win32");
        dev = child;
        devPid = child.pid ?? null;
        devLaunch = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.stdout?.on("data", (chunk: Buffer) => send({ type: "output", source: "stdout", text: chunk.toString("utf8").slice(-65_536) }));
        child.stderr?.on("data", (chunk: Buffer) => send({ type: "output", source: "stderr", text: chunk.toString("utf8").slice(-65_536) }));
        child.once("close", (code, signal) => {
          send({ type: "dev-exit", code, signal });
          if (dev === child) {
            dev = null;
            // The server may leave descendants behind. Reap the owned group now,
            // before its process-group id can become stale or be reused.
            void stopDevelopment().catch((error) => diagnose(`exit cleanup failed: ${safeError(error)}`));
          }
        });
        try { await devLaunch; }
        catch (error) {
          if (dev === child) { dev = null; devPid = null; devLaunch = null; }
          throw error;
        }
        devPid = child.pid ?? devPid;
        if (!devPid) throw new Error("Development process started without a PID.");
        if (closing) {
          await stopDevelopment();
          throw new Error("The guardian shut down while the development process was starting.");
        }
        respond(true, { pid: devPid });
      } else if (request.op === "command") {
        if (!validCommand(request.input)) throw new Error("Invalid command.");
        respond(true, await runCommand(request.input));
      } else if (request.op === "boot-helper") {
        if (!["linux", "darwin", "freebsd"].includes(process.platform)) {
          throw new Error("Impeccable helper automation requires a Linux, macOS or FreeBSD host so failed-startup process ownership can be verified. No helper was started.");
        }
        if (!validCommand(request.input)) throw new Error("Invalid helper command.");
        if (helper || helperBoot) throw new Error("A helper is already owned or starting.");
        const input = request.input;
        const liveIndex = input.args.lastIndexOf("live");
        const trailing = input.args.slice(liveIndex + 1);
        if (liveIndex < 0 || (trailing.length !== 0 && !(trailing.length === 2 && trailing[0] === "--target"))) {
          throw new Error("Helper boot requires the live verb with an optional explicit app target.");
        }
        if (trailing.length) {
          const selectedRoot = await fs.realpath(path.resolve(input.cwd, trailing[1]));
          const cwd = await fs.realpath(input.cwd);
          if (selectedRoot !== cwd) throw new Error("The helper target must match its selected app directory.");
        }
        if (await fs.access(path.join(input.cwd, ".impeccable/live/server.json")).then(() => true, () => false)) {
          throw new Error("A helper record already exists; the guardian refused to adopt it.");
        }
        diagnosticRoot = input.cwd;
        send({ type: "output", source: "system", text: "Helper boot started." });
        const bootMarker = crypto.randomBytes(32).toString("hex");
        const helperInput = { ...input, env: { ...process.env, ...(input.env ?? {}), IMPECCABLE_LAUNCHER_PROBE: "1", IMPECCABLE_GUARDIAN_BOOT_ID: bootMarker }, timeoutMs: input.timeoutMs ?? 30_000 };
        const claimBootRecord = async () => {
          const record = await readHelper(input.cwd);
          if (!record) return false;
          if (!await helperCarriesBootMarker(record.pid, bootMarker)) {
            await diagnose("boot record did not carry the owned attempt marker; refusing adoption");
            return false;
          }
          helper = { ...record, command: input.command, baseArgs: input.args.slice(0, liveIndex), cwd: input.cwd, env: helperInput.env };
          return true;
        };
        helperBoot = (async () => {
          try {
            const result = await runCommand(helperInput);
            // Claim the record before parsing the probe response. A boot attempt
            // can create the helper and then emit malformed or mismatched output.
            await claimBootRecord();
            const boot = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
            if (boot.ok !== true) {
              if (boot.error === "target_selection_required") throw new Error("Impeccable Live needs a concrete preview app. Choose the app from the development target choices; the launch command can remain at the workspace root.");
              throw new Error(`Impeccable Live could not start: ${typeof boot.error === "string" ? boot.error.replace(/[_-]+/g, " ").slice(0, 200) : "preflight failed"}. Check the app's Product, Design and Live configuration.`);
            }
            if (!Number.isSafeInteger(boot.serverPort) || typeof boot.serverToken !== "string") throw new Error("Helper boot returned an invalid identity.");
            let owned = helper as OwnedHelper | null;
            if (!owned) {
              // A successful probe also supplies an unguessable ownership token.
              // Failed boots on these hosts use the per-attempt process marker.
              const record = await readHelper(input.cwd);
              if (record && record.port === Number(boot.serverPort) && record.token === boot.serverToken) {
                owned = { ...record, command: input.command, baseArgs: input.args.slice(0, liveIndex), cwd: input.cwd, env: helperInput.env };
                helper = owned;
              }
            }
            if (!owned || owned.port !== Number(boot.serverPort) || owned.token !== boot.serverToken) throw new Error("Helper boot identity did not match its record.");
            return result;
          } catch (error) {
            // A failed command can still have launched a detached helper. The
            // inherited marker proves the recorded process came from this owned
            // attempt, and stopHelper revalidates the exact identity so a later
            // replacement remains untouched. Retain ownership if cleanup fails
            // so shutdown can retry.
            if (!helper) await claimBootRecord();
            if (helper) {
              try { await stopHelper(); }
              catch (cleanupError) {
                await diagnose(`failed boot cleanup: ${safeError(cleanupError)}`);
                throw new Error(`${safeError(error)} Cleanup also failed: ${safeError(cleanupError)}`);
              }
            }
            throw error;
          }
        })();
        try { respond(true, await helperBoot); } finally { helperBoot = null; }
      } else if (request.op === "stop-helper") {
        await helperBoot;
        await stopHelper();
        respond(true, {});
      } else if (request.op === "release-helper") {
        if (helper) {
          const current = await readHelper(helper.cwd);
          if (current && sameHelper(current, helper)) throw new Error("Cannot release a helper that is still running.");
          if (current) throw new Error("Cannot release ownership after the helper identity changed.");
          const recordExists = await fs.access(path.join(helper.cwd, ".impeccable/live/server.json")).then(() => true, () => false);
          if (recordExists) throw new Error("Cannot release ownership while the helper record is invalid.");
          if (pidAlive(helper.pid)) throw new Error("Cannot release a helper whose retained process is still running.");
        }
        helper = null;
        respond(true, {});
      } else if (request.op === "stop-development") {
        await stopDevelopment();
        respond(true, {});
      } else if (request.op === "shutdown") {
        await cleanup();
        respond(true, {});
        setImmediate(() => process.exit(0));
      } else throw new Error("Unknown guardian operation.");
    } catch (error) { respond(false, undefined, safeError(error)); }
  });
  process.once("disconnect", () => { void cleanup().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
  send({ type: "ready" });
}

export class ProcessGuardian {
  private readonly child: ChildProcess;
  private readonly options: ProcessGuardianOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private nextId = 1;
  private closed = false;
  private _devPid: number | null = null;

  constructor(options: ProcessGuardianOptions = {}) {
    this.options = options;
    const source = `(${guardianMain.toString()})().catch((error) => { console.error(error); process.exit(1); });`;
    this.child = spawnProcess(process.execPath, ["-e", source], {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The process guardian did not become ready.")), 5_000);
      const onMessage = (message: unknown) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") {
          clearTimeout(timer);
          this.child.off("message", onMessage);
          resolve();
        }
      };
      this.child.on("message", onMessage);
      this.child.once("error", (error) => { clearTimeout(timer); reject(error); });
      this.child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Process guardian exited before ready (${code ?? signal ?? "unknown"}).`)); });
    });
    this.child.on("message", (message) => this.onMessage(message));
    this.child.stdout?.on("data", (chunk: Buffer) => this.options.onOutput?.("system", chunk.toString("utf8").slice(-65_536)));
    this.child.stderr?.on("data", (chunk: Buffer) => this.options.onOutput?.("system", chunk.toString("utf8").slice(-65_536)));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.rejectPending(new Error(`Process guardian exited (${code ?? signal ?? "unknown"}).`));
    });
  }

  get devPid(): number | null { return this._devPid; }
  get hasDevelopment(): boolean { return this._devPid !== null; }

  async startDevelopment(input: GuardianCommand): Promise<{ pid: number }> {
    const value = await this.request("start-development", input) as { pid: number };
    this._devPid = value.pid;
    return value;
  }

  command(input: GuardianCommand): Promise<{ stdout: string; stderr: string }> {
    return this.request("command", input, Math.max(REQUEST_TIMEOUT_MS, (input.timeoutMs ?? 30_000) + 5_000)) as Promise<{ stdout: string; stderr: string }>;
  }

  bootHelper(input: GuardianCommand): Promise<{ stdout: string; stderr: string }> {
    return this.request("boot-helper", input, Math.max(REQUEST_TIMEOUT_MS, (input.timeoutMs ?? 30_000) + 5_000)) as Promise<{ stdout: string; stderr: string }>;
  }

  async stopHelper(): Promise<void> { await this.request("stop-helper", {}); }
  async releaseHelper(): Promise<void> { await this.request("release-helper", {}); }

  async stopDevelopment(): Promise<void> {
    await this.request("stop-development", {});
    this._devPid = null;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try { await this.request("shutdown", {}, 45_000); } finally {
      this.closed = true;
      this._devPid = null;
      this.child.disconnect?.();
    }
  }

  private async request(op: string, input: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    await this.ready;
    if (this.closed || !this.child.connected || typeof this.child.send !== "function") throw new Error("The process guardian is unavailable.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Guardian ${op} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send?.({ type: "request", id, op, input }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const event = message as GuardianResponse | GuardianEvent;
    if (event.type === "response") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(event.id);
      if (event.ok) pending.resolve(event.value);
      else pending.reject(new Error(event.error || "Guardian operation failed."));
    } else if (event.type === "output" && event.source && typeof event.text === "string") {
      this.options.onOutput?.(event.source, event.text);
    } else if (event.type === "dev-exit") {
      this._devPid = null;
      this.options.onExit?.(event.code ?? null, event.signal ?? null);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
