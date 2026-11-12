import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveDependencyCli } from "./dependency.ts";
import { checkAbort } from "./abort.ts";
import { isWithin, resolveContainedDirectory, validateLocalUrl } from "./local-project.ts";
import type { retryRpc, startRpc, statusRpc, stopRpc } from "../shared/live";

export type BridgeStartInput = { workspaceId: string; agentId: string; appPath: string; url: string; cliPath?: string; exactAppRoot?: boolean; signal?: AbortSignal };
type StartInput = BridgeStartInput;
type BindingInput = RpcInput<typeof statusRpc>;

export interface LivePublicStatus {
  active: boolean;
  phase: string;
  message: string;
  appRoot: string | null;
  url: string | null;
  agentId: string | null;
  pendingEvent: string | null;
}

interface HelperIdentity {
  pid: number;
  port: number;
  token: string;
}

export interface RunBinding {
  workspaceId: string;
  agentId: string;
  workspaceRoot: string;
  appRoot: string;
  url: string;
  cliPath: string;
}

interface ActiveRun extends RunBinding {
  helper: HelperIdentity;
  agent: PaseoAgentHandle;
  abort: AbortController;
  pollTask: Promise<void> | null;
  pendingEvent: unknown | null;
  generation: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export class LiveBridge {
  private active: ActiveRun | null = null;
  private publicStatus: LivePublicStatus = idleStatus();
  private serial: Promise<void> = Promise.resolve();
  private generation = 0;

  private readonly lifecycle?: {
    boot(binding: RunBinding): Promise<unknown>;
    stop(binding: RunBinding): Promise<void>;
  };
  constructor(lifecycle?: LiveBridge["lifecycle"]) { this.lifecycle = lifecycle; }

  /** Snapshot reads must remain responsive while startup or agent calls are pending. */
  peek(input: BindingInput): LivePublicStatus {
    if (this.active) this.assertBinding(input, this.active);
    return this.snapshot();
  }

  clearStoppedStatus(): void {
    if (this.active) throw new Error("Stop Impeccable Live before changing its binding.");
    this.publicStatus = idleStatus();
  }

  updatePreviewUrl(input: BindingInput, url: string): LivePublicStatus {
    const run = this.requireActive(input);
    run.url = validateLocalUrl(url);
    this.publicStatus = { ...this.publicStatus, url: run.url };
    return this.snapshot();
  }

  start(input: StartInput, paseo: PaseoApi): Promise<LivePublicStatus> {
    return this.serialize(async () => {
      try {
        return await this.startNow(input, paseo);
      } catch (error) {
        if (!this.active && this.publicStatus.phase === "starting") {
          this.publicStatus = {
            ...this.publicStatus,
            phase: "error",
            message: publicErrorMessage(error, "Impeccable Live could not start. Fix the setup and try again."),
          };
        }
        throw error;
      }
    });
  }

  private async startNow(input: StartInput, paseo: PaseoApi): Promise<LivePublicStatus> {
      if (this.active) {
        this.assertBinding(input, this.active);
        const requested = await resolveRunBinding(input, paseo);
        if (sameConfiguration(requested, this.active)) {
          return this.snapshot();
        }
        throw safeError("Impeccable Live is already running with different settings. Stop it before changing configuration.");
      }

      this.publicStatus = statusOf("starting", "Validating Impeccable Live…", null);
      const binding = await resolveRunBinding(input, paseo);
      checkAbort(input.signal);
      this.publicStatus = statusOf("starting", "Starting Impeccable Live…", binding);

      const preexisting = await readHelperRecord(binding.appRoot);
      if (preexisting.kind !== "missing") {
        this.publicStatus = statusOf("collision", "An Impeccable Live helper already exists for this app. Stop it outside this plugin or choose another app.", binding);
        throw safeError(this.publicStatus.message);
      }

      const boot = this.lifecycle ? await this.lifecycle.boot(binding) : await runJsonCommand(binding.cliPath, ["live", "--target", binding.appRoot], binding.appRoot);
      checkAbort(input.signal);
      assertBootSucceeded(boot);
      const helper = await readHelperIdentity(binding.appRoot);
      if (!helper) {
        await runJsonCommand(binding.cliPath, ["live-inject", "--remove"], binding.appRoot).catch(() => undefined);
        throw safeError("Impeccable started without a verifiable helper identity.");
      }
      assertBootIdentity(boot, helper);

      const agent = paseo.agents.ref(binding.agentId);
      try {
        await boundedRefreshBoundAgent(agent, binding.workspaceId, input.signal);
        checkAbort(input.signal);
      } catch (error) {
        const current = await readHelperIdentity(binding.appRoot);
        if (current && sameHelper(current, helper)) {
          await this.stopHelper(binding).catch(() => undefined);
        }
        throw error;
      }
      const run: ActiveRun = {
        ...binding,
        helper,
        agent,
        abort: new AbortController(),
        pollTask: null,
        pendingEvent: null,
        generation: ++this.generation,
      };
      this.active = run;
      this.publicStatus = statusOf("running", "Impeccable Live is waiting for browser events.", run);
      run.pollTask = this.poll(run);
      return this.snapshot();
  }

  status(input: BindingInput): Promise<LivePublicStatus> {
    return this.serialize(async () => {
      if (this.active) this.assertBinding(input, this.active);
      return this.snapshot();
    });
  }

  retry(input: RpcInput<typeof retryRpc>): Promise<LivePublicStatus> {
    return this.serialize(async () => {
      const run = this.requireActive(input);
      if (this.publicStatus.phase === "dispatching" || this.publicStatus.phase === "completion-checking") {
        throw safeError("Event delivery or completion checking is already in progress.");
      }
      if (!run.pendingEvent) {
        throw safeError("There is no retained Impeccable event to retry.");
      }
      const event = run.pendingEvent;
      if (this.publicStatus.phase === "completion-paused") {
        this.publicStatus = statusOf("completion-checking", "Checking whether Impeccable completion cleanup finished…", run, eventLabel(event));
        run.pollTask = this.resumeAfterCompletion(run, event);
        return this.snapshot();
      }
      this.publicStatus = statusOf("dispatching", "Retrying event delivery; the earlier delivery may still have succeeded.", run, eventLabel(event));
      run.pollTask = this.retryDelivery(run, event);
      return this.snapshot();
    });
  }

  private async retryDelivery(run: ActiveRun, event: unknown): Promise<void> {
    try {
      await abortable(() => refreshBoundAgent(run.agent, run.workspaceId), run.abort.signal, 30_000, "Agent refresh was not confirmed in time.");
      if (this.active !== run || run.abort.signal.aborted) return;
      await deliverAgentEvent(run, event, true);
    } catch {
      if (this.active !== run || run.abort.signal.aborted) return;
      this.publicStatus = statusOf("dispatch-paused", "Retry was not accepted. The event is retained; retry can duplicate work if an earlier delivery succeeded.", run, eventLabel(event));
      return;
    }
    if (this.active !== run || run.abort.signal.aborted) return;
    if (await this.pauseForCompletionGate(run, event)) return;
    run.pendingEvent = null;
    this.publicStatus = statusOf("running", "Event delivery was accepted and the agent turn finished.", run);
    await this.poll(run);
  }

  private async resumeAfterCompletion(run: ActiveRun, event: unknown): Promise<void> {
    if (await this.pauseForCompletionGate(run, event)) return;
    if (this.active !== run || run.abort.signal.aborted) return;
    run.pendingEvent = null;
    this.publicStatus = statusOf("running", "Impeccable completion cleanup is confirmed; polling resumed.", run);
    await this.poll(run);
  }

  private async pauseForCompletionGate(run: ActiveRun, event: unknown): Promise<boolean> {
    if (!completionRequired(event)) return false;
    let pending = true;
    try {
      const status = await runJsonCommand(run.cliPath, ["live-status"], run.appRoot, run.abort.signal);
      pending = completionStillPending(status, event);
    } catch {
      pending = true;
    }
    if (!pending || this.active !== run || run.abort.signal.aborted) return false;
    run.pendingEvent = event;
    this.publicStatus = statusOf("completion-paused", "Agent work finished, but Impeccable still requires live-complete cleanup. Polling remains paused; retry rechecks the gate without resending the event.", run, eventLabel(event));
    return true;
  }

  stop(input: RpcInput<typeof stopRpc>): Promise<LivePublicStatus> {
    if (this.active && input.workspaceId === this.active.workspaceId && input.agentId === this.active.agentId) {
      this.active.abort.abort();
    }
    return this.serialize(() => this.stopOwned(input));
  }

  shutdown(): Promise<void> {
    this.active?.abort.abort();
    return this.serialize(async () => {
      if (!this.active) return;
      await this.stopOwned({ workspaceId: this.active.workspaceId, agentId: this.active.agentId });
    });
  }

  /** The guardian owns helper cleanup during plugin teardown; only stop local polling here. */
  async quiesce(): Promise<void> {
    const run = this.active;
    run?.abort.abort();
    await run?.pollTask?.catch(() => undefined);
    if (this.active === run) this.active = null;
  }

  private async stopOwned(input: BindingInput): Promise<LivePublicStatus> {
    const run = this.requireActive(input);
    this.publicStatus = statusOf("stopping", "Stopping Impeccable Live…", run, run.pendingEvent ? eventLabel(run.pendingEvent) : null);
    run.abort.abort();
    await run.pollTask?.catch(() => undefined);

    const current = await readHelperRecord(run.appRoot);
    if (current.kind === "missing") {
      if (this.lifecycle) await this.stopHelper(run);
      else await runJsonCommand(run.cliPath, ["live-inject", "--remove"], run.appRoot);
      this.active = null;
      this.publicStatus = statusOf("stopped", "Impeccable Live was already stopped; its injection was removed and journals were retained.", run);
      return this.snapshot();
    }
    if (current.kind !== "valid" || !sameHelper(current.identity, run.helper)) {
      this.publicStatus = statusOf("ownership-lost", "The helper identity changed, so the plugin refused to stop it.", run, run.pendingEvent ? eventLabel(run.pendingEvent) : null);
      throw safeError(this.publicStatus.message);
    }

    await this.stopHelper(run);
    this.active = null;
    this.publicStatus = statusOf("stopped", "Impeccable Live stopped. Upstream journals were retained.", run);
    return this.snapshot();
  }

  private async poll(run: ActiveRun): Promise<void> {
    while (this.active === run && !run.abort.signal.aborted && !run.pendingEvent) {
      let event: unknown;
      try {
        event = await runJsonCommand(run.cliPath, ["live-poll"], run.appRoot, run.abort.signal, 0);
      } catch (error) {
        if (run.abort.signal.aborted || this.active !== run) return;
        this.publicStatus = statusOf("error", `${commandErrorMessage(error, "Impeccable polling failed.")} Stop this run before starting again.`, run);
        return;
      }
      if (this.active !== run || run.abort.signal.aborted || run.generation !== this.generation) return;
      const kind = eventType(event);
      if (kind === "timeout") continue;
      if (kind === "exit") {
        const current = await readHelperRecord(run.appRoot);
        if (current.kind === "valid" && sameHelper(current.identity, run.helper)) {
          try {
            await this.stopHelper(run);
          } catch {
            this.publicStatus = statusOf("error", "The live session ended, but owned helper cleanup failed. Stop this run explicitly.", run);
            return;
          }
        } else if (current.kind === "missing") {
          try {
            if (this.lifecycle) await this.stopHelper(run);
            else await runJsonCommand(run.cliPath, ["live-inject", "--remove"], run.appRoot);
          } catch {
            this.publicStatus = statusOf("error", "The live session ended, but injection cleanup failed. Stop the run explicitly.", run);
            return;
          }
        } else {
          this.publicStatus = statusOf("ownership-lost", "The live session ended after the helper identity changed; the plugin left the replacement untouched.", run);
          return;
        }
        this.active = null;
        this.publicStatus = statusOf("stopped", "Impeccable Live session ended. Upstream journals were retained.", run);
        return;
      }
      if (!kind) {
        this.publicStatus = statusOf("error", "Impeccable returned a malformed poll event.", run);
        return;
      }

      this.publicStatus = statusOf("dispatching", "Delivering an Impeccable browser event to the bound agent…", run, eventLabel(event));
      try {
        await abortable(() => refreshBoundAgent(run.agent, run.workspaceId), run.abort.signal, 30_000, "Agent refresh was not confirmed in time.");
        if (this.active !== run || run.abort.signal.aborted) return;
        await deliverAgentEvent(run, event, false);
      } catch {
        if (this.active !== run || run.abort.signal.aborted) return;
        run.pendingEvent = event;
        this.publicStatus = statusOf("dispatch-paused", "Event delivery was not confirmed. Polling is paused and the event is retained for explicit retry.", run, eventLabel(event));
        return;
      }
      if (this.active === run && !run.abort.signal.aborted) {
        if (await this.pauseForCompletionGate(run, event)) return;
        this.publicStatus = statusOf("running", "Event delivery was accepted. This does not mean the agent completed the work.", run);
      }
    }
  }

  private requireActive(input: BindingInput): ActiveRun {
    if (!this.active) throw safeError("Impeccable Live is not running.");
    this.assertBinding(input, this.active);
    return this.active;
  }

  private async stopHelper(binding: RunBinding): Promise<void> {
    if (this.lifecycle) return this.lifecycle.stop(binding);
    await runCommand(binding.cliPath, ["live-server", "stop"], binding.appRoot);
  }

  private assertBinding(input: BindingInput, run: RunBinding): void {
    if (input.workspaceId !== run.workspaceId || input.agentId !== run.agentId) {
      throw safeError("This Impeccable Live run belongs to a different workspace or agent.");
    }
  }

  private snapshot(): LivePublicStatus {
    return { ...this.publicStatus, active: this.active !== null };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }
}

export async function resolveRunBinding(input: StartInput, paseo: PaseoApi): Promise<RunBinding> {
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const signal = input.signal ?? new AbortController().signal;
  const refreshedWorkspace = await abortable(
    () => workspace.refresh(), signal, 30_000, "The selected workspace did not refresh in time.",
  );
  if (!refreshedWorkspace || !workspace.directory) throw safeError("The selected workspace has no available directory.");
  const workspaceRoot = await realpath(workspace.directory);
  const workspaceStats = await stat(workspaceRoot);
  if (!workspaceStats.isDirectory()) throw safeError("The selected workspace directory is unavailable.");

  const agent = paseo.agents.ref(input.agentId);
  await boundedRefreshBoundAgent(agent, input.workspaceId, signal);
  const appRoot = input.exactAppRoot ? await resolveContainedDirectory(workspaceRoot, input.appPath) : await resolveAppRoot(workspaceRoot, input.appPath);
  const url = validateLocalUrl(input.url);
  const cliPath = await resolveCliPath(input.cliPath, workspaceRoot, appRoot);
  return { workspaceId: input.workspaceId, agentId: input.agentId, workspaceRoot, appRoot, url, cliPath };
}

async function resolveAppRoot(workspaceRoot: string, requestedPath: string): Promise<string> {
  const relativePath = requestedPath.trim() || ".";
  if (path.isAbsolute(relativePath)) throw safeError("App path must be relative to the selected workspace.");
  let candidate = path.resolve(workspaceRoot, relativePath);
  if (relativePath === ".") {
    const frontend = path.join(workspaceRoot, "frontend");
    if (await isFrontendDirectory(frontend)) candidate = frontend;
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw safeError("The app path does not exist.");
  }
  if (!isWithin(workspaceRoot, resolved)) throw safeError("The app path escapes the selected workspace.");
  if (!(await stat(resolved)).isDirectory()) throw safeError("The app path is not a directory.");
  return resolved;
}

async function isFrontendDirectory(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    return await Promise.any([access(path.join(directory, "package.json")), access(path.join(directory, "index.html"))]).then(() => true, () => false);
  } catch {
    return false;
  }
}

