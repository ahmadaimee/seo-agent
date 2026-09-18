import { z } from "zod";
import { LIGHTHOUSE_CATEGORIES } from "@/shared/lighthouse";

type RawLighthouseAudit = {
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: {
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    /** Newer "insight" audits report a single object instead of a list. */
    items?: Array<Record<string, unknown>> | Record<string, unknown>;
    /** Screenshot audits carry the image inline as a data: URI. */
    data?: unknown;
  };
};

type RawLighthouseCategory = {
  score?: number | null;
  auditRefs?: Array<{
    id?: string;
  }>;
};

const storedLighthouseMetricSchema = z.object({
  score: z.number().nullable(),
  displayValue: z.string().nullable(),
  numericValue: z.number().nullable(),
});

const storedLighthouseMetricsSchema = z.object({
  firstContentfulPaint: storedLighthouseMetricSchema,
  largestContentfulPaint: storedLighthouseMetricSchema,
  totalBlockingTime: storedLighthouseMetricSchema,
  cumulativeLayoutShift: storedLighthouseMetricSchema,
  speedIndex: storedLighthouseMetricSchema,
  timeToInteractive: storedLighthouseMetricSchema,
  interactionToNextPaint: storedLighthouseMetricSchema,
  serverResponseTime: storedLighthouseMetricSchema,
});

const storedLighthouseIssueSchema = z.object({
  category: z.enum(LIGHTHOUSE_CATEGORIES),
  auditKey: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number().nullable(),
  scoreDisplayMode: z.string().nullable(),
  displayValue: z.string().nullable(),
  impactMs: z.number().nullable(),
  impactBytes: z.number().nullable(),
  severity: z.enum(["critical", "warning", "info"]),
  items: z.array(z.string()),
});

export const storedLighthousePayloadSchema = z.object({
  version: z.literal(2),
  // Which provider ran Lighthouse. Both resell/return the same raw report, so
  // the stored shape is identical; the tag only records provenance (and cost,
  // which is always null on the free PageSpeed Insights path).
  source: z.enum(["dataforseo-lighthouse", "pagespeed-lighthouse"]),
  hasIssueDetails: z.boolean(),
  metadata: z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    strategy: z.enum(["mobile", "desktop"]),
    fetchedAt: z.string(),
    lighthouseVersion: z.string().nullable(),
    taskId: z.string().nullable(),
    cost: z.number().nullable(),
  }),
  scores: z.object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    "best-practices": z.number().nullable(),
    seo: z.number().nullable(),
  }),
  metrics: storedLighthouseMetricsSchema,
  issues: z.array(storedLighthouseIssueSchema),
  /**
   * Transient: the final screenshot as a data: URI, carried from the parser to
   * the persistence step, which uploads it to R2 as a binary object and strips
   * it before the payload is stored. Optional so a payload read back from R2
   * (which never contains it) still validates.
   */
  screenshot: z.string().nullable().optional(),
});

type StoredLighthouseMetric = z.infer<typeof storedLighthouseMetricSchema>;
type StoredLighthouseMetrics = z.infer<typeof storedLighthouseMetricsSchema>;
export type StoredLighthouseIssue = z.infer<typeof storedLighthouseIssueSchema>;
export type StoredLighthousePayload = z.infer<
  typeof storedLighthousePayloadSchema
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreToPercent(score: number | null | undefined): number | null {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return Math.round(score * 100);
}

function buildStoredMetric(
  audit: RawLighthouseAudit | undefined,
): StoredLighthouseMetric {
  return {
    score: scoreToPercent(audit?.score),
    displayValue: audit?.displayValue ?? null,
    numericValue:
      typeof audit?.numericValue === "number" ? audit.numericValue : null,
  };
}

const DIAGNOSTIC_AUDIT_KEYS = new Set([
  "largest-contentful-paint-element",
  "layout-shifts",
  "diagnostics",
  "metrics",
  "network-requests",
  "network-rtt",
  "network-server-latency",
  "main-thread-tasks",
  "screenshot-thumbnails",
  "final-screenshot",
  "script-treemap-data",
  "resource-summary",
]);

