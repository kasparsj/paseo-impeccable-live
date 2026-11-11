import type { PaseoApi } from "@getpaseo/client";
import { realpath } from "node:fs/promises";
import type { DevelopmentOverrides, SessionStatus } from "../shared/live.ts";
import { discoverDevelopment, preflightTarget, type DevelopmentTarget } from "./dev-discovery.ts";
import { DevelopmentServer, extractLocalUrls, probeLocalUrl, redactLog } from "./dev-server.ts";
import { LiveBridge, readHelperRecord, resolveRunBinding } from "./live.ts";

type Binding = { workspaceId: string; agentId: string };
type Start = Binding & DevelopmentOverrides;
const idleSession = () => ({ active: false, phase: "stopped", message: "Impeccable Live is stopped.",
  appRoot: null, url: null, agentId: null, pendingEvent: null });
const abortCheck = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Startup was canceled."); };

/** Only short state transitions run on the RPC path. Boot/readiness never block snapshots. */
export class SessionCoordinator {
  development: DevelopmentServer;
  readonly bridge: LiveBridge;
  private owner: Binding | null = null;
  private input: Start | null = null;
  private target: DevelopmentTarget | null = null;
  private attempt = 0;
  private phase = "stopped";
  private message = "Start / resume to discover and run this app.";
  private choices: SessionStatus["choices"] = [];
  private selections = new Map<string, () => Promise<void>>();
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private closing = false;
  private readonly startupMs: number | undefined;