export async function resolveCliPath(override?: string, workspaceRoot?: string, appRoot?: string): Promise<string> {
  const cliPath = await resolveDependencyCli({ override, workspaceRoot, appRoot });
  if (!override?.trim() && workspaceRoot && isWithin(workspaceRoot, cliPath)) {
    throw safeError("Select the detected project-local Impeccable installation explicitly before connecting.");
  }
  return cliPath;
}

async function refreshBoundAgent(agent: PaseoAgentHandle, workspaceId: string): Promise<void> {
  const refreshed = await agent.refresh();
  if (!refreshed || agent.workspaceId !== workspaceId) {
    throw safeError("The selected agent is unavailable or belongs to another workspace.");
  }
}

function boundedRefreshBoundAgent(agent: PaseoAgentHandle, workspaceId: string, signal?: AbortSignal): Promise<void> {
  return abortable(() => refreshBoundAgent(agent, workspaceId), signal ?? new AbortController().signal, 30_000, "The selected agent did not refresh in time.");
}

async function readHelperIdentity(appRoot: string): Promise<HelperIdentity | null> {
  const record = await readHelperRecord(appRoot);
  return record.kind === "valid" ? record.identity : null;
}

export async function readHelperRecord(appRoot: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "valid"; identity: HelperIdentity }> {
  try {
    const raw = JSON.parse(await readFile(path.join(appRoot, ".impeccable/live/server.json"), "utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || !Number.isSafeInteger(raw.port) || Number(raw.port) <= 0 || typeof raw.token !== "string" || raw.token.length < 1) {
      return { kind: "invalid" };
    }
    return { kind: "valid", identity: { pid: Number(raw.pid), port: Number(raw.port), token: raw.token } };
  } catch (error) {
    const candidate = path.join(appRoot, ".impeccable/live/server.json");
    try {
      await access(candidate);
      return { kind: "invalid" };
    } catch {
      return { kind: "missing" };
    }
  }
}

async function runJsonCommand(cliPath: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
  const result = await runCommand(cliPath, args, cwd, signal, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("The Impeccable CLI returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The Impeccable CLI returned malformed JSON.");
  return parsed;
}

function runCommand(cliPath: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IMPECCABLE_LAUNCHER_PROBE: "1", COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forcedError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = timeoutMs > 0 ? setTimeout(() => terminate(new Error("The Impeccable CLI timed out.")), timeoutMs) : null;
    const onAbort = () => terminate(new Error("The Impeccable CLI operation was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_COMMAND_OUTPUT) terminate(new Error("The Impeccable CLI produced too much output."));
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(error));
    child.on("close", (code, closeSignal) => {
      if (forcedError) finish(forcedError);
      else if (code === 0) finish(null);
      else finish(new Error(`The Impeccable CLI exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}.`));
    });

    function terminate(error: Error): void {
      if (settled || forcedError) return;
      forcedError = error;
      if (child.exitCode !== null) {
        finish(error);
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
    }

    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    }
  });
}

function assertBootSucceeded(value: unknown): asserts value is Record<string, unknown> {
  const boot = value as Record<string, unknown>;
  if (boot.ok !== true) {
    const error = typeof boot.error === "string" ? boot.error.replace(/[_-]+/g, " ") : "preflight failed";
    throw safeError(`Impeccable Live could not start: ${error}. Run the Impeccable setup command in the app and try again.`);
  }
}

function assertBootIdentity(boot: Record<string, unknown>, helper: HelperIdentity): void {
  if (boot.serverPort !== helper.port || boot.serverToken !== helper.token) {
    throw safeError("Impeccable helper identity did not match the start response.");
  }
}

function buildAgentMessage(run: RunBinding, event: unknown, retrying: boolean): string {
  const retryWarning = retrying ? " This is an explicit retry: an earlier delivery may have succeeded, so check for duplicate work before acting." : "";
  return [
    "Impeccable Live browser event from the Paseo plugin.",
    `Workspace: ${run.workspaceId}`,
    `Agent: ${run.agentId}`,
    `App root: ${run.appRoot}`,
    `Preview URL: ${run.url}`,
    `Impeccable CLI: ${run.cliPath}`,
    "The plugin owns the ongoing live-poll process and helper lifecycle. Do not run a bare live-poll, start or stop live-server, or poll for the next event.",
    "Handle only the event below using the installed Impeccable skill instructions. Preserve its exact event/session/request IDs. Use the Impeccable CLI reply form required by the event, and run live-complete when its completion/carbonize instructions require it.",
    "A successful Paseo send is delivery acceptance only; it does not acknowledge or complete the Impeccable event." + retryWarning,
    "Event JSON:",
    JSON.stringify(event, null, 2),
  ].join("\n\n");
}

async function deliverAgentEvent(run: ActiveRun, event: unknown, retrying: boolean): Promise<void> {
  await abortable(() => run.agent.send(buildAgentMessage(run, event, retrying)), run.abort.signal, 30_000, "Agent delivery was not confirmed in time.");
  const completion = await abortable(() => run.agent.waitForFinish(30 * 60_000), run.abort.signal, 30 * 60_000, "Agent completion was not confirmed in time.");
  if (completion.status !== "idle") {
    throw new Error(`Agent turn did not finish (${completion.status}).`);
  }
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Agent delivery was cancelled.")));
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (settled) return;
    try {
      operation().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function eventType(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const type = (event as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : null;
}

function completionRequired(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const acknowledgement = (event as Record<string, unknown>)._completionAck;
  if (!acknowledgement || typeof acknowledgement !== "object") return false;
  const record = acknowledgement as Record<string, unknown>;
  return record.requiresComplete === true || record.ok !== true;
}

function completionStillPending(status: unknown, event: unknown): boolean {
  if (!status || typeof status !== "object") return true;
  const sessions = (status as Record<string, unknown>).activeSessions;
  if (!Array.isArray(sessions)) return true;
  const id = event && typeof event === "object" && typeof (event as Record<string, unknown>).id === "string"
    ? (event as Record<string, unknown>).id
    : null;
  if (!id) return sessions.length > 0;
  return sessions.some((session) => session && typeof session === "object" && (session as Record<string, unknown>).id === id);
}

function eventLabel(event: unknown): string {
  if (!event || typeof event !== "object") return "unknown event";
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "event";
  const idKeys = ["eventId", "requestId", "sessionId", "id"];
  const ids = idKeys.flatMap((key) => typeof record[key] === "string" ? [`${key}=${record[key]}`] : []);
  return [type, ...ids].join(" · ");
}

function sameHelper(left: HelperIdentity, right: HelperIdentity): boolean {
  return left.pid === right.pid && left.port === right.port && left.token === right.token;
}

function sameConfiguration(left: RunBinding, right: RunBinding): boolean {
  return left.workspaceId === right.workspaceId && left.agentId === right.agentId && left.appRoot === right.appRoot && left.url === right.url && left.cliPath === right.cliPath;
}

function statusOf(phase: string, message: string, binding: Partial<RunBinding> | null, pendingEvent: string | null = null): LivePublicStatus {
  return {
    active: false,
    phase,
    message,
    appRoot: binding?.appRoot ?? null,
    url: binding?.url ?? null,
    agentId: binding?.agentId ?? null,
    pendingEvent,
  };
}

function idleStatus(): LivePublicStatus {
  return statusOf("stopped", "Impeccable Live is stopped.", null);
}

function safeError(message: string): Error {
  return new Error(message);
}

function commandErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.startsWith("The Impeccable CLI") ? error.message : fallback;
}

function publicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message.length > 0 && message.length <= 500 ? message : fallback;
}