function compactItem(item: Record<string, unknown>): string {
  const preferredKeys = [
    "url",
    "source",
    "nodeLabel",
    "snippet",
    "totalBytes",
    "wastedBytes",
    "wastedMs",
    "label",
    "value",
  ];

  const output: Record<string, unknown> = {};
  for (const key of preferredKeys) {
    if (item[key] != null) {
      output[key] = item[key];
    }
  }

  if (Object.keys(output).length === 0) {
    for (const [key, value] of Object.entries(item).slice(0, 6)) {
      output[key] = value;
    }
  }

  return JSON.stringify(output);
}

function getSeverity(input: {
  score: number | null;
  impactMs: number | null;
  impactBytes: number | null;
}): "critical" | "warning" | "info" {
  if ((input.impactMs ?? 0) >= 300 || (input.impactBytes ?? 0) >= 150_000) {
    return "critical";
  }

  if (input.score != null && input.score < 50) {
    return "critical";
  }

  if ((input.impactMs ?? 0) >= 100 || (input.impactBytes ?? 0) >= 50_000) {
    return "warning";
  }

  if (input.score != null && input.score < 90) {
    return "warning";
  }

  return "info";
}

export function buildStoredLighthouseIssues(input: {
  audits: Record<string, RawLighthouseAudit>;
  categories: Record<string, RawLighthouseCategory>;
}) {
  const hasIssueDetails = LIGHTHOUSE_CATEGORIES.some(
    (category) => (input.categories[category]?.auditRefs?.length ?? 0) > 0,
  );

  const issues: StoredLighthouseIssue[] = [];

  for (const category of LIGHTHOUSE_CATEGORIES) {
    const rawRefs = input.categories[category]?.auditRefs;
    const refs = Array.isArray(rawRefs) ? rawRefs : [];
    for (const ref of refs) {
      const auditKey = ref?.id;
      if (!auditKey) continue;

      const audit = input.audits[auditKey];
      if (!audit) continue;

      const score = scoreToPercent(audit.score);
      const scoreDisplayMode = audit.scoreDisplayMode ?? null;

      if (scoreDisplayMode === "numeric") continue;
      if (DIAGNOSTIC_AUDIT_KEYS.has(auditKey)) continue;

      const isPass =
        score == null ||
        score >= 90 ||
        scoreDisplayMode === "notApplicable" ||
        scoreDisplayMode === "informative" ||
        scoreDisplayMode === "manual" ||
        scoreDisplayMode === "error";

      if (isPass) continue;

      const impactMs =
        typeof audit.details?.overallSavingsMs === "number"
          ? audit.details.overallSavingsMs
          : null;
      const impactBytes =
        typeof audit.details?.overallSavingsBytes === "number"
          ? audit.details.overallSavingsBytes
          : null;
      const rawItems = audit.details?.items;
      const itemList = Array.isArray(rawItems)
        ? rawItems
        : isRecord(rawItems)
          ? [rawItems]
          : [];
      const items = itemList.filter(isRecord).slice(0, 10).map(compactItem);

      issues.push({
        category,
        auditKey,
        title: audit.title ?? auditKey,
        description: audit.description ?? "",
        score,
        scoreDisplayMode,
        displayValue: audit.displayValue ?? null,
        impactMs,
        impactBytes,
        severity: getSeverity({ score, impactMs, impactBytes }),
        items,
      });
    }
  }

  return {
    hasIssueDetails,
    issues,
  };
}

/**
 * Upper bound on the screenshot data URI we accept. A Lighthouse final
 * screenshot is a ~50-200 KB JPEG; anything past this is a malformed or
 * hostile payload and is dropped rather than carried through the audit
 * worker's memory and into R2.
 */
const MAX_SCREENSHOT_DATA_URI_BYTES = 4 * 1024 * 1024;

/**
 * The page as the provider's Chrome finally rendered it, as a data: URI.
 * Lighthouse ships it under the hidden "final-screenshot" audit of the
 * performance category; null when the run produced none (a failed load, or a
 * provider that strips it).
 */
function extractLighthouseScreenshot(
  audits: Record<string, RawLighthouseAudit>,
): string | null {
  const data = audits["final-screenshot"]?.details?.data;
  if (typeof data !== "string") return null;
  if (!data.startsWith("data:image/")) return null;
  if (data.length > MAX_SCREENSHOT_DATA_URI_BYTES) return null;
  return data;
}

