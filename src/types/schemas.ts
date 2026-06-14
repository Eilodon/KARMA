import { z } from "zod/v4";

const PhaseSchema = z.enum(["intake", "execution", "review", "completed"]);

export const BaseLogEntrySchema = z.object({
  when: z.string(),
  action: z.string(),
  note: z.string().default(""),
});

export const BaseStateSchema = z.object({
  version: z.string(),
  tenantId: z.string(),
  revision: z.number().int().nonnegative().default(0),
  phase: PhaseSchema,
  logs: z.object({
    decisions: z.array(BaseLogEntrySchema).default([]),
  }).default({ decisions: [] }),
  createdAt: z.string(),
  updatedAt: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type BaseState<T = Record<string, unknown>> = Omit<z.infer<typeof BaseStateSchema>, "payload"> & {
  payload: T;
};
export type Phase = z.infer<typeof PhaseSchema>;