  constructor(options: { startupMs?: number } = {}) {
    this.startupMs = options.startupMs;
    this.development = new DevelopmentServer(() => {}, options.startupMs);
    this.bridge = new LiveBridge({
      boot: async binding => {
        this.development.logs.append("system", `Starting Impeccable Live for ${binding.appRoot}…`);
        const result = await this.development.guardian.bootHelper({ command: binding.cliPath, args: ["live", "--target", binding.appRoot], cwd: binding.appRoot,
          env: { IMPECCABLE_LAUNCHER_PROBE: "1", COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
        if (this.closing || this.controller?.signal.aborted) {
          await this.development.guardian.stopHelper();
          throw new Error("Impeccable startup was canceled.");
        }
        try { return JSON.parse(result.stdout); } catch { throw new Error("The Impeccable CLI returned malformed JSON."); }
      },
      stop: async () => { await this.development.guardian.stopHelper(); },
    });
  }

  private assertOwner(binding: Binding): void {
    if (this.owner && (this.owner.workspaceId !== binding.workspaceId || this.owner.agentId !== binding.agentId)) {
      throw new Error("This integration is bound to another workspace or agent. Stop its session and development server before switching.");
    }
  }

  status(binding: Binding): SessionStatus {
    this.assertOwner(binding);
    const development = this.development.snapshot();
    const session = this.owner ? this.bridge.peek(binding) : idleSession();
    const lostServer = this.phase === "ready" && !development.verified;
    return { attempt: this.attempt, phase: lostServer ? "error" : this.phase,
      message: lostServer ? development.message : this.message, choices: [...this.choices], development, session };
  }

  logs(binding: Binding, cursor?: number) {
    this.assertOwner(binding);
    return this.development.logs.read(cursor, this.development.snapshot().ownership !== "external");
  }

  start(input: Start, paseo: PaseoApi): SessionStatus {
    if (this.closing) throw new Error("This plugin is shutting down.");
    if (this.owner && (this.owner.workspaceId !== input.workspaceId || this.owner.agentId !== input.agentId) &&
        !this.task && !this.cleanup && !this.bridge.peek(this.owner).active && this.development.snapshot().ownership !== "owned") {
      const previous = this.development;
      void previous.shutdown().catch(error => console.error("Previous development lifetime cleanup failed:", error instanceof Error ? error.message : "unknown"));
      this.development = new DevelopmentServer(() => {}, this.startupMs);
      this.bridge.clearStoppedStatus();
      this.owner = null; this.input = null; this.target = null;
    }
    this.assertOwner(input);
    if (this.cleanup) throw new Error("Cleanup is still in progress. Wait for stopped status before starting again.");
    if (this.input && configurationKey(input) !== configurationKey(this.input) &&
        (this.task || this.bridge.peek(input).active || this.development.snapshot().ownership === "owned")) {
      throw new Error("Stop the session and owned development server before changing settings.");
    }
    if (this.task) return this.status(input);
    const previous = this.input;
    this.owner = { workspaceId: input.workspaceId, agentId: input.agentId };
    this.input = { ...input, selectionId: input.selectionId || (previous && configurationKey(previous) === configurationKey(input) ? previous.selectionId : undefined) };
    this.controller?.abort();
    this.controller = new AbortController();
    this.attempt++;
    this.phase = "discovering"; this.message = "Discovering the application and development command…";
    if (this.development.snapshot().ownership === "none") this.development.mark("discovering", this.message);
    this.choices = []; this.selections.clear();
    this.background(() => this.run(this.input!, paseo, this.controller!.signal), this.controller.signal);
    return this.status(input);
  }

  select(input: Binding & { attempt: number; selectionId: string }): SessionStatus {
    this.assertOwner(input);
    if (input.attempt !== this.attempt || this.phase !== "selection-required") throw new Error("This selection is stale. Use Start / resume to discover current choices.");
    const action = this.selections.get(input.selectionId);
    if (!action || !this.controller) throw new Error("Choose one of the current development options.");
    this.phase = "starting"; this.message = "Continuing with the selected development option…";
    this.choices = []; this.selections.clear();
    this.background(action, this.controller.signal);
    return this.status(input);
  }

  private background(operation: () => Promise<void>, signal: AbortSignal): void {
    const attempt = this.attempt;
    const task = Promise.resolve().then(operation).catch(error => {
      if (attempt !== this.attempt || signal.aborted || this.closing) return;
      this.phase = "error";
      this.message = redactLog(error instanceof Error ? error.message : "Startup failed.").slice(0, 1000);
      this.development.logs.append("system", this.message);
      if (!this.development.snapshot().verified) this.development.fail(error);
    }).finally(() => { if (this.task === task) this.task = null; });
    this.task = task;
  }

  private async run(input: Start, paseo: PaseoApi, signal: AbortSignal): Promise<void> {
    const workspace = paseo.workspaces.ref(input.workspaceId);
    const refreshed = await bounded(() => workspace.refresh(), signal);
    abortCheck(signal);
    if (!refreshed || !workspace.directory) throw new Error("The selected workspace has no available directory.");
    const root = await realpath(workspace.directory);
    const agent = paseo.agents.ref(input.agentId);
    const available = await bounded(() => agent.refresh(), signal);
    abortCheck(signal);
    if (!available || agent.workspaceId !== input.workspaceId) throw new Error("The selected agent is unavailable or belongs to another workspace.");
    const discovery = await discoverDevelopment(root, input, signal);
    abortCheck(signal);
    if (discovery.kind === "unsupported") throw new Error(discovery.message);
    if (discovery.kind === "selection-required") {
      this.offer(discovery.message, discovery.choices.map(choice => ({ ...choice, persistSelection: true, action: async () => {
        const next = { ...input, selectionId: choice.id }; this.input = next;
        await this.run(next, paseo, signal);
      } })));
      return;
    }
    const target = discovery.target;
    if (this.target && this.target.id !== target.id && this.development.snapshot().ownership === "owned") {
      throw new Error("The selected application's command changed. Stop its development server before starting different settings.");
    }
    this.target = target;
    const previewPath = target.previewPath ?? target.appPath;
    const previewRoot = target.previewRoot ?? target.appRoot;
    const binding = await resolveRunBinding({ ...input, appPath: previewPath, url: input.url?.trim() || "http://127.0.0.1/",
      exactAppRoot: true, signal }, paseo);
    abortCheck(signal);
    if (!this.bridge.peek(input).active && (await readHelperRecord(previewRoot)).kind !== "missing") {
      throw new Error("An Impeccable helper already exists for this app. Stop it through its owning session before starting this integration.");
    }
    const finish = async (url: string) => {
      abortCheck(signal);
      this.phase = "starting-impeccable"; this.message = `Development server verified. Starting Impeccable Live in ${previewPath}…`;
      if (this.bridge.peek(input).active) this.bridge.updatePreviewUrl(input, url);
      else await this.bridge.start({ ...input, appPath: previewPath, url, cliPath: binding.cliPath, exactAppRoot: true, signal }, paseo);
      abortCheck(signal);
      this.phase = "ready"; this.message = "Development server and Impeccable Live are ready.";
    };
    const launch = async () => {
      abortCheck(signal);
      if (!this.development.snapshot().verified) await preflightTarget(target, root);
      abortCheck(signal);
      this.phase = "starting-server"; this.message = "Starting the development server…";
      const result = await this.development.startOwned(target, input.url?.trim() || undefined, signal);
      abortCheck(signal);
      if (result.kind === "selection-required") {
        this.offer("Choose which local page to preview.", result.urls.map((url, index) => ({ id: `owned-${index}`, label: url,
          detail: "A verified page served by this launch.", action: async () => {
            const verified = await this.development.startOwned(target, url, signal);
            if (verified.kind !== "ready") throw new Error("The selected preview could not be verified.");
            await finish(verified.url);
          } })));
      } else await finish(result.url);
    };
    const state = this.development.snapshot();
    if (state.ownership === "owned") { await launch(); return; }
    const candidates = new Map<string, boolean>();
    if (input.url?.trim()) candidates.set(input.url.trim(), true);
    else {
      if (state.ownership === "external" && state.url && this.development.matchesTarget(target)) candidates.set(state.url, true);
      for (const url of target.expectedUrls) candidates.set(url, candidates.get(url) ?? false);
      // Existing terminals provide association evidence only; they never become owned.
      try {
        const terminals = await bounded(() => paseo.workspaces.ref(input.workspaceId).terminals.list(), signal);
        for (const terminal of terminals.entries.slice(0, 40)) {
          if (await realpath(terminal.cwd).catch(() => "") !== target.appRoot) continue;
          const captured = await bounded(() => paseo.terminals.ref(terminal.id).capture({ stripAnsi: true }), signal);
          for (const url of extractLocalUrls(captured.lines.slice(-100).join("\n"))) candidates.set(url, true);
          if (candidates.size >= 16) break;
        }
      } catch (error) { abortCheck(signal); /* Terminal access is optional; command output remains the primary path. */ }
    }
    const responders: Array<{ url: string; associated: boolean }> = [];
    await Promise.all([...candidates].slice(0, 16).map(async ([url, associated]) => {
      try {
        const verified = await probeLocalUrl(url, signal);
        if (!responders.some(item => item.url === verified)) responders.push({ url: verified, associated });
      } catch { abortCheck(signal); }
    }));
    abortCheck(signal);
    if (responders.length === 1 && responders[0].associated) {
      this.development.useExternal(target, responders[0].url);
      await finish(responders[0].url); return;
    }
    if (responders.length) {
      this.offer("A local server is already responding. Choose the app to reuse, or start this command separately.", [
        ...responders.map((item, index) => ({ id: `reuse-${index}`, label: `Reuse ${item.url}`,
          detail: "Started outside this plugin; it will remain running when this plugin stops.",
          action: async () => {
            const verified = await probeLocalUrl(item.url, signal);
            this.development.useExternal(target, verified); await finish(verified);
          } })),
        { id: "launch", label: "Start a separate development server", detail: target.displayCommand, action: launch },
      ]);
      return;
    }
    await launch();
  }

  private offer(message: string, options: Array<SessionStatus["choices"][number] & { action: () => Promise<void> }>): void {
    this.phase = "selection-required"; this.message = message;
    this.choices = options.map(({ action, ...choice }) => choice);
    this.selections = new Map(options.map(option => [option.id, option.action]));
    this.development.mark("selection-required", message);
  }

  stopSession(input: Binding): SessionStatus { return this.stop(input, false); }
  stopDevelopment(input: Binding): SessionStatus { return this.stop(input, true); }

  private stop(input: Binding, development: boolean): SessionStatus {
    this.assertOwner(input);
    if (!this.owner) return this.status(input);
    if (development && this.development.snapshot().ownership === "external") throw new Error("This development server was started outside the plugin and cannot be stopped here.");
    if (this.cleanup) return this.status(input);
    this.controller?.abort(); this.choices = []; this.selections.clear();
    this.phase = "stopping"; this.message = development ? "Stopping the session and owned development server…" : "Stopping Impeccable Live; keeping the development server…";
    const task = this.task;
    const cleanup = (async () => {
      await task;
      if (this.closing) return;
      if (this.bridge.peek(input).active) await this.bridge.stop(input);
      else if (this.target) await this.development.guardian.stopHelper();
      if (development) await this.development.stop();
      else if (!this.development.snapshot().verified) this.development.mark("error", "Startup was canceled. Stop the development server or use Start / resume to verify it again.");
      this.phase = "stopped"; this.message = development ? "Session and owned development server stopped." : "Impeccable Live stopped. The development server remains available.";
      if (development || this.development.snapshot().ownership !== "owned") {
        // Keep diagnostics visible to this panel until another binding starts.
        this.target = null;
      }
    })().catch(error => {
      this.phase = "error"; this.message = redactLog(error instanceof Error ? error.message : "Cleanup failed.");
      this.development.logs.append("system", this.message);
    }).finally(() => { if (this.cleanup === cleanup) this.cleanup = null; });
    this.cleanup = cleanup;
    return this.status(input);
  }

  async retry(input: Binding): Promise<SessionStatus> {
    this.assertOwner(input);
    await this.bridge.retry(input);
    return this.status(input);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.controller?.abort(); this.selections.clear(); this.choices = [];
    // Dispatch guardian cleanup immediately; never wait behind the SDK or long boot.
    const bridge = this.bridge.quiesce();
    const processes = this.development.shutdown();
    const results = await Promise.allSettled([bridge, processes]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

function configurationKey(input: DevelopmentOverrides): string {
  return JSON.stringify([input.appPath?.trim() || "", input.command?.trim() || "", input.args ?? [], input.url?.trim() || "", input.cliPath?.trim() || ""]);
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  abortCheck(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => finish(new Error("Startup was canceled."));
    const timer = setTimeout(() => finish(new Error("The workspace or agent did not respond in time.")), 10_000);
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation().then(value => finish(null, value), error => finish(error));
  });
}
