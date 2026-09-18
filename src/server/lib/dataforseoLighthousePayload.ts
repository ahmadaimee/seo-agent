import { z } from "zod";
import {
  buildStoredLighthousePayload,
  type LighthouseStrategy,
  rawLighthouseResultSchema,
  type StoredLighthousePayload,
  summarizeZodIssues,
} from "@/server/lib/lighthouseStoredPayload";

export type { LighthouseStrategy };

export const requestCategories = [
  "performance",
  "accessibility",
  "best_practices",
  "seo",
] as const;

const dataforseoTaskSchema = z.object({
  id: z.string().optional(),
  cost: z.number().optional(),
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  result: z.array(rawLighthouseResultSchema).optional(),
});

const dataforseoLighthouseResponseSchema = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z.array(dataforseoTaskSchema).optional(),
});

/**
 * Unwrap the DataForSEO envelope and hand the raw Lighthouse report to the
 * provider-neutral builder. Only the envelope handling lives here; the report
 * itself is identical to what PageSpeed Insights returns.
 */
export function parseDataforseoLighthousePayload(
  payload: unknown,
  input: { url: string; strategy: LighthouseStrategy },
): StoredLighthousePayload {
  const parsed = dataforseoLighthouseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `DataForSEO Lighthouse returned an invalid response: ${summarizeZodIssues(parsed.error)}`,
    );
  }

  if (parsed.data.status_code !== 20000) {
    throw new Error(
      parsed.data.status_message ?? "DataForSEO Lighthouse request failed",
    );
  }

  const task = parsed.data.tasks?.[0];
  if (!task) {
    throw new Error("DataForSEO Lighthouse response missing task");
  }

  if (task.status_code !== 20000) {
    throw new Error(task.status_message ?? "DataForSEO Lighthouse task failed");
  }

  const result = task.result?.[0];
  if (!result) {
    throw new Error("DataForSEO Lighthouse response missing result");
  }

  return buildStoredLighthousePayload({
    source: "dataforseo-lighthouse",
    providerLabel: "DataForSEO Lighthouse",
    result,
    url: input.url,
    strategy: input.strategy,
    taskId: task.id ?? null,
    cost: task.cost ?? null,
  });
}
