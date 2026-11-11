import { z } from "zod";
import type { SessionStatus } from "../shared/live";

const versionTwoConfigSchema = z.object({
  version: z.literal(2),
  appPath: z.string(),
  url: z.string(),
  cliPath: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  selectionId: z.string().optional(),
});

const legacyConfigSchema = z.object({
  appPath: z.string(),
  url: z.string(),
  cliPath: z.string(),
});

export type PanelConfig = z.infer<typeof versionTwoConfigSchema>;

export const defaultPanelConfig: PanelConfig = {
  version: 2,
  appPath: "",
  url: "",
  cliPath: "",
  command: "",
  args: [],
};

export const panelConfigSchema: z.ZodType<PanelConfig> = z.union([
  versionTwoConfigSchema,
  legacyConfigSchema.transform((legacy): PanelConfig => ({
    version: 2,
    appPath: legacy.appPath,
    url: legacy.url,
    cliPath: legacy.cliPath,
    command: "",
    args: [],
  })),
]);

export function needsPanelConfigMigration(value: unknown): boolean {
  return !!value && typeof value === "object" && !("version" in value) && legacyConfigSchema.safeParse(value).success;
}

export function parseArgumentList(value: string): { args: string[]; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { args: [], error: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== "string")) {
      return { args: [], error: "Arguments must be a JSON array of strings." };
    }
    if (parsed.length > 100 || parsed.some((argument) => argument.length > 4096)) {
      return { args: [], error: "Use at most 100 arguments, each no longer than 4096 characters." };
    }
    return { args: parsed, error: null };
  } catch {
    return { args: [], error: "Arguments must be valid JSON, for example [\"run\", \"dev\"]." };
  }
}

export function startOverrides(config: PanelConfig) {
  return {
    ...(config.appPath.trim() ? { appPath: config.appPath.trim() } : {}),
    ...(config.url.trim() ? { url: config.url.trim() } : {}),
    ...(config.cliPath.trim() ? { cliPath: config.cliPath.trim() } : {}),
    ...(config.command.trim() ? { command: config.command.trim() } : {}),
    ...(config.args.length ? { args: config.args } : {}),
    ...(config.selectionId ? { selectionId: config.selectionId } : {}),
  };
}

export function configAfterChoice(config: PanelConfig, choice: { id: string; persistSelection?: boolean }): PanelConfig {
  return choice.persistSelection ? { ...config, selectionId: choice.id } : config;
}

const cancelableSessionPhases = new Set([
  "discovering", "starting", "starting-server", "verifying-url", "starting-impeccable",
]);

export function canCancelSessionStartup(phase: string | undefined): boolean {
  return phase !== undefined && cancelableSessionPhases.has(phase);
}

export function previewAttemptToOpen(
  status: SessionStatus | undefined,
  initiatedAttempt: number | null,
  openedAttempt: number | null,
): number | null {
  if (!status || initiatedAttempt === null || status.attempt !== initiatedAttempt || openedAttempt === status.attempt) return null;
  if (status.phase !== "ready" || !status.development.verified || !status.development.url || !status.session.active) return null;
  return status.attempt;
}

export type PanelView = "idle" | "discovering" | "selection" | "starting" | "connected" | "error";

export function panelView(status: SessionStatus | undefined, inspecting = false): PanelView {
  if (!status) return inspecting ? "discovering" : "idle";
  if (status.phase === "discovering") return "discovering";
  if (canCancelSessionStartup(status.phase) || status.phase === "stopping") return "starting";
  if (status.phase === "error" || status.development.phase === "error" || ["error", "ownership-lost"].includes(status.session.phase)) return "error";
  if (status.development.verified && status.session.active) return "connected";
  if (status.choices.length > 1) return "selection";
  return "idle";
}

export function validatePanelFields(config: PanelConfig): Partial<Record<"appPath" | "url" | "cliPath", string>> {
  const errors: ReturnType<typeof validatePanelFields> = {};
  if (/^(?:[/\\]|[a-z]:)/i.test(config.appPath.trim()) || config.appPath.split(/[/\\]/).includes("..")) {
    errors.appPath = "Use a folder within this workspace, for example frontend.";
  }
  if (config.cliPath.trim() && !/^(?:[/\\]|[a-z]:[/\\])/i.test(config.cliPath.trim())) {
    errors.cliPath = "Use the absolute path to the installed Impeccable executable.";
  }
  if (config.url.trim()) {
    try {
      const url = new URL(config.url.trim());
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error();
    } catch { errors.url = "Use a local HTTP URL, for example http://localhost:5173/."; }
  }
  return errors;
}
