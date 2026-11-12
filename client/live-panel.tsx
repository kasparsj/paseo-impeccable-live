import { useRpc, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  applyQuickUpdateRpc, checkUpdatesRpc, inspectRpc, devLogsRpc, prepareQuickUpdateRpc, retryRpc, selectRpc, startRpc, statusRpc, stopDevServerRpc, stopRpc,
} from "../shared/live";
import {
  cleanQuickUpdateError, configAfterChoice, dependencyRecovery, defaultPanelConfig, needsPanelConfigMigration, panelConfigSchema, parseArgumentList,
  panelView, validatePanelFields, previewAttemptToOpen, startOverrides, type PanelConfig,
} from "./live-state";

type LogLine = { sequence: number; attempt: number; source: "stdout" | "stderr" | "system"; text: string; time: string };

export function LivePanel({ theme, layout, workspaceId, params, tab, navigation }: PluginAgentPanelProps) {
  const [savedConfig, saveConfig] = useTabState(tab, panelConfigSchema, defaultPanelConfig);
  const [config, setConfig] = useState<PanelConfig>(savedConfig);
  const [argsText, setArgsText] = useState(() => JSON.stringify(savedConfig.args));
  const [argsError, setArgsError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [fields, setFields] = useState<ReturnType<typeof validatePanelFields>>({});
  const [edited, setEdited] = useState(false);
  const [inspecting, setInspecting] = useState(true);
  const argsInput = useRef<import("react-native").TextInput>(null);
  const focusArgsError = useRef(false);
  const fieldInputs = useRef<Record<string, import("react-native").TextInput | null>>({});
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryText, setRecoveryText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const logCursor = useRef(0);
  const logAttempt = useRef<number | null>(null);
  const initiatedAttempt = useRef<number | null>(null);
  const openedAttempt = useRef<number | null>(null);

  const inspect = useRpc(inspectRpc);
  const start = useRpc(startRpc);
  const status = useRpc(statusRpc);
  const stop = useRpc(stopRpc);
  const retry = useRpc(retryRpc);
  const select = useRpc(selectRpc);
  const stopDevelopment = useRpc(stopDevServerRpc);
  const developmentLogs = useRpc(devLogsRpc);
  const checkUpdates = useRpc(checkUpdatesRpc);
  const prepareQuickUpdate = useRpc(prepareQuickUpdateRpc);
  const applyQuickUpdate = useRpc(applyQuickUpdateRpc);
  const queryClient = useQueryClient();
  const ids = { workspaceId, agentId: params.agentId };

  const state = useQuery({
    queryKey: ["impeccable-live", workspaceId, params.agentId],
    queryFn: () => status(ids),
    refetchInterval: 1000,
  });
  const updateKey = ["impeccable-live-updates", workspaceId, params.agentId,
    state.data?.dependencyReadiness?.cliPath, state.data?.dependencyReadiness?.appRoot, state.data?.attempt];
  const updateInput = { ...ids, attempt: state.data?.attempt ?? -1,
    cliPath: state.data?.dependencyReadiness?.cliPath ?? null,
    appRoot: state.data?.dependencyReadiness?.appRoot ?? "" };
  const updates = useQuery({
    queryKey: updateKey,
    queryFn: () => checkUpdates(updateInput),
    enabled: !edited && !!state.data?.dependencyReadiness?.cliPath,
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  const refreshUpdates = useMutation({
    mutationFn: ({ input }: { input: typeof updateInput; queryKey: typeof updateKey }) => checkUpdates({ ...input, force: true }),
    onSuccess: (result, { queryKey }) => queryClient.setQueryData(queryKey, result),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["impeccable-live-update-plan", workspaceId, params.agentId] }); },
  });
  const updatePlanKey = ["impeccable-live-update-plan", workspaceId, params.agentId, state.data?.attempt,
    state.data?.dependencyReadiness?.cliPath, state.data?.dependencyReadiness?.selectedCliPath,
    state.data?.dependencyReadiness?.appRoot, updates.data?.latestVersion];
  const updatePlan = useQuery({
    queryKey: updatePlanKey,
    queryFn: () => prepareQuickUpdate({
      ...ids, attempt: state.data!.attempt, cliPath: state.data!.dependencyReadiness!.cliPath!,
      selectedCliPath: state.data!.dependencyReadiness!.selectedCliPath!, appRoot: state.data!.dependencyReadiness!.appRoot,
      targetSkillVersion: updates.data!.latestVersion!,
    }),
    enabled: !edited && updates.data?.status === "available" && !!state.data?.dependencyReadiness?.cliPath &&
      !!state.data?.dependencyReadiness?.selectedCliPath,
    retry: false,
  });
  const runQuickUpdate = useMutation({
    mutationFn: async (plan: Extract<NonNullable<typeof updatePlan.data>, { status: "eligible" }>) => applyQuickUpdate({
      ...ids, attempt: state.data!.attempt, cliPath: state.data!.dependencyReadiness!.cliPath!,
      selectedCliPath: state.data!.dependencyReadiness!.selectedCliPath!, appRoot: state.data!.dependencyReadiness!.appRoot,
      planId: plan.planId, scope: plan.scope, targetSkillVersion: plan.targetSkillVersion, updaterVersion: plan.updaterVersion,
    }),
    onSettled: async () => {
      await state.refetch();
      await queryClient.invalidateQueries({ queryKey: ["impeccable-live-updates", workspaceId, params.agentId] });
      await queryClient.invalidateQueries({ queryKey: ["impeccable-live-update-plan", workspaceId, params.agentId] });
    },
  });
  useEffect(() => {
    let mounted = true;
    setInspecting(true);
    void inspect({ ...ids, ...startOverrides(savedConfig) }).catch((error) => {
      if (mounted) setPreviewError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (mounted) { setInspecting(false); void state.refetch(); } });
    return () => { mounted = false; };
  }, [workspaceId, params.agentId]);

  const logs = useQuery({
    queryKey: ["impeccable-live-logs", workspaceId, params.agentId],
    queryFn: () => developmentLogs({ ...ids, ...(logCursor.current ? { cursor: logCursor.current } : {}) }),
    refetchInterval: 1000,
  });

  useEffect(() => {
    if (needsPanelConfigMigration(tab.state)) saveConfig(savedConfig);
  }, [saveConfig, savedConfig, tab.state]);

  useEffect(() => {
    if (!logs.data) return;
    logCursor.current = logs.data.cursor;
    setLogsTruncated(logs.data.truncated);
    setLogLines((current) => (logs.data.reset ? logs.data.lines : [...current, ...logs.data.lines]).slice(-500));
  }, [logs.data]);

  useEffect(() => {
    const attempt = state.data?.attempt ?? null;
    if (logAttempt.current === attempt) return;
    logAttempt.current = attempt;
    logCursor.current = 0;
    setLogLines([]);
    setLogsTruncated(false);
    void logs.refetch();
  }, [logs.refetch, state.data?.attempt]);

  useEffect(() => {
    setChosenId(null);
  }, [dataAttemptKey(state.data)]);

  useEffect(() => {
    if (advanced && argsError && focusArgsError.current) { argsInput.current?.focus(); focusArgsError.current = false; }
  }, [advanced, argsError]);

  useEffect(() => {
    if (advanced) fieldInputs.current[Object.keys(fields)[0]]?.focus();
  }, [advanced, fields]);

  useEffect(() => {
    if (!navigation?.openBrowser) return;
    const attempt = previewAttemptToOpen(state.data, initiatedAttempt.current, openedAttempt.current);
    if (attempt === null || !state.data?.development.url) return;
    openedAttempt.current = attempt;
    try {
      setPreviewError(null);
      navigation.openBrowser({ url: state.data.development.url, workspaceId });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }, [navigation, state.data, workspaceId]);

  const action = useMutation({
    mutationFn: async (request: "start" | "stop" | "retry" | "inspect" | { kind: "inspect"; cliPath: string }) => {
      const kind = typeof request === "string" ? request : request.kind;
      const currentConfig = typeof request === "string" ? config : { ...config, cliPath: request.cliPath };
      if (kind === "stop") { initiatedAttempt.current = null; return stop(ids); }
      if (kind === "retry") return retry(ids);
      const validation = validatePanelFields(currentConfig);
      setFields(validation);
      if (Object.keys(validation).length) { setAdvanced(true); throw new Error("Check the highlighted settings, then connect again."); }
      const parsed = parseArgumentList(argsText);
      if (parsed.error) {
        focusArgsError.current = true;
        setAdvanced(true);
        setArgsError(parsed.error);
        argsInput.current?.focus();
        throw new Error(parsed.error);
      }
      const argumentsChanged = JSON.stringify(parsed.args) !== JSON.stringify(currentConfig.args);
      const next = argumentsChanged ? withoutSelection({ ...currentConfig, args: parsed.args }) : { ...currentConfig, args: parsed.args };
      setArgsError(null);
      setConfig(next);
      saveConfig(next);
      setEdited(false);
      setChosenId(null);
      if (kind === "inspect") {
        setRecoveryText(null); setRecoveryMessage(null);
        return inspect({ ...ids, ...startOverrides(next) });
      }
      const result = await start({ ...ids, ...startOverrides(next) });
      initiatedAttempt.current = result.attempt;
      return result;
    },
    onSettled: () => { void state.refetch(); },
  });
  const selection = useMutation({
    mutationFn: async (choice: { id: string; persistSelection?: boolean }) => {
      const attempt = state.data?.attempt;
      if (attempt === undefined) throw new Error("Discovery is not ready for a selection.");
      const next = configAfterChoice(config, choice);
      setConfig(next);
      saveConfig(next);
      const result = await select({ ...ids, attempt, selectionId: choice.id });
      initiatedAttempt.current = result.attempt;
      return result;
    },
    onSettled: () => { void state.refetch(); },
  });
  const stopDev = useMutation({
    mutationFn: async () => {
      initiatedAttempt.current = null;
      return stopDevelopment(ids);
    },
    onSettled: () => { void state.refetch(); },
  });

  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, lineHeight: 20 };
  const section = { gap: 8, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border };
  const data = state.data;
  const development = data?.development;
  const session = data?.session;
  const view = state.error || data?.helperReadinessError ? "error" : panelView(data, inspecting);
  const starting = view === "starting" || view === "discovering";
  const busy = action.isPending || selection.isPending || stopDev.isPending || runQuickUpdate.isPending || data?.updateOperation?.phase === "running";
  const configurationLocked = !!session?.active || starting || development?.ownership === "owned";
  const previewUrl = development?.url ?? (session?.active ? session.url : null) ?? config.url;
  const previewReady = !!development?.verified && !!session?.active && !!previewUrl;
  const choices = edited ? [] : data?.choices ?? [];
  const recommended = choices.filter(choice => choice.recommended);
  const chosen = choices.find(choice => choice.id === chosenId) ?? (recommended.length === 1 ? recommended[0] : choices.length === 1 ? choices[0] : undefined);
  const primaryChoices = choices.filter(choice => choice.kind !== "launch" || choices.length === 1);
  const appRoot = session?.active ? session.appRoot : development?.previewRoot ?? development?.appRoot;
  const appName = appRoot?.split(/[/\\]/).filter(Boolean).pop() ?? (config.appPath || "Preview app");
  const title = { idle: "Ready to connect", discovering: "Discovering your app…", selection: "Choose a preview", starting: data?.phase === "stopping" ? "Stopping…" : "Connecting…", connected: "Connected", error: "Connection needs attention" }[view];
  const summary = data?.helperReadinessError || state.error?.message || (view === "connected" ? "Visual editing is connected to this agent."
    : view === "discovering" ? "Checking local servers and readiness."
    : view === "idle" ? "Connect visual editing and open the local preview."
    : view === "error" && development?.phase === "error" ? development.message : data?.message ?? "Connect to discover this app.");
  const readiness = edited ? null : data?.dependencyReadiness;
  const recovery = readiness ? dependencyRecovery(readiness) : null;
  const completionPaused = session?.phase === "completion-paused";
  const completionChecking = session?.phase === "completion-checking";
  const retryBusy = session?.phase === "dispatching" || completionChecking;
  const pendingMessage = session?.phase === "dispatching"
    ? "The request was accepted; the agent is still working. Polling resumes after this turn finishes."
    : completionChecking ? "The agent finished. Checking Impeccable cleanup before polling resumes."
    : completionPaused ? "Finish source cleanup in the agent chat, then recheck. This does not resend the edit."
    : "Delivery is uncertain. Check the agent chat first: retrying may deliver the same event again.";
  const retryLabel = session?.phase === "dispatching" ? "Waiting for agent…" : completionChecking ? "Checking completion…"
    : completionPaused ? "Recheck completion" : "Retry event delivery";
  const canStopOwnedDevelopment = development?.ownership === "owned" && development.phase !== "stopped" && development.phase !== "stopping";
  const quickUpdateActionError = data?.updateOperation?.phase === "failed" ? null : cleanQuickUpdateError(runQuickUpdate.error?.message);
  const quickUpdatePlanError = data?.updateOperation?.phase === "failed" || updatePlan.data?.status === "eligible"
    ? null : cleanQuickUpdateError(updatePlan.error?.message);
  const error = action.error?.message || selection.error?.message || stopDev.error?.message || state.error?.message || previewError;

  function control(label: string, onPress: () => void, primary = false, disabled = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
      accessibilityState={{ disabled }} onPress={onPress} onFocus={() => setFocused(label)} onBlur={() => setFocused(null)}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 10,
        borderWidth: 2, borderColor: focused === label ? colors.foreground : "transparent", borderRadius: 8, backgroundColor: primary ? colors.accent : colors.surface1, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}>
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontWeight: primary ? "600" : "400" }}>{label}</Text>
    </Pressable>;
  }
  async function copyRecovery(value: string) {
    setRecoveryMessage(null);
    setRecoveryText(value);
    try { await copyText(value); setRecoveryMessage("Copied. Run setup on the host running Paseo's daemon, then check again."); }
    catch { setRecoveryMessage("Copy was unavailable. Select and copy the text below."); }
  }
  function updateConfig<K extends keyof PanelConfig>(key: K, value: PanelConfig[K]) {
    setEdited(true);
    setRecoveryText(null); setRecoveryMessage(null);
    setFields({});
    setConfig((current) => key === "selectionId" ? { ...current, [key]: value } : withoutSelection({ ...current, [key]: value }));
  }
  function persistArguments() {
    const parsed = parseArgumentList(argsText);
    setArgsError(parsed.error);
    if (parsed.error) return;
    const next = JSON.stringify(parsed.args) === JSON.stringify(config.args) ? config : withoutSelection({ ...config, args: parsed.args });
    setConfig(next);
    saveConfig(next);
  }
  function openPreview() {
    if (!previewReady || !development?.url) return;
    try {
      setPreviewError(null);
      navigation?.openBrowser?.({ url: development.url, workspaceId });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20, maxWidth: 740, width: "100%" }}
      style={{ flex: 1, backgroundColor: colors.surface0 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: layout.compact ? 22 : 26, fontWeight: "700" }}>{appName}</Text>
        {previewUrl ? <Text selectable style={{ ...text, fontSize: 14, lineHeight: 21 }}>{previewUrl}</Text> : null}
        <Text style={muted}>Impeccable Live</Text>
      </View>
      <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
        <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>{title}</Text>
        <Text selectable={view === "error"} accessibilityRole={view === "error" ? "alert" : undefined} style={muted}>{summary}</Text>
      </View>

      {!edited && updates.data?.status === "available" && <View style={section} accessibilityLiveRegion="polite">
        <Text style={{ ...text, fontWeight: "600" }}>Impeccable update available</Text>
        <Text style={muted}>Installed {updates.data.installedVersion} · Latest {updates.data.latestVersion}</Text>
        {updatePlan.isFetching && <Text style={muted}>Checking whether this installation can be updated here…</Text>}
        {quickUpdatePlanError && <View style={{ gap: 6 }}>
          <Text accessibilityRole="alert" selectable style={muted}>{quickUpdatePlanError}</Text>
          {control("Review update eligibility again", () => { void updatePlan.refetch(); }, false, updatePlan.isFetching || busy)}
        </View>}
        {updatePlan.data?.status === "guidance" && <View style={{ gap: 6 }}>
          <Text selectable style={muted}>Selected installation: {updatePlan.data.selectedPath}</Text>
          <Text selectable style={muted}>{updatePlan.data.reason}</Text>
        </View>}
        {updatePlan.data?.status === "eligible" && <View style={{ gap: 8 }}>
          <Text selectable style={muted}>Selected installation: {updatePlan.data.selectedPath}</Text>
          <Text style={muted}>Scope: {updatePlan.data.scopeLabel}</Text>
          <Text selectable style={muted}>Working project: {updatePlan.data.workingDirectory}</Text>
          <Text style={muted}>Official updater: impeccable@{updatePlan.data.updaterVersion} · Target skill: {updatePlan.data.targetSkillVersion}</Text>
          <Text style={{ ...text, fontWeight: "500" }}>Affected installations</Text>
          {updatePlan.data.affectedInstallations.map(installation =>
            <Text key={installation.path} selectable style={muted}>{installation.provider}: {installation.path} ({installation.version})</Text>)}
          <Text style={muted}>The official scoped updater may refresh every recognized copy listed above, provider agents and commands, engine files, and existing hook wiring. --no-hooks prevents new hook installation, but stale hook repair may still occur. This plugin serializes its own updates only; it cannot lock external installers.</Text>
          {control(runQuickUpdate.isPending || data?.updateOperation?.phase === "running" ? "Updating Impeccable…"
            : `Update ${updatePlan.data.scopeLabel}`, () => {
              const plan = updatePlan.data;
              if (plan?.status === "eligible") runQuickUpdate.mutate(plan);
            }, true, busy)}
        </View>}
        {quickUpdateActionError && <Text accessibilityRole="alert" selectable style={text}>{quickUpdateActionError}</Text>}
        <ExternalLink href="https://impeccable.style/tutorials/getting-started/">Update instructions</ExternalLink>
        {control(refreshUpdates.isPending ? "Checking for updates…" : "Check again", () => refreshUpdates.mutate({ input: updateInput, queryKey: updateKey }), false, refreshUpdates.isPending || updates.isFetching)}
      </View>}

      {data?.updateOperation?.phase === "succeeded" && <View style={section} accessibilityLiveRegion="polite">
        <Text style={{ ...text, fontWeight: "600" }}>Impeccable update verified</Text>
        <Text selectable style={muted}>{data.updateOperation.message}</Text>
        {data.updateOperation.instruction && <Text style={muted}>{data.updateOperation.instruction}</Text>}
        {data.updateOperation.output && <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12 }}>{data.updateOperation.output}</Text>}
      </View>}

      {data?.updateOperation?.phase === "failed" && <View style={section} accessibilityLiveRegion="polite">
        <Text style={{ ...text, fontWeight: "600" }}>Impeccable update needs attention</Text>
        <Text accessibilityRole="alert" selectable style={text}>{data.updateOperation.message}</Text>
        <Text style={muted}>Changes already made by the official updater were not rolled back. Review the selected installation, then check update eligibility again.</Text>
        {control("Review update eligibility again", () => { void updatePlan.refetch(); }, false, updatePlan.isFetching || busy)}
      </View>}

      {readiness && recovery && (readiness.checks.some(check => check.status === "blocked") || recoveryText) && <View style={{ gap: 12 }} accessibilityLabel="Impeccable setup">
        {readiness.checks.filter(check => check.status === "blocked").map(check =>
          <View key={check.id} style={{ gap: 4 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{({ installation: "Find Impeccable", engine: "Prepare the engine", project: "Prepare this app", helper: "Existing session", compatibility: "Align skill and engine versions" } as Record<string, string>)[check.id]}</Text>
            <Text selectable style={muted}>{check.message}</Text>
            {check.detail && <Text selectable style={muted}>{check.detail}</Text>}
          </View>)}
        {readiness.cliPath && readiness.checks.some(check => check.id === "installation" && check.status === "blocked") &&
          control("Use project installation", () => {
            setRecoveryText(null); setRecoveryMessage(null);
            action.mutate({ kind: "inspect", cliPath: readiness.cliPath! });
          }, false, busy || configurationLocked)}
        {recovery.installation && <View style={{ gap: 8 }}>
          <Text selectable style={muted}>On the host running Paseo's daemon, run npx impeccable install. Choose your agent and project or global scope, then reload the agent.</Text>
          <ExternalLink href="https://impeccable.style/tutorials/getting-started/">Installation instructions</ExternalLink>
        </View>}
        {(recovery.installation || readiness.checks.some(check => check.id === "engine" && check.status === "blocked")) &&
          control("Locate existing installation", () => { setAdvanced(true); setTimeout(() => fieldInputs.current.cliPath?.focus(), 0); }, false, configurationLocked)}
        {readiness.checks.some(check => check.id === "compatibility" && check.status === "blocked") && <View style={{ gap: 8 }}>
          <Text style={muted}>Update Impeccable using its original installation method, or locate an installation with a matching engine.</Text>
          <ExternalLink href="https://impeccable.style/tutorials/getting-started/">Update instructions</ExternalLink>
          {control("Locate matching installation", () => { setAdvanced(true); setTimeout(() => fieldInputs.current.cliPath?.focus(), 0); }, false, configurationLocked)}
        </View>}
        {recovery.engineCommand && <View style={{ gap: 6 }}>
          <Text style={muted}>Run this command in a terminal on the daemon host. The upstream launcher may download and cache its engine. Checks in this panel do not download it.</Text>
          {control("Copy engine setup command", () => { void copyRecovery(recovery.engineCommand!); }, false, busy)}
        </View>}
        {recovery.projectPrompt && control("Copy project setup prompt", () => { void copyRecovery(recovery.projectPrompt!); }, false, busy)}
        {recoveryText && <Text selectable style={{ ...text, fontFamily: "monospace" }}>{recoveryText}</Text>}
        {recoveryMessage && <Text accessibilityLiveRegion="polite" style={muted}>{recoveryMessage}</Text>}
      </View>}

      {choices.length > 1 && <View style={{ gap: 8 }} accessibilityLabel="Preview choices">
        {primaryChoices.map(choice => <Pressable key={choice.id} accessibilityRole="button"
          accessibilityState={{ selected: chosen?.id === choice.id, disabled: busy }} disabled={busy}
          onFocus={() => setFocused(choice.id)} onBlur={() => setFocused(null)}
          onPress={() => setChosenId(choice.id)}
          style={{ padding: 12, gap: 4, borderRadius: 8, borderWidth: 1,
            borderColor: focused === choice.id ? colors.foreground : chosen?.id === choice.id ? colors.accent : colors.border, backgroundColor: colors.surface1 }}>
          <Text style={{ ...text, fontWeight: "600" }}>{chosen?.id === choice.id ? "Selected: " : ""}{choice.label}</Text>
          <Text style={muted}>{choice.detail}</Text>
        </Pressable>)}
      </View>}

      <View style={{ gap: 10, alignItems: layout.compact ? "stretch" : "flex-start" }}>
        {starting ? control(data?.phase === "stopping" ? "Stopping…" : "Cancel", () => {
          initiatedAttempt.current = null;
          if (development?.ownership === "owned" || development?.ownership === "none") stopDev.mutate();
          else action.mutate("stop");
        }, true, busy || data?.phase === "stopping" || !data)
        : previewReady ? navigation?.openBrowser ? control("Open preview", openPreview, true)
          : layout.platform === "web" ? <ExternalLink href={previewUrl}>Open preview</ExternalLink> : <Text style={muted}>Open this local preview in Paseo Desktop.</Text>
        : control("Connect and open preview", () => {
          setPreviewError(null); action.reset(); selection.reset(); stopDev.reset();
          if (chosen) selection.mutate(chosen); else action.mutate("start");
        }, true, busy || !!data?.helperReadinessError || (choices.length > 1 && !chosen))}
        {!starting && choices.length > 1 && choices.filter(choice => choice.kind === "launch").map(choice =>
          <View key={choice.id}>{control("Start another development server", () => selection.mutate(choice), false, busy || !!data?.helperReadinessError)}</View>)}
      </View>
      {(view === "error" || edited) && !starting && control("Check again", () => { action.reset(); selection.reset(); stopDev.reset(); setPreviewError(null); action.mutate("inspect"); }, false, busy)}
      {error && <Text accessibilityRole="alert" selectable style={text}>{error}</Text>}

      {(session?.active || canStopOwnedDevelopment) && !starting && <View style={{ gap: 8 }}>
        <View style={{ flexDirection: layout.compact ? "column" : "row", flexWrap: "wrap", gap: 8 }}>
          {session?.active && control("Stop session", () => action.mutate("stop"), false, busy)}
          {canStopOwnedDevelopment && control("Stop development server", () => stopDev.mutate(), false, busy)}
        </View>
        <Text style={muted}>Stop session ends visual editing and keeps the app running.</Text>
      </View>}

      {session?.pendingEvent && <View style={section}>
        <Text style={muted}>{pendingMessage}</Text>
        <Text selectable style={muted}>Pending event: {session.pendingEvent}</Text>
        {control(retryLabel, () => action.mutate("retry"), false, busy || retryBusy)}
      </View>}

      <View style={section}>
        <Text style={{ ...text, fontWeight: "600" }}>Connection details</Text>
        <Text style={muted}>Server: {choices.some(choice => choice.kind === "reuse") ? "available · select a server to connect" : development?.verified ? development.ownership === "external" ? "external · left running when disconnected" : "started by this plugin" : development?.ownership === "owned" ? "started by this plugin · checking readiness" : "not connected"}</Text>
        <Text style={muted}>Helper: {data?.helperReadinessError ? "setup required" : session?.active ? session.phase === "running" ? "connected" : session.phase.replaceAll("-", " ") : "not connected"}</Text>
        {view === "error" && session && ["error", "ownership-lost"].includes(session.phase) && session.message !== data?.message && <Text selectable style={text}>{session.message}</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)} onFocus={() => setFocused("details")} onBlur={() => setFocused(null)} style={{ minHeight: 44, justifyContent: "center", borderWidth: 2, borderColor: focused === "details" ? colors.foreground : "transparent", borderRadius: 8, paddingHorizontal: 4 }}>
          <Text style={{ ...text, fontWeight: "600" }}>{details ? "Hide details" : "Details"}</Text>
        </Pressable>
        {details && <View style={{ gap: 8 }}>
          {development?.appRoot && <Text selectable style={muted}>Launch folder: {development.appRoot}</Text>}
          {appRoot && <Text selectable style={muted}>Preview folder: {appRoot}</Text>}
          {development?.command && <Text selectable style={{ ...text, fontFamily: "monospace" }}>{development.command}</Text>}
          {(readiness?.cliPath || config.cliPath) && <Text selectable style={muted}>Impeccable: {readiness?.cliPath || config.cliPath}</Text>}
          {readiness?.engineVersion && <Text style={muted}>Engine: {readiness.engineVersion}</Text>}
          {readiness?.cliPath && <View style={{ gap: 8 }}>
            <Text style={muted}>{updates.isFetching || refreshUpdates.isPending ? "Checking for Impeccable updates…"
              : updates.error || (refreshUpdates.error && JSON.stringify(refreshUpdates.variables?.queryKey) === JSON.stringify(updateKey)) || updates.data?.status === "unavailable" ? "Couldn’t check for Impeccable updates."
              : updates.data?.status === "disabled" ? "Impeccable update checks are disabled."
              : updates.data?.status === "current" ? `Impeccable ${updates.data.installedVersion}: no newer skill version found.`
              : updates.data?.status === "available" ? `Impeccable ${updates.data.installedVersion}: ${updates.data.latestVersion} is available.`
              : "Impeccable skill version is unknown."}</Text>
            {updates.data?.status !== "disabled" && control(refreshUpdates.isPending ? "Checking for updates…" : "Check for updates", () => refreshUpdates.mutate({ input: updateInput, queryKey: updateKey }), false, refreshUpdates.isPending || updates.isFetching)}
          </View>}
          {readiness?.cliPath && <Text style={muted}>Launcher and engine checks do not verify that the attached agent can load the skill. Install Impeccable for that coding tool and reload the agent after installation.</Text>}
          {readiness?.checks.filter(check => check.id === "compatibility").map(check => <Text key={check.id} selectable style={muted}>{check.message}</Text>)}
        </View>}
      </View>

      <View style={section}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)} onFocus={() => setFocused("advanced")} onBlur={() => setFocused(null)} style={{ minHeight: 44, justifyContent: "center", borderWidth: 2, borderColor: focused === "advanced" ? colors.foreground : "transparent", borderRadius: 8, paddingHorizontal: 4 }}>
          <Text style={{ ...text, fontWeight: "600" }}>{advanced ? "Hide advanced settings" : "Advanced settings"}</Text>
        </Pressable>
        {advanced && <View style={{ gap: 14 }}>
          <Text style={muted}>{configurationLocked ? "Stop the session and its owned server before changing settings." : "Blank fields use discovery. Settings apply to this panel only."}</Text>
          {([
            ["appPath", "App folder", "Relative to this workspace, for example frontend."],
            ["command", "Development executable", "For example npm. Arguments are entered separately."],
            ["args", "Development arguments (JSON)", 'For example ["run", "dev"]. No shell syntax.'],
            ["url", "Local preview URL", "For example http://localhost:5173/."],
            ["cliPath", "Impeccable executable", "Absolute path to an installed executable."],
          ] as const).map(([key, label, hint]) => {
            const fieldError = key === "args" ? argsError : fields[key as keyof typeof fields];
            return <View key={key} style={{ gap: 5 }}>
              <Text style={{ ...text, fontWeight: "500" }}>{label}</Text>
              <Text style={muted}>{hint}</Text>
              <TextInput ref={node => { fieldInputs.current[key] = node; if (key === "args") argsInput.current = node; }} accessibilityLabel={label} accessibilityHint={fieldError ?? hint}
                value={key === "args" ? argsText : config[key]} placeholder="Automatic" placeholderTextColor={colors.foregroundMuted}
                editable={!configurationLocked} autoCapitalize="none" autoCorrect={false}
                style={{ ...text, backgroundColor: colors.surface1, padding: 12, borderRadius: 8, minHeight: 44, borderWidth: 1, borderColor: fieldError || focused === `field-${key}` ? colors.foreground : colors.border, opacity: configurationLocked ? 0.6 : 1 }}
                onFocus={() => setFocused(`field-${key}`)}
                onBlur={() => { setFocused(null); key === "args" ? persistArguments() : saveConfig(config); }}
                onChangeText={value => { if (key === "args") { setArgsText(value); setArgsError(null); setEdited(true); } else updateConfig(key, value); }} />
              {fieldError && <Text accessibilityRole="alert" style={text}>{fieldError}</Text>}
            </View>;
          })}
        </View>}
      </View>

      {(starting || view === "error" || logLines.length > 0 || logs.error) && <View style={section}>
        <Text style={{ ...text, fontWeight: "600" }}>Startup output</Text>
        {!logs.data?.available && <Text style={muted}>Retained plugin output. External server logs are unavailable.</Text>}
        {logsTruncated && <Text style={muted}>Older output removed. Showing the latest 500 lines.</Text>}
        {logs.error && <Text accessibilityRole="alert" style={muted}>Cannot refresh output. Status checks continue.</Text>}
        <ScrollView style={{ maxHeight: 240, backgroundColor: colors.surface1, borderRadius: 8 }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
          {logLines.length ? [...new Set(logLines.map(line => line.attempt))].map(attempt => <View key={attempt} style={{ gap: 6, paddingBottom: 12 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{attempt === data?.attempt ? "Current attempt" : `Previous attempt ${attempt}`}</Text>
            {logLines.filter(line => line.attempt === attempt).map(line => <Text key={line.sequence} selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{line.time} {line.source}  {line.text}</Text>)}
          </View>)
            : <Text style={muted}>{starting ? "Waiting for startup output…" : "No output for this attempt."}</Text>}
        </ScrollView>
      </View>}
      {view === "connected" && <Text style={muted}>In the preview, pick an element and describe a change. Compare variants, then accept or discard. Use Steer for a page-wide request.</Text>}
    </ScrollView>
  );
}

function withoutSelection(config: PanelConfig): PanelConfig {
  const { selectionId: _discarded, ...rest } = config;
  return rest;
}

function dataAttemptKey(status: import("../shared/live").SessionStatus | undefined) {
  return `${status?.attempt}:${status?.choices.map(choice => choice.id).join(",")}`;
}
