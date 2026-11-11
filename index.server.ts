import type { PluginServerContext } from "@getpaseo/plugin/server";
import { LiveBridge } from "./server/live";
import { retryRpc, startRpc, statusRpc, stopRpc } from "./shared/live";

export default function contribute(server: PluginServerContext) {
  const bridge = new LiveBridge();
  server.handle(startRpc, (input, { paseo }) => bridge.start(input, paseo));
  server.handle(statusRpc, (input) => bridge.status(input));
  server.handle(stopRpc, (input) => bridge.stop(input));
  server.handle(retryRpc, (input) => bridge.retry(input));
  return () => bridge.shutdown();
}
