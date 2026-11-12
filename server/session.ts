import type { PaseoApi } from "@getpaseo/client";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { DependencyReadiness, DevelopmentOverrides, QuickUpdatePlan, SessionStatus } from "../shared/live.ts";
import { discoverDevelopment, preflightTarget, type DevelopmentTarget } from "./dev-discovery.ts";
import { DevelopmentServer, extractLocalUrls, probeLocalUrl, redactLog } from "./dev-server.ts";
import { LiveBridge, readHelperRecord, resolveRunBinding } from "./live.ts";

import { inspectDependency } from "./dependency.ts";
import { QuickUpdater } from "./quick-update.ts";
import { UpdateChecker } from "./update.ts";

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
  private workspaceRoot: string | null = null;
  private attempt = 0;
  private phase = "stopped";
  private message = "Connect and open preview to run this app.";
  private helperReadinessError: string | null = null;
  private dependencyReadiness: DependencyReadiness | null = null;
  private readonly updates: Pick<UpdateChecker, "check">;
  private readonly quickUpdater: Pick<QuickUpdater, "prepare" | "execute" | "shutdown">;
  private updateTask: Promise<unknown> | null = null;
  private activeUpdatePlanId: string | null = null;
  private updateOperation: SessionStatus["updateOperation"] = { phase: "idle", message: "No update is running." };
  private choices: SessionStatus["choices"] = [];
  private selections = new Map<string, () => Promise<void>>();
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private closing = false;
  private readonly startupMs: number | undefined;

  constructor(options: { startupMs?: number; updates?: Pick<UpdateChecker, "check">; quickUpdater?: Pick<QuickUpdater, "prepare" | "execute" | "shutdown"> } = {}) {
    this.updates = options.updates ?? new UpdateChecker();
    this.quickUpdater = options.quickUpdater ?? new QuickUpdater();
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
      message: lostServer ? development.message : this.message, helperReadinessError: this.helperReadinessError, dependencyReadiness: this.dependencyReadiness,
      choices: [...this.choices], development, session, updateOperation: this.updateOperation };
  }

  logs(binding: Binding, cursor?: number) {
    this.assertOwner(binding);
    return this.development.logs.read(cursor, this.development.snapshot().ownership !== "external");
  }

  async checkUpdates(input: Binding & { force?: boolean; attempt: number; cliPath: string | null; appRoot: string }) {
    this.assertOwner(input);
    const readiness = this.dependencyReadiness;
    if (!readiness || this.closing || input.attempt !== this.attempt ||
        input.cliPath !== readiness.cliPath || input.appRoot !== readiness.appRoot) {
      return { status: "unknown" as const, installedVersion: null, latestVersion: null };
    }
    return this.updates.check({ cliPath: readiness.cliPath, appRoot: readiness.appRoot, force: input.force });
  }

  async prepareQuickUpdate(input: Binding & { attempt: number; cliPath: string; selectedCliPath: string; appRoot: string; targetSkillVersion: string }, paseo: PaseoApi) {
    this.assertCurrentUpdateBinding(input);
    this.assertUpdateIdle();
    await this.assertAgentIdle(input, paseo);
    this.assertCurrentUpdateBinding(input);
    this.assertUpdateIdle();
    const update = await this.updates.check({ cliPath: input.cliPath, appRoot: input.appRoot, force: true });
    this.assertCurrentUpdateBinding(input);
    this.assertUpdateIdle();
    if (update.status !== "available" || update.latestVersion !== input.targetSkillVersion) {
      throw new Error("Update availability changed. Check for updates again before preparing an update.");
    }
    return this.quickUpdater.prepare({
      selectedCliPath: input.selectedCliPath, resolvedCliPath: input.cliPath, appRoot: input.appRoot,
      targetSkillVersion: input.targetSkillVersion,
    });
  }

  async applyQuickUpdate(input: Binding & { attempt: number; cliPath: string; selectedCliPath: string; appRoot: string;
    planId: string; scope: QuickUpdatePlan["scope"]; targetSkillVersion: string; updaterVersion: string }, paseo: PaseoApi) {
    this.assertCurrentUpdateBinding(input);
    if (this.updateTask) {
      if (this.activeUpdatePlanId === input.planId) return this.updateTask as ReturnType<QuickUpdater["execute"]>;
      throw new Error("Another Impeccable update is already being prepared or run. Wait for it to finish.");
    }
    this.assertUpdateIdle();
    this.updateOperation = { phase: "running", message: `Updating ${input.scope} Impeccable installations…` };
    this.activeUpdatePlanId = input.planId;
    const operation = (async () => {
      await this.assertAgentIdle(input, paseo);
      this.assertCurrentUpdateBinding(input);
      this.assertUpdateLifecycleIdle();
      return this.quickUpdater.execute({
        planId: input.planId, selectedCliPath: input.selectedCliPath, resolvedCliPath: input.cliPath, appRoot: input.appRoot,
        scope: input.scope, targetSkillVersion: input.targetSkillVersion, updaterVersion: input.updaterVersion,
        verifyTarget: async () => {
          this.assertCurrentUpdateBinding(input);
          this.assertUpdateLifecycleIdle();
          await this.assertAgentIdle(input, paseo);
          this.assertCurrentUpdateBinding(input);
          this.assertUpdateLifecycleIdle();
          const current = await this.updates.check({ cliPath: input.cliPath, appRoot: input.appRoot, force: true });
          this.assertCurrentUpdateBinding(input);
          this.assertUpdateLifecycleIdle();
          if (current.status !== "available" || current.latestVersion !== input.targetSkillVersion) {
            throw new Error("The available skill version changed before mutation. Refresh update details and prepare a new update plan.");
          }
        },
      });
    })().then(async result => {
      const refreshedReadiness = await inspectHelperReadiness(input.appRoot, this.workspaceRoot ?? input.appRoot,
        input.selectedCliPath, new AbortController().signal, false);
      const readinessBlocked = refreshedReadiness.checks.find(check =>
        (check.id === "engine" || check.id === "compatibility") && check.status === "blocked");
      if (refreshedReadiness.cliPath !== input.cliPath || refreshedReadiness.selectedCliPath !== input.selectedCliPath ||
          refreshedReadiness.engineVersion !== result.engineVersion || readinessBlocked) {
        throw new Error(`The updater finished, but refreshed launcher and engine readiness did not match the verified result. ${readinessBlocked?.message ?? ""}`.trim());
      }
      this.dependencyReadiness = refreshedReadiness;
      const refreshed = await this.updates.check({ cliPath: input.cliPath, appRoot: input.appRoot, force: true });
      if (refreshed.installedVersion !== result.installedVersion || refreshed.status !== "current") {
        throw new Error("The selected installation updated, but refreshed update detection did not confirm it as current.");
      }
      this.updateOperation = { phase: "succeeded", message: `Impeccable ${result.installedVersion} and engine ${result.engineVersion} verified.`,
        output: result.output, instruction: result.instruction };
      return result;
    }).catch(error => {
      const message = redactLog(error instanceof Error ? error.message : "The update failed.").slice(0, 2_000);
      this.updateOperation = { phase: "failed", message };
      throw new Error(message);
    }).finally(() => {
      if (this.updateTask === operation) { this.updateTask = null; this.activeUpdatePlanId = null; }
    });
    this.updateTask = operation;
    return operation;
  }

  private assertCurrentUpdateBinding(input: Binding & { attempt: number; cliPath: string; selectedCliPath: string; appRoot: string }): void {
    this.assertOwner(input);
    const readiness = this.dependencyReadiness;
    if (!readiness || input.attempt !== this.attempt || input.cliPath !== readiness.cliPath ||
        input.selectedCliPath !== readiness.selectedCliPath || input.appRoot !== readiness.appRoot) {
      throw new Error("This update request is stale. Refresh update details before trying again.");
    }
  }

  private assertUpdateIdle(): void {
    this.assertUpdateLifecycleIdle();
    if (this.updateTask) throw new Error("Another Impeccable update is already running.");
  }

  private assertUpdateLifecycleIdle(): void {
    const session = this.owner ? this.bridge.peek(this.owner) : null;
    if (this.closing || this.task || this.cleanup || session?.active || session?.pendingEvent) {
      throw new Error("Stop Impeccable Live and wait for startup, cleanup, and event work to finish before updating.");
    }
  }

  private async assertAgentIdle(binding: Binding, paseo: PaseoApi): Promise<void> {
    const agent = paseo.agents.ref(binding.agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshed = await Promise.race([
      agent.refresh(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The attached agent did not respond in time.")), 10_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!refreshed || agent.workspaceId !== binding.workspaceId || agent.status !== "idle" || agent.activeTurn || (agent.pendingPermissions?.length ?? 0) > 0) {
      throw new Error("The attached agent is busy or its state is unknown. Wait for it to become idle before updating.");
    }
  }

  start(input: Start, paseo: PaseoApi): SessionStatus {
    if (this.closing) throw new Error("This plugin is shutting down.");
    if (this.updateTask) throw new Error("Wait for the Impeccable update to finish before connecting or changing settings.");
    if (this.owner && (this.owner.workspaceId !== input.workspaceId || this.owner.agentId !== input.agentId) &&
        !this.task && !this.cleanup && !this.bridge.peek(this.owner).active && this.development.snapshot().ownership !== "owned") {
      const previous = this.development;
      void previous.shutdown().catch(error => console.error("Previous development lifetime cleanup failed:", error instanceof Error ? error.message : "unknown"));
      this.development = new DevelopmentServer(() => {}, this.startupMs);
      this.bridge.clearStoppedStatus();
      this.owner = null; this.input = null; this.target = null; this.workspaceRoot = null;
    }
    this.assertOwner(input);
    if (this.cleanup) throw new Error("Cleanup is still in progress. Wait for stopped status before connecting again.");
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
    this.updateOperation = { phase: "idle", message: "No update is running." };
    this.helperReadinessError = null;
    this.dependencyReadiness = null;
    this.development.logs.beginAttempt(this.attempt);
    this.phase = "discovering"; this.message = "Discovering the application and development command…";
    if (this.development.snapshot().ownership === "none") this.development.mark("discovering", this.message);
    this.choices = []; this.selections.clear();
    this.background(() => this.run(this.input!, paseo, this.controller!.signal, false), this.controller.signal);
    return this.status(input);
  }

  inspect(input: Start, paseo: PaseoApi): SessionStatus {
    if (this.closing) throw new Error("This plugin is shutting down.");
    if (this.updateTask) throw new Error("Wait for the Impeccable update to finish before connecting or changing settings.");
    if (this.owner && (this.owner.workspaceId !== input.workspaceId || this.owner.agentId !== input.agentId) &&
        !this.task && !this.cleanup && !this.bridge.peek(this.owner).active && this.development.snapshot().ownership !== "owned") {
      const previous = this.development;
      void previous.shutdown().catch(error => console.error("Previous development lifetime cleanup failed:", error instanceof Error ? error.message : "unknown"));
      this.development = new DevelopmentServer(() => {}, this.startupMs);
      this.bridge.clearStoppedStatus();
      this.owner = null; this.input = null; this.target = null; this.workspaceRoot = null;
    }
    if (this.owner && (this.bridge.peek(this.owner).active || this.development.snapshot().ownership === "owned")) {
      this.assertOwner(input);
      return this.status(input);
    }
    if (this.task || this.cleanup) return this.status(input);
    this.assertOwner(input);
    this.owner = { workspaceId: input.workspaceId, agentId: input.agentId };
    this.input = { ...input };
    this.controller?.abort();
    this.controller = new AbortController();
    this.attempt++;
    this.updateOperation = { phase: "idle", message: "No update is running." };
    this.helperReadinessError = null;
    this.dependencyReadiness = null;
    this.development.logs.beginAttempt(this.attempt);
    this.phase = "discovering";
    this.message = "Checking the application, preview, and local development servers…";
    this.development.mark("discovering", this.message);
    this.choices = []; this.selections.clear();
    this.background(() => this.run(this.input!, paseo, this.controller!.signal, true), this.controller.signal);
    return this.status(input);
  }

  select(input: Binding & { attempt: number; selectionId: string }): SessionStatus {
    this.assertOwner(input);
    if (this.updateTask) throw new Error("Wait for the Impeccable update to finish before connecting.");
    if (input.attempt !== this.attempt || (this.phase !== "selection-required" && this.phase !== "idle")) throw new Error("This selection is stale. Run discovery again for current choices.");
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

  private async run(input: Start, paseo: PaseoApi, signal: AbortSignal, readOnly: boolean): Promise<void> {
    const workspace = paseo.workspaces.ref(input.workspaceId);
    const refreshed = await bounded(() => workspace.refresh(), signal);
    abortCheck(signal);
    if (!refreshed || !workspace.directory) throw new Error("The selected workspace has no available directory.");
    const root = await realpath(workspace.directory);
    this.workspaceRoot = root;
    const agent = paseo.agents.ref(input.agentId);
    const available = await bounded(() => agent.refresh(), signal);
    abortCheck(signal);
    if (!available || agent.workspaceId !== input.workspaceId) throw new Error("The selected agent is unavailable or belongs to another workspace.");
    const discovery = await discoverDevelopment(root, input, signal);
    abortCheck(signal);
    if (discovery.kind === "unsupported") throw new Error(discovery.message);
    if (discovery.kind === "selection-required") {
      this.offer(discovery.message, discovery.choices.map(choice => ({ ...choice, kind: "target" as const, persistSelection: true, action: async () => {
        const next = { ...input, selectionId: choice.id }; this.input = next;
        await this.run(next, paseo, signal, false);
      } })));
      return;
    }
    const target = discovery.target;
    if (this.target && this.target.id !== target.id && this.development.snapshot().ownership === "owned") {
      throw new Error("The selected application's command changed. Stop its development server before starting different settings.");
    }
    this.target = target;
    const previousDevelopment = this.development.snapshot();
    const associatedExternalUrl = previousDevelopment.ownership === "external" && previousDevelopment.url && this.development.matchesTarget(target)
      ? previousDevelopment.url : null;
    if (previousDevelopment.ownership === "external" && (readOnly || !associatedExternalUrl)) this.development.releaseExternal();
    this.development.describe(target, input.url?.trim() || null);
    const previewPath = target.previewPath ?? target.appPath;
    const previewRoot = target.previewRoot ?? target.appRoot;
    let binding: Awaited<ReturnType<typeof resolveRunBinding>> | null = null;
    const checkReadiness = async () => {
      this.dependencyReadiness = await inspectHelperReadiness(previewRoot, root, input.cliPath, signal, this.bridge.peek(input).active);
      abortCheck(signal);
      this.helperReadinessError = this.dependencyReadiness.checks
        .filter(check => check.status === "blocked").map(check => check.message).join(" ") || null;
    };
    const requireHelperReady = async () => {
      await checkReadiness();
      if (this.helperReadinessError) throw new Error(this.helperReadinessError);
      binding = await resolveRunBinding({ ...input, appPath: previewPath, url: input.url?.trim() || "http://127.0.0.1/",
        cliPath: this.dependencyReadiness!.cliPath!, exactAppRoot: true, signal }, paseo);
    };
    // Inspect the engine before any app process starts; ordinary checks never bootstrap it.
    if (readOnly) await checkReadiness();
    else await requireHelperReady();
    const finish = async (url: string) => {
      abortCheck(signal);
      if (!binding) await requireHelperReady();
      const readyBinding = binding;
      if (!readyBinding) throw new Error("Impeccable helper readiness could not be verified.");
      this.phase = "starting-impeccable"; this.message = `Development server verified. Starting Impeccable Live in ${previewPath}…`;
      if (this.bridge.peek(input).active) this.bridge.updatePreviewUrl(input, url);
      else await this.bridge.start({ ...input, appPath: previewPath, url, cliPath: readyBinding.cliPath, exactAppRoot: true, signal }, paseo);
      abortCheck(signal);
      this.phase = "ready"; this.message = "Development server and Impeccable Live are ready.";
    };
    const launch = async (excludeRespondingOverride = false) => {
      abortCheck(signal);
      if (readOnly || this.helperReadinessError) await requireHelperReady();
      const refreshed = await discoverDevelopment(root, input, signal);
      if (refreshed.kind !== "resolved" || refreshed.target.id !== target.id) {
        const detail = refreshed.kind === "unsupported" ? ` ${refreshed.message}` : "";
        throw new Error(`The selected development command changed after discovery. Refresh checks and choose again.${detail}`);
      }
      if (!this.development.snapshot().verified) await preflightTarget(refreshed.target, root);
      abortCheck(signal);
      this.phase = "starting-server"; this.message = "Starting the development server…";
      const result = await this.development.startOwned(refreshed.target,
        excludeRespondingOverride ? undefined : input.url?.trim() || undefined, signal);
      abortCheck(signal);
      if (result.kind === "selection-required") {
        this.offer("Choose which local page to preview.", result.urls.map((url, index) => ({ id: `owned-${index}`, label: url, kind: "preview" as const,
          detail: "A verified page served by this launch.", action: async () => {
            const verified = await this.development.startOwned(refreshed.target, url, signal, false);
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
      if (associatedExternalUrl) candidates.set(associatedExternalUrl, true);
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
        const existing = responders.find(item => sameLocalEndpoint(item.url, verified));
        if (existing) {
          existing.associated ||= associated;
          if (associated) existing.url = verified;
        } else responders.push({ url: verified, associated });
      } catch { abortCheck(signal); }
    }));
    abortCheck(signal);
    if (!readOnly && responders.length === 1 && responders[0].associated) {
      this.development.useExternal(target, responders[0].url);
      await finish(responders[0].url); return;
    }
    if (responders.length) {
      if (readOnly && state.ownership === "external") this.development.releaseExternal();
      this.offer(responders.some(item => item.associated)
        ? "A matching local server is ready to connect."
        : "Local servers are responding, but none is associated with this app. Choose a server or start another one.", [
        ...responders.map((item, index) => ({ id: `reuse-${index}`, label: `Reuse ${item.url}`,
          kind: "reuse" as const,
          associated: item.associated, recommended: item.associated,
          detail: "Started outside this plugin; it will remain running when this plugin stops.",
          action: async () => {
            await requireHelperReady();
            const verified = await probeLocalUrl(item.url, signal);
            this.development.useExternal(target, verified); await finish(verified);
          } })),
        { id: "launch", label: "Start another development server", kind: "launch" as const,
          associated: false, recommended: false, detail: target.displayCommand, action: () => launch(true) },
      ], readOnly);
      return;
    }
    if (readOnly) {
      this.offer("The app is ready to start.", [{ id: "launch", label: "Connect and open preview", kind: "launch",
        detail: `Start ${target.displayCommand}, then connect Impeccable Live.`, action: launch }], true);
      return;
    }
    await launch();
  }

  private offer(message: string, options: Array<SessionStatus["choices"][number] & { action: () => Promise<void> }>, idleWhenSingle = false): void {
    this.phase = idleWhenSingle && options.length === 1 ? "idle" : "selection-required"; this.message = message;
    this.choices = options.map(({ action, ...choice }) => choice);
    this.selections = new Map(options.map(option => [option.id, option.action]));
    this.development.mark(this.phase === "idle" ? "stopped" : "selection-required", message);
  }

  stopSession(input: Binding): SessionStatus { return this.stop(input, false); }
  stopDevelopment(input: Binding): SessionStatus { return this.stop(input, true); }

  private stop(input: Binding, development: boolean): SessionStatus {
    this.assertOwner(input);
    if (this.updateTask) throw new Error("Wait for the Impeccable update to finish before stopping or reconfiguring the session.");
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
      else if (!this.development.snapshot().verified) this.development.mark("error", "Startup was canceled. Stop the development server or use Connect again to verify it.");
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
    if (this.updateTask) throw new Error("Wait for the Impeccable update to finish before retrying event delivery.");
    await this.bridge.retry(input);
    return this.status(input);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.controller?.abort(); this.selections.clear(); this.choices = [];
    // Dispatch guardian cleanup immediately; never wait behind the SDK or long boot.
    const bridge = this.bridge.quiesce();
    const processes = this.development.shutdown();
    const updater = this.quickUpdater.shutdown();
    const update = this.updateTask ?? Promise.resolve();
    const results = await Promise.allSettled([bridge, processes, updater, update]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

async function impeccableReadinessError(previewRoot: string, workspaceRoot: string): Promise<string | null> {
  const required = ["PRODUCT.md", "DESIGN.md", path.join(".impeccable", "live", "config.json")];
  const missing: string[] = [];
  for (const relative of required) {
    let cursor = previewRoot;
    let found = false;
    while (true) {
      try {
        const resolved = await realpath(path.join(cursor, relative));
        const relation = path.relative(workspaceRoot, resolved);
        if (relation.startsWith(".." + path.sep) || path.isAbsolute(relation) || !(await lstat(resolved)).isFile()) throw new Error("not a workspace file");
        const contents = await readFile(resolved, "utf8");
        if (!contents.trim()) throw new Error("empty file");
        if (relative.endsWith("config.json")) {
          const config: unknown = JSON.parse(contents);
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config object");
        }
        found = true;
        break;
      } catch { /* Try the next app ancestor. */ }
      if (cursor === workspaceRoot) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !isWithinRoot(workspaceRoot, parent)) break;
      cursor = parent;
    }
    if (!found) missing.push(relative);
  }
  if (missing.length > 0) {
    return `Impeccable setup is incomplete for the preview app. Add valid ${missing.join(", ")} before connecting.`;
  }
  return null;
}

async function inspectHelperReadiness(previewRoot: string, workspaceRoot: string, cliPath: string | undefined,
  signal: AbortSignal, active: boolean): Promise<DependencyReadiness> {
  const dependency = await inspectDependency({ workspaceRoot, appRoot: previewRoot, override: cliPath, signal });
  const checks: DependencyReadiness["checks"] = [...dependency.checks];
  const records = await impeccableReadinessError(previewRoot, workspaceRoot);
  checks.push({ id: "project", status: records ? "blocked" : "ready",
    message: records ?? "Project context and Live configuration found. Impeccable validates Live configuration when connecting." });
  if (!active && (await readHelperRecord(previewRoot)).kind !== "missing") {
    checks.push({ id: "helper", status: "blocked", message: "An Impeccable helper already exists for this app. Stop it through its owning session before connecting." });
  }
  return { ...dependency, appRoot: previewRoot, checks };
}

function sameLocalEndpoint(left: string, right: string): boolean { return left === right; }

function isWithinRoot(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === "" || (!relation.startsWith(".." + path.sep) && !path.isAbsolute(relation));
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
