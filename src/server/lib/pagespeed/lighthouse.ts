import { z } from "zod";
import {
  buildStoredLighthousePayload,
  type LighthouseStrategy,
  rawLighthouseResultSchema,
  type StoredLighthousePayload,
  summarizeZodIssues,
} from "@/server/lib/lighthouseStoredPayload";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

const PAGESPEED_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * PageSpeed Insights runs Lighthouse on Google's own infrastructure and
 * routinely takes 20-60s for one URL — noticeably slower than DataForSEO's
 * resold run. The ceiling is generous on purpose: aborting early wastes the
 * whole run and shows the audit row a timeout instead of a score.
 */
const REQUEST_TIMEOUT_MS = 120_000;

const PAGESPEED_CATEGORIES = [
  "PERFORMANCE",
  "ACCESSIBILITY",
  "BEST_PRACTICES",
  "SEO",
] as const;

// One payload read+parse at a time per isolate, mirroring the DataForSEO
// client. This module runs in the seo-agent-audit worker, and a raw Lighthouse
// payload (1-10MB, held several times over while parsing) is the operation
// that OOMed the main worker; PSI payloads are just as large. The PSI fetches
// themselves stay concurrent — parsing (well under a second each) is cheap
// against a 20-60s fetch, and workerd streams un-read response bodies, so
// queued siblings don't buffer.
let parseChain: Promise<unknown> = Promise.resolve();
function withParseLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = parseChain.then(fn, fn);
  parseChain = run.catch(() => {});
  return run;
}

const pagespeedResponseSchema = z.object({
  lighthouseResult: rawLighthouseResultSchema.optional(),
});

const pagespeedErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
});

type LighthouseProvider = "pagespeed" | "dataforseo";

/**
 * Which provider runs Lighthouse for site audits.
 *
 * `LIGHTHOUSE_PROVIDER` wins when set. Otherwise PageSpeed Insights is used
 * only when `PAGESPEED_API_KEY` is present, so an existing deployment keeps
 * its DataForSEO behaviour until it opts in.
 */
export async function resolveLighthouseProvider(): Promise<LighthouseProvider> {
  const configured = (await getOptionalEnvValue("LIGHTHOUSE_PROVIDER"))?.trim();
  if (configured === "pagespeed" || configured === "dataforseo") {
    return configured;
  }
  return (await getOptionalEnvValue("PAGESPEED_API_KEY"))
    ? "pagespeed"
    : "dataforseo";
}

function buildRequestUrl(input: {
  url: string;
  strategy: LighthouseStrategy;
  apiKey: string | undefined;
}): string {
  const requestUrl = new URL(PAGESPEED_ENDPOINT);
  requestUrl.searchParams.set("url", input.url);
  requestUrl.searchParams.set("strategy", input.strategy);
  for (const category of PAGESPEED_CATEGORIES) {
    requestUrl.searchParams.append("category", category);
  }
  if (input.apiKey) {
    requestUrl.searchParams.set("key", input.apiKey);
  }
  return requestUrl.toString();
}

/**
 * Run Lighthouse through Google's free PageSpeed Insights v5 API.
 *
 * Unbilled and un-metered: there is deliberately no fallback to DataForSEO on
 * failure. A failure here must surface on the audit row (the caller turns it
 * into `failedLighthouseFetch`), never into a paid retry.
 */
export async function fetchPagespeedLighthouse(input: {
  url: string;
  strategy: LighthouseStrategy;
}): Promise<StoredLighthousePayload> {
  const apiKey = await getOptionalEnvValue("PAGESPEED_API_KEY");

  // The response is taken un-consumed so the multi-MB body read happens inside
  // the parse lock, and the timeout is cleared once headers arrive — an armed
  // signal would otherwise cover a body read queued behind the lock and abort
  // a run that already completed.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      buildRequestUrl({ url: input.url, strategy: input.strategy, apiKey }),
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PageSpeed Insights request failed for ${input.url}: ${message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    if (response.status === 429) {
      throw new Error(
        `PageSpeed Insights rate limit exceeded (HTTP 429)${
          apiKey ? "" : " — set PAGESPEED_API_KEY to raise the quota"
        }${detail ? `: ${detail}` : ""}`,
      );
    }
    throw new Error(
      `PageSpeed Insights returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return withParseLock(async () => {
    const body: unknown = await response.json();
    const parsed = pagespeedResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `PageSpeed Insights returned an invalid response: ${summarizeZodIssues(parsed.error)}`,
      );
    }

    const result = parsed.data.lighthouseResult;
    if (!result) {
      throw new Error("PageSpeed Insights response missing lighthouseResult");
    }

    return buildStoredLighthousePayload({
      source: "pagespeed-lighthouse",
      providerLabel: "PageSpeed Insights",
      result,
      url: input.url,
      strategy: input.strategy,
      taskId: null,
      // Always free — nothing to meter, and the stored payload says so.
      cost: null,
    });
  });
}

/** Google's error envelope, best-effort — never let it mask the status code. */
async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const parsed = pagespeedErrorSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const error = parsed.data.error;
    if (!error) return null;
    return error.message ?? error.status ?? null;
  } catch {
    return null;
  }
}
