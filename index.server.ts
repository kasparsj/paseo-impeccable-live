import type { PluginServerContext } from "@getpaseo/plugin/server";
import { SessionCoordinator } from "./server/session";
import { applyQuickUpdateRpc, checkUpdatesRpc, devLogsRpc, inspectRpc, prepareQuickUpdateRpc, retryRpc, selectRpc, startRpc, statusRpc, stopDevServerRpc, stopRpc } from "./shared/live";

export default function contribute(server: PluginServerContext) {
  const session = new SessionCoordinator();
  server.handle(startRpc, (input, { paseo }) => session.start(input, paseo));
  server.handle(inspectRpc, (input, { paseo }) => session.inspect(input, paseo));
  server.handle(statusRpc, (input) => session.status(input));
  server.handle(checkUpdatesRpc, (input) => session.checkUpdates(input));
  server.handle(prepareQuickUpdateRpc, (input, { paseo }) => session.prepareQuickUpdate(input, paseo));
  server.handle(applyQuickUpdateRpc, (input, { paseo }) => session.applyQuickUpdate(input, paseo));
  server.handle(stopRpc, (input) => session.stopSession(input));
  server.handle(retryRpc, (input) => session.retry(input));
  server.handle(selectRpc, (input) => session.select(input));
  server.handle(stopDevServerRpc, (input) => session.stopDevelopment(input));
  server.handle(devLogsRpc, (input) => session.logs(input, input.cursor));
  return () => session.shutdown();
}
