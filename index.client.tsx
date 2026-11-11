import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LivePanel } from "./client/live-panel";

export default function contribute(client: PluginClientContext) {
  client.addAgentPanel({ id: "live", title: "Impeccable Live", icon: "MousePointer2", Component: LivePanel });
  client.addCommandCenterItem({
    id: "open-live", title: "Open Impeccable Live", icon: "MousePointer2",
    keywords: ["design", "preview", "impeccable"], context: "agent",
    onSelect: ({ openPanel }) => openPanel("live"),
  });
  client.addSlashCommand({
    name: "impeccable-live", description: "Open the Impeccable Live workspace",
    argumentHint: "", context: "agent",
    onSubmit: ({ openPanel }) => openPanel("live"),
  });
  return () => {};
}