export function buildStoredLighthouseMetrics(input: {
  audits: Record<string, RawLighthouseAudit>;
}): StoredLighthouseMetrics {
  return {
    firstContentfulPaint: buildStoredMetric(
      input.audits["first-contentful-paint"],
    ),
    largestContentfulPaint: buildStoredMetric(
      input.audits["largest-contentful-paint"],
    ),
    totalBlockingTime: buildStoredMetric(input.audits["total-blocking-time"]),
    cumulativeLayoutShift: buildStoredMetric(
      input.audits["cumulative-layout-shift"],
    ),
    speedIndex: buildStoredMetric(input.audits["speed-index"]),
    timeToInteractive: buildStoredMetric(input.audits.interactive),
    interactionToNextPaint: buildStoredMetric(
      input.audits["interaction-to-next-paint"],
    ),
    serverResponseTime: buildStoredMetric(input.audits["server-response-time"]),
  };
}

export type LighthouseStrategy = "mobile" | "desktop";

/**
 * A raw Lighthouse report, as every provider returns it: DataForSEO nests it
 * under `tasks[].result[]`, PageSpeed Insights v5 under `lighthouseResult`.
 * Only the envelope scalars are validated — the multi-MB category/audit bodies
 * stay as the provider's own objects, because deep-parsing them cloned the
 * whole report a second time and pushed the audit worker over its memory limit.
 */
export const rawLighthouseResultSchema = z.object({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  lighthouseVersion: z.string().optional(),
  categories: z
    .record(z.string(), z.custom<RawLighthouseCategory>())
    .optional(),
  audits: z.record(z.string(), z.custom<RawLighthouseAudit>()).optional(),
});

type RawLighthouseResult = z.infer<typeof rawLighthouseResultSchema>;

export function summarizeZodIssues(error: z.ZodError, maxIssues = 3): string {
  return error.issues
    .slice(0, maxIssues)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Reduce a raw Lighthouse report into the compact stored payload, then
 * validate that in full — the same fields the old whole-report schema checked,
 * at kilobyte size instead of multi-megabyte. Provider-neutral: callers unwrap
 * their own envelope first and pass the report in.
 */
export function buildStoredLighthousePayload(input: {
  source: StoredLighthousePayload["source"];
  /** Provider name used in error messages, e.g. "DataForSEO Lighthouse". */
  providerLabel: string;
  result: RawLighthouseResult;
  url: string;
  strategy: LighthouseStrategy;
  taskId: string | null;
  cost: number | null;
}): StoredLighthousePayload {
  const { result } = input;
  const categories = result.categories ?? {};
  const audits = result.audits ?? {};
  const issueReport = buildStoredLighthouseIssues({ audits, categories });
  const storedPayload: StoredLighthousePayload = {
    version: 2,
    source: input.source,
    hasIssueDetails: issueReport.hasIssueDetails,
    metadata: {
      requestedUrl: result.requestedUrl ?? input.url,
      finalUrl: result.finalUrl ?? input.url,
      strategy: input.strategy,
      fetchedAt: new Date().toISOString(),
      lighthouseVersion: result.lighthouseVersion ?? null,
      taskId: input.taskId,
      cost: input.cost,
    },
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      "best-practices": scoreToPercent(categories["best-practices"]?.score),
      seo: scoreToPercent(categories.seo?.score),
    },
    metrics: buildStoredLighthouseMetrics({ audits }),
    issues: issueReport.issues,
    screenshot: extractLighthouseScreenshot(audits),
  };

  const allScoresMissing = Object.values(storedPayload.scores).every(
    (score) => score == null,
  );
  if (allScoresMissing) {
    throw new Error(
      `${input.providerLabel} returned no category scores for ${storedPayload.metadata.finalUrl}`,
    );
  }

  // Without this, an off-spec provider field (a numeric audit title, say) would
  // be stored and then fail to parse on read, silently blanking the page's
  // whole Lighthouse view instead of failing the check.
  const validated = storedLighthousePayloadSchema.safeParse(storedPayload);
  if (!validated.success) {
    throw new Error(
      `${input.providerLabel} returned an invalid report: ${summarizeZodIssues(validated.error)}`,
    );
  }

  return storedPayload;
}
