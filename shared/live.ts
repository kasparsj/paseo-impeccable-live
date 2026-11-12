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
  engineVersion: z.string().nullable(),
  appRoot: z.string(),
  checks: z.array(dependencyCheckSchema),
});
export type DependencyReadiness = z.infer<typeof dependencyReadinessSchema>;

export const sessionStatusSchema = z.object({
  attempt: z.number().int(),
  phase: z.string(),
  message: z.string(),
  helperReadinessError: z.string().nullable().optional(),
  dependencyReadiness: dependencyReadinessSchema.nullable().optional(),
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
