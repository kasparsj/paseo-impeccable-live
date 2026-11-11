import { useRpc, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { z } from "zod";
import { startRpc, statusRpc, stopRpc, retryRpc } from "../shared/live";

const configSchema = z.object({ appPath: z.string(), url: z.string(), cliPath: z.string() });
const defaults = { appPath: ".", url: "http://localhost:5173/", cliPath: "" };

export function LivePanel({ theme, layout, workspaceId, params, tab, navigation }: PluginAgentPanelProps) {
  const [savedConfig, saveConfig] = useTabState(tab, configSchema, defaults);
  const [config, setConfig] = useState(savedConfig);
  const [advanced, setAdvanced] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const start = useRpc(startRpc);
  const status = useRpc(statusRpc);
  const stop = useRpc(stopRpc);
  const retry = useRpc(retryRpc);
  const ids = { workspaceId, agentId: params.agentId };
  const state = useQuery({
    queryKey: ["impeccable-live", workspaceId, params.agentId],
    queryFn: () => status(ids), refetchInterval: 2000,
  });
  const action = useMutation({
    mutationFn: async (kind: "start" | "stop" | "retry") => {
      if (kind === "stop") return stop(ids);
      if (kind === "retry") return retry(ids);
      saveConfig(config);
      return start({ ...ids, appPath: config.appPath, url: config.url,
        ...(config.cliPath ? { cliPath: config.cliPath } : {}) });
    },
    onSettled: () => { void state.refetch(); },
  });
  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted, lineHeight: 21 };
  const button = { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8,
    backgroundColor: colors.surface1, minHeight: 44, justifyContent: "center" as const };
  const input = { ...text, backgroundColor: colors.surface1, padding: 12, borderRadius: 8,
    minHeight: 44, borderWidth: 1, borderColor: colors.border };
  const running = state.data?.active === true;
  const busy = action.isPending || state.isPending;
  const completionPending = state.data?.phase === "completion-paused" || state.data?.phase === "completion-checking";
  const retryBusy = state.data?.phase === "dispatching" || state.data?.phase === "completion-checking";
  const previewUrl = state.data?.url || config.url;
  const localUrl = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(previewUrl);
  function openPreview() {
    try {
      setPreviewError(null);
      navigation?.openBrowser?.({ url: previewUrl, workspaceId });
    } catch (error) { setPreviewError(String(error)); }
  }
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20,
      maxWidth: 780, width: "100%" }} style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 26, fontWeight: "700" }}>Impeccable Live</Text>
        <Text style={muted}>Work visually on your running app. The plugin listens in the background and sends browser requests to this agent.</Text>
      </View>
      <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
        <Text style={{ ...text, fontWeight: "600" }}>Session: {state.data?.phase ?? "checking"}</Text>
        <Text style={muted}>{state.data?.message ?? "Checking the local session…"}</Text>
        {state.data?.appRoot && <Text selectable style={muted}>{state.data.appRoot}</Text>}
        {state.data?.pendingEvent && <Text style={muted}>Pending event: {state.data.pendingEvent}</Text>}
      </View>
      <View style={{ gap: 8 }}>
        <Text style={text}>App folder within this workspace</Text>
        <TextInput accessibilityLabel="App folder within this workspace" value={config.appPath}
          editable={!running && !busy} autoCapitalize="none" style={input}
          onBlur={() => saveConfig(config)} onChangeText={appPath => setConfig(previous => ({ ...previous, appPath }))} />
        <Text style={muted}>Use “.” for the workspace root. A frontend app can be discovered automatically; set its relative folder when needed.</Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={text}>Local preview URL</Text>
        <TextInput accessibilityLabel="Local preview URL" value={config.url}
          editable={!running && !busy} autoCapitalize="none" autoCorrect={false} style={input}
          onBlur={() => saveConfig(config)} onChangeText={url => setConfig(previous => ({ ...previous, url }))} />
        <Text style={muted}>Start your development server first. The preview requires the desktop running the app and helper. Phone preview and remote forwarding are not included.</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Pressable accessibilityRole="button" disabled={busy || running}
          accessibilityState={{ disabled: busy || running }}
          style={{ ...button, backgroundColor: colors.accent, opacity: busy || running ? 0.5 : 1 }}
          onPress={() => action.mutate("start")}>
          <Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{action.isPending ? "Working…" : "Start / resume"}</Text>
        </Pressable>
        {navigation?.openBrowser ? (
          <Pressable accessibilityRole="button" disabled={!localUrl} style={button} onPress={openPreview}>
            <Text style={text}>Open preview</Text>
          </Pressable>
        ) : localUrl && layout.platform === "web" ? <ExternalLink href={previewUrl}>Open preview externally</ExternalLink> : null}
        <Pressable accessibilityRole="button" disabled={busy} style={button} onPress={() => action.mutate("stop")}>
          <Text style={text}>Stop session</Text>
        </Pressable>
      </View>
      {state.data?.pendingEvent && (
        <View style={{ gap: 8 }}>
          <Text style={muted}>{completionPending ? "Source cleanup is still pending. Finish it in the agent chat, then recheck; this does not resend the edit." : "Delivery failed or is uncertain. Check the agent’s chat first: retrying may send an event that already arrived."}</Text>
          <Pressable accessibilityRole="button" disabled={busy || retryBusy} style={button} onPress={() => action.mutate("retry")}>
            <Text style={text}>{completionPending ? "Recheck completion" : "Retry event delivery"}</Text>
          </Pressable>
        </View>
      )}
      {(action.error || state.error || previewError) && <Text accessibilityRole="alert" selectable style={text}>
        {String(action.error?.message || state.error?.message || previewError)}
      </Text>}
      <View style={{ gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)}>
          <Text style={text}>{advanced ? "Hide" : "Show"} advanced settings</Text>
        </Pressable>
        {advanced && <TextInput accessibilityLabel="Impeccable executable path" value={config.cliPath}
          placeholder="Impeccable executable path (automatic when empty)" placeholderTextColor={colors.foregroundMuted}
          editable={!running && !busy} autoCapitalize="none" style={input}
          onBlur={() => saveConfig(config)} onChangeText={cliPath => setConfig(previous => ({ ...previous, cliPath }))} />}
      </View>
      {layout.platform !== "web" && <Text style={muted}>Use Paseo Desktop on the development machine to open this local preview.</Text>}
      <View style={{ gap: 8 }}>
        <Text style={{ ...text, fontWeight: "600" }}>In the preview</Text>
        <Text style={muted}>Pick an element and describe a change, compare variants, then accept or discard. Use Steer for a page-wide request. The agent edits your local source when a request needs work.</Text>
        <Text style={muted}>Existing Product, Design, and Live configuration are required. Setup errors are shown above. This community integration uses your installed Impeccable and configured agent provider.</Text>
      </View>
    </ScrollView>
  );
}
