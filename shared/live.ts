import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const liveStatusSchema = z.object({
  active: z.boolean(),
  phase: z.string(),
  message: z.string(),
  appRoot: z.string().nullable(),
  url: z.string().nullable(),
  agentId: z.string().nullable(),
  pendingEvent: z.string().nullable(),
});

export const liveBindingSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
});

export const developmentOverridesSchema = z.object({
  appPath: z.string().max(4096).optional(),
  url: z.string().max(8192).optional(),
  cliPath: z.string().max(4096).optional(),
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  selectionId: z.string().max(256).optional(),
});

export const choiceSchema = z.object({
  id: z.string(), label: z.string(), detail: z.string(), persistSelection: z.boolean().optional(),
  kind: z.enum(["target", "reuse", "launch", "preview"]).optional(),
  associated: z.boolean().optional(), recommended: z.boolean().optional(),
});
export const developmentStatusSchema = z.object({
  phase: z.enum(["stopped", "discovering", "selection-required", "starting", "verifying", "ready", "error", "stopping"]),
  ownership: z.enum(["none", "owned", "external"]),
  appRoot: z.string().nullable(),
  previewRoot: z.string().nullable().optional(),
  command: z.string().nullable(),
  url: z.string().nullable(),
  verified: z.boolean(),
  pid: z.number().nullable(),
  message: z.string(),
});
export const dependencyCheckSchema = z.object({
  id: z.enum(["installation", "engine", "compatibility", "project", "helper"]),
  status: z.enum(["ready", "blocked", "warning"]),
  message: z.string(),
  detail: z.string().optional(),
});
export const dependencyReadinessSchema = z.object({
  cliPath: z.string().nullable(),
  selectedCliPath: z.string().nullable().optional(),
  engineVersion: z.string().nullable(),
  appRoot: z.string(),
  checks: z.array(dependencyCheckSchema),
});
export type DependencyReadiness = z.infer<typeof dependencyReadinessSchema>;

export const updateStatusSchema = z.object({
  status: z.enum(["available", "current", "unknown", "disabled", "unavailable"]),
  installedVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
});
export const checkUpdatesRpc = defineRpc({
  name: "impeccable-live.check-updates",
  input: liveBindingSchema.extend({
    force: z.boolean().optional(), attempt: z.number().int(),
    cliPath: z.string().nullable(), appRoot: z.string(),
  }),
  output: updateStatusSchema,
});

export const quickUpdateGuidanceSchema = z.object({
  status: z.literal("guidance"), selectedPath: z.string(), reason: z.string(),
});
export const quickUpdatePlanSchema = z.object({
  status: z.literal("eligible"), planId: z.string(), scope: z.enum(["personal", "project"]), scopeLabel: z.string(),
  selectedPath: z.string(), workingDirectory: z.string(),
  affectedInstallations: z.array(z.object({ provider: z.string(), path: z.string(), version: z.string() })),
  targetSkillVersion: z.string(), updaterVersion: z.string(),
});
export const quickUpdatePreparationSchema = z.discriminatedUnion("status", [quickUpdateGuidanceSchema, quickUpdatePlanSchema]);
export type QuickUpdatePlan = z.infer<typeof quickUpdatePlanSchema>;
export const prepareQuickUpdateRpc = defineRpc({
  name: "impeccable-live.prepare-update",
  input: liveBindingSchema.extend({
    attempt: z.number().int(), cliPath: z.string(), selectedCliPath: z.string(), appRoot: z.string(), targetSkillVersion: z.string(),
  }),
  output: quickUpdatePreparationSchema,
});
export const quickUpdateResultSchema = z.object({
  status: z.literal("succeeded"), installedVersion: z.string(), engineVersion: z.string(), output: z.string(), instruction: z.string(),
});
export const applyQuickUpdateRpc = defineRpc({
  name: "impeccable-live.apply-update",
  input: liveBindingSchema.extend({
    attempt: z.number().int(), cliPath: z.string(), selectedCliPath: z.string(), appRoot: z.string(),
    planId: z.string(), scope: z.enum(["personal", "project"]), targetSkillVersion: z.string(), updaterVersion: z.string(),
  }),
  output: quickUpdateResultSchema,
});

export const updateOperationSchema = z.object({
  phase: z.enum(["idle", "running", "succeeded", "failed"]),
  message: z.string(), output: z.string().optional(), instruction: z.string().optional(),
});

export const sessionStatusSchema = z.object({
  attempt: z.number().int(),
  phase: z.string(),
  message: z.string(),
  helperReadinessError: z.string().nullable().optional(),
  dependencyReadiness: dependencyReadinessSchema.nullable().optional(),
  updateOperation: updateOperationSchema.optional(),
  choices: z.array(choiceSchema),
  development: developmentStatusSchema,
  session: liveStatusSchema,
});

export const startRpc = defineRpc({
  name: "impeccable-live.start",
  input: liveBindingSchema.extend(developmentOverridesSchema.shape),
  output: sessionStatusSchema,
});

export const inspectRpc = defineRpc({
  name: "impeccable-live.inspect",
  input: liveBindingSchema.extend(developmentOverridesSchema.shape),
  output: sessionStatusSchema,
});

export const statusRpc = defineRpc({
  name: "impeccable-live.status",
  input: liveBindingSchema,
  output: sessionStatusSchema,
});

export const stopRpc = defineRpc({
  name: "impeccable-live.stop",
  input: liveBindingSchema,
  output: sessionStatusSchema,
});

export const retryRpc = defineRpc({
  name: "impeccable-live.retry",
  input: liveBindingSchema,
  output: sessionStatusSchema,
});

export const selectRpc = defineRpc({
  name: "impeccable-live.select",
  input: liveBindingSchema.extend({ attempt: z.number().int(), selectionId: z.string().max(8192) }),
  output: sessionStatusSchema,
});
export const stopDevServerRpc = defineRpc({
  name: "impeccable-live.stop-development",
  input: liveBindingSchema,
  output: sessionStatusSchema,
});
export const devLogsRpc = defineRpc({
  name: "impeccable-live.logs",
  input: liveBindingSchema.extend({ cursor: z.number().int().nonnegative().optional() }),
  output: z.object({
    lines: z.array(z.object({ sequence: z.number(), attempt: z.number().int(), source: z.enum(["stdout", "stderr", "system"]), text: z.string(), time: z.string() })),
    cursor: z.number(), attempt: z.number().int(), reset: z.boolean(), truncated: z.boolean(), available: z.boolean(),
  }),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type DevelopmentStatus = z.infer<typeof developmentStatusSchema>;
export type DevelopmentOverrides = z.infer<typeof developmentOverridesSchema>;
