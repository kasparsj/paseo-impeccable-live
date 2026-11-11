import { useRpc, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  devLogsRpc, retryRpc, selectRpc, startRpc, statusRpc, stopDevServerRpc, stopRpc,
} from "../shared/live";
import {
  canCancelSessionStartup, configAfterChoice, defaultPanelConfig, needsPanelConfigMigration, panelConfigSchema, parseArgumentList,
  previewAttemptToOpen, startOverrides, type PanelConfig,
} from "./live-state";

type LogLine = { sequence: number; source: "stdout" | "stderr" | "system"; text: string; time: string };

export function LivePanel({ theme, layout, workspaceId, params, tab, navigation }: PluginAgentPanelProps) {
  const [savedConfig, saveConfig] = useTabState(tab, panelConfigSchema, defaultPanelConfig);
  const [config, setConfig] = useState<PanelConfig>(savedConfig);
  const [argsText, setArgsText] = useState(() => JSON.stringify(savedConfig.args));
  const [argsError, setArgsError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logsTruncated, setLogsTruncated] = useState(false);
  const logCursor = useRef(0);
  const logAttempt = useRef<number | null>(null);
  const initiatedAttempt = useRef<number | null>(null);
  const openedAttempt = useRef<number | null>(null);

  const start = useRpc(startRpc);
  const status = useRpc(statusRpc);
  const stop = useRpc(stopRpc);
  const retry = useRpc(retryRpc);
  const select = useRpc(selectRpc);
  const stopDevelopment = useRpc(stopDevServerRpc);
  const developmentLogs = useRpc(devLogsRpc);
  const ids = { workspaceId, agentId: params.agentId };

  const state = useQuery({
    queryKey: ["impeccable-live", workspaceId, params.agentId],
    queryFn: () => status(ids),
    refetchInterval: 1000,
  });
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
    mutationFn: async (kind: "start" | "stop" | "retry") => {
      if (kind === "stop") return stop(ids);
      if (kind === "retry") return retry(ids);
      const parsed = parseArgumentList(argsText);
      if (parsed.error) {
        setArgsError(parsed.error);
        throw new Error(parsed.error);
      }
      const argumentsChanged = JSON.stringify(parsed.args) !== JSON.stringify(config.args);
      const next = argumentsChanged ? withoutSelection({ ...config, args: parsed.args }) : { ...config, args: parsed.args };
      setArgsError(null);
      setConfig(next);
      saveConfig(next);
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
  const muted = { color: colors.foregroundMuted, lineHeight: 21 };
  const button = {
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8,
    backgroundColor: colors.surface1, minHeight: 44, justifyContent: "center" as const,
  };
  const input = {
    ...text, backgroundColor: colors.surface1, padding: 12, borderRadius: 8,
    minHeight: 44, borderWidth: 1, borderColor: colors.border,
  };
  const section = { gap: 7, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border };
  const data = state.data;
  const development = data?.development;
  const session = data?.session;
  const developmentBusy = development?.phase === "discovering" || development?.phase === "starting" || development?.phase === "verifying";
  const configurationLocked = !!session?.active || developmentBusy || (development?.ownership === "owned" && development.phase === "ready");
  const fullyReady = development?.verified === true && session?.active === true;
  const previewUrl = development?.url ?? session?.url ?? config.url;
  const previewReady = fullyReady && !!development?.url;
  const completionPaused = session?.phase === "completion-paused";
  const completionChecking = session?.phase === "completion-checking";
  const retryBusy = session?.phase === "dispatching" || session?.phase === "completion-checking";
  const pendingMessage = session?.phase === "dispatching"
    ? "The request was accepted and the agent is still working. Polling resumes after this turn finishes."
    : completionChecking
      ? "The agent turn finished. Impeccable cleanup is being checked before polling resumes."
      : completionPaused
        ? "Source cleanup is still pending. Finish it in the agent chat, then recheck; this does not resend the edit."
        : "Delivery failed or is uncertain. Check the agent chat first: retrying may send an event that already arrived.";
  const retryLabel = session?.phase === "dispatching" ? "Waiting for agent…"
    : completionChecking ? "Checking completion…"
      : completionPaused ? "Recheck completion" : "Retry event delivery";
  const canCancelStartup = developmentBusy || development?.phase === "selection-required";
  const canStopOwnedDevelopment = development?.ownership === "owned" && development.phase !== "stopped" && development.phase !== "stopping";
  const stopDevelopmentEnabled = canCancelStartup || canStopOwnedDevelopment;
  const sessionStarting = canCancelSessionStartup(data?.phase);
  const canStopSession = !!session?.active || sessionStarting;
  const overallMessage = data?.message && !data.choices.length && data.message !== development?.message && data.message !== session?.message
    ? data.message : null;
  const anyActionPending = action.isPending || selection.isPending || stopDev.isPending;

  function updateConfig<K extends keyof PanelConfig>(key: K, value: PanelConfig[K]) {
    setConfig((current) => key === "selectionId" ? { ...current, [key]: value } : withoutSelection({ ...current, [key]: value }));
  }
  function persistArguments() {
    const parsed = parseArgumentList(argsText);
    setArgsError(parsed.error);
    if (parsed.error) return;
    const next = withoutSelection({ ...config, args: parsed.args });
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
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20, maxWidth: 780, width: "100%" }}
      style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 26, fontWeight: "700" }}>Impeccable Live</Text>
        <Text style={muted}>Start the app, connect visual editing, and send browser requests to this agent.</Text>
      </View>

      {overallMessage && (
        <Text accessibilityLiveRegion="polite" accessibilityRole={data?.phase === "error" ? "alert" : undefined}
          selectable={data?.phase === "error"} style={data?.phase === "error" ? text : muted}>
          {overallMessage}
        </Text>
      )}

      <View accessibilityLiveRegion="polite" style={section}>
        <Text style={{ ...text, fontSize: 17, fontWeight: "700" }}>Development server · {development?.phase ?? "checking"}</Text>
        <Text style={muted}>{development?.message ?? "Checking development-server status…"}</Text>
        {development?.appRoot && <Text selectable style={muted}>{development.appRoot}</Text>}
        {development?.command && <Text selectable style={{ ...text, fontFamily: "monospace" }}>{development.command}</Text>}
        {development?.url && <Text selectable style={muted}>{development.url}</Text>}
        {development?.ownership === "external" && <Text style={muted}>Started outside this plugin. It will be left running.</Text>}
      </View>

      <View accessibilityLiveRegion="polite" style={section}>
        <Text style={{ ...text, fontSize: 17, fontWeight: "700" }}>Impeccable session · {session?.phase ?? "checking"}</Text>
        <Text style={muted}>{session?.message ?? "Checking the local session…"}</Text>
        {session?.pendingEvent && <Text style={muted}>Pending event: {session.pendingEvent}</Text>}
      </View>

      {!!data?.choices.length && (
        <View style={section}>
          <Text style={{ ...text, fontWeight: "700" }}>Choose a development target</Text>
          <Text style={muted}>{data.message || "Choose how this panel should continue."}</Text>
          {data.choices.map((choice) => (
            <Pressable key={choice.id} accessibilityRole="button" disabled={selection.isPending}
              accessibilityState={{ disabled: selection.isPending }} style={{ ...button, opacity: selection.isPending ? 0.5 : 1 }}
              onPress={() => selection.mutate(choice)}>
              <Text style={{ ...text, fontWeight: "600" }}>{choice.label}</Text>
              <Text style={muted}>{choice.detail}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Pressable accessibilityRole="button" disabled={anyActionPending || developmentBusy || fullyReady}
          accessibilityState={{ disabled: anyActionPending || developmentBusy || fullyReady }}
          style={{ ...button, backgroundColor: colors.accent, opacity: anyActionPending || developmentBusy || fullyReady ? 0.5 : 1 }}
          onPress={() => action.mutate("start")}>
          <Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{action.isPending ? "Starting…" : "Start / resume"}</Text>
        </Pressable>
        {navigation?.openBrowser ? (
          <Pressable accessibilityRole="button" disabled={!previewReady} accessibilityState={{ disabled: !previewReady }}
            style={{ ...button, opacity: previewReady ? 1 : 0.5 }} onPress={openPreview}>
            <Text style={text}>Open preview</Text>
          </Pressable>
        ) : previewReady && layout.platform === "web" && previewUrl ? (
          <ExternalLink href={previewUrl}>Open preview externally</ExternalLink>
        ) : null}
        <Pressable accessibilityRole="button" disabled={!canStopSession || action.isPending}
          accessibilityState={{ disabled: !canStopSession || action.isPending }}
          style={{ ...button, opacity: canStopSession && !action.isPending ? 1 : 0.5 }} onPress={() => action.mutate("stop")}>
          <Text style={text}>{sessionStarting ? "Cancel session startup" : "Stop session"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!stopDevelopmentEnabled || stopDev.isPending}
          accessibilityState={{ disabled: !stopDevelopmentEnabled || stopDev.isPending }}
          style={{ ...button, opacity: stopDevelopmentEnabled && !stopDev.isPending ? 1 : 0.5 }} onPress={() => stopDev.mutate()}>
          <Text style={text}>{canCancelStartup ? "Cancel startup" : development?.ownership === "external" ? "Development server is external" : "Stop development server"}</Text>
        </Pressable>
      </View>

      {session?.pendingEvent && (
        <View style={{ gap: 8 }}>
          <Text style={muted}>{pendingMessage}</Text>
          <Pressable accessibilityRole="button" disabled={anyActionPending || retryBusy} style={{ ...button, opacity: anyActionPending || retryBusy ? 0.5 : 1 }}
            onPress={() => action.mutate("retry")}>
            <Text style={text}>{retryLabel}</Text>
          </Pressable>
        </View>
      )}

      {(action.error || selection.error || stopDev.error || state.error || previewError || argsError) && (
        <Text accessibilityRole="alert" selectable style={text}>
          {String(action.error?.message || selection.error?.message || stopDev.error?.message || state.error?.message || previewError || argsError)}
        </Text>
      )}

      {(logs.data?.available || logLines.length > 0 || logs.error) && (
        <View style={section}>
          <Text style={{ ...text, fontWeight: "700" }}>Development logs</Text>
          {logsTruncated && <Text style={muted}>Older output was removed to keep this view bounded.</Text>}
          {logs.error && <Text accessibilityRole="alert" style={muted}>Logs could not be refreshed. Status updates are still active.</Text>}
          {logLines.length ? logLines.map((line) => (
            <Text key={line.sequence} selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>
              {line.time} {line.source}  {line.text}
            </Text>
          )) : <Text style={muted}>Waiting for output…</Text>}
        </View>
      )}

      <View style={section}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced((visible) => !visible)}>
          <Text style={{ ...text, fontWeight: "600" }}>{advanced ? "Hide" : "Show"} advanced settings</Text>
        </Pressable>
        {advanced && (
          <View style={{ gap: 12 }}>
            <Text style={muted}>Leave fields blank to use automatic discovery. Overrides apply to this panel only.</Text>
            <Text style={text}>App folder within this workspace</Text>
            <TextInput accessibilityLabel="App folder within this workspace" value={config.appPath}
              placeholder="Automatic" placeholderTextColor={colors.foregroundMuted} editable={!configurationLocked}
              autoCapitalize="none" autoCorrect={false} style={input}
              onBlur={() => saveConfig(config)} onChangeText={(appPath) => updateConfig("appPath", appPath)} />
            <Text style={text}>Development executable</Text>
            <TextInput accessibilityLabel="Development executable" value={config.command}
              placeholder="Automatic" placeholderTextColor={colors.foregroundMuted} editable={!configurationLocked}
              autoCapitalize="none" autoCorrect={false} style={input}
              onBlur={() => saveConfig(config)} onChangeText={(command) => updateConfig("command", command)} />
            <Text style={text}>Development arguments</Text>
            <TextInput accessibilityLabel="Development arguments as JSON" value={argsText}
              placeholder={'["run", "dev"]'} placeholderTextColor={colors.foregroundMuted} editable={!configurationLocked}
              autoCapitalize="none" autoCorrect={false} style={input} onBlur={persistArguments}
              onChangeText={(value) => { setArgsText(value); setArgsError(null); }} />
            <Text style={text}>Local preview URL</Text>
            <TextInput accessibilityLabel="Local preview URL" value={config.url}
              placeholder="Automatic" placeholderTextColor={colors.foregroundMuted} editable={!configurationLocked}
              autoCapitalize="none" autoCorrect={false} style={input}
              onBlur={() => saveConfig(config)} onChangeText={(url) => updateConfig("url", url)} />
            <Text style={text}>Impeccable executable path</Text>
            <TextInput accessibilityLabel="Impeccable executable path" value={config.cliPath}
              placeholder="Automatic" placeholderTextColor={colors.foregroundMuted} editable={!configurationLocked}
              autoCapitalize="none" autoCorrect={false} style={input}
              onBlur={() => saveConfig(config)} onChangeText={(cliPath) => updateConfig("cliPath", cliPath)} />
          </View>
        )}
      </View>

      {layout.platform !== "web" && <Text style={muted}>Use Paseo Desktop on the development machine to open this local preview.</Text>}
      <View style={{ gap: 8 }}>
        <Text style={{ ...text, fontWeight: "600" }}>In the preview</Text>
        <Text style={muted}>Pick an element and describe a change, compare variants, then accept or discard. Use Steer for a page-wide request.</Text>
        <Text style={muted}>Existing Product, Design, and Live configuration are required. Setup errors remain visible above.</Text>
      </View>
    </ScrollView>
  );
}

function withoutSelection(config: PanelConfig): PanelConfig {
  const { selectionId: _discarded, ...rest } = config;
  return rest;
}
