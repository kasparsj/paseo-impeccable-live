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

export const startRpc = defineRpc({
  name: "impeccable-live.start",
  input: liveBindingSchema.extend({
    appPath: z.string(),
    url: z.string(),
    cliPath: z.string().optional(),
  }),
  output: liveStatusSchema,
});

export const statusRpc = defineRpc({
  name: "impeccable-live.status",
  input: liveBindingSchema,
  output: liveStatusSchema,
});

export const stopRpc = defineRpc({
  name: "impeccable-live.stop",
  input: liveBindingSchema,
  output: liveStatusSchema,
});

export const retryRpc = defineRpc({
  name: "impeccable-live.retry",
  input: liveBindingSchema,
  output: liveStatusSchema,
});
