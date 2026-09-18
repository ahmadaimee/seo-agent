import { detectUrlTemplate, canonicalUrlKey } from "./url-utils";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import {
  fetchPagespeedLighthouse,
  resolveLighthouseProvider,
} from "@/server/lib/pagespeed/lighthouse";
import type { LighthouseResult, LighthouseStrategy } from "./types";
import { decodeImageDataUri, putBytesToR2, putTextToR2 } from "@/server/lib/r2";

interface LighthouseSamplePage {
  url: string;
  statusCode: number;
}

function canonicalUrlKeyWithoutTrailingSlash(url: string): string {
  const parsed = new URL(canonicalUrlKey(url));
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
  }
  return parsed.toString();
}

type LighthouseFetchResult = {
  result: LighthouseResult;
  payloadJson: string | null;
  /**
   * The rendered page as a data: URI, kept out of payloadJson so the stored
   * report stays a few KB and the image can go to R2 as a real image.
   */
  screenshotDataUri: string | null;
};

/** A check that produced no payload — provider error, or a failed fetch step. */
export function failedLighthouseFetch(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  errorMessage: string,
): LighthouseFetchResult {
  return {
    result: {
      url,
      pageId,
      strategy,
      performanceScore: null,
      accessibilityScore: null,
      bestPracticesScore: null,
      seoScore: null,
      lcpMs: null,
      cls: null,
      inpMs: null,
      ttfbMs: null,
      errorMessage,
    },
    payloadJson: null,
    screenshotDataUri: null,
  };
}

export async function fetchLighthouseResult(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  billingCustomer: BillingCustomerContext,
): Promise<LighthouseFetchResult> {
  try {
    // A PageSpeed Insights failure is NEVER retried on DataForSEO: falling
    // back would spend credits the operator opted out of. Either provider's
    // failure lands in the catch below and surfaces on the audit row.
    const { screenshot, ...payload } =
      (await resolveLighthouseProvider()) === "pagespeed"
        ? await fetchPagespeedLighthouse({ url, strategy })
        : await createDataforseoClient(billingCustomer).lighthouse.live({
            url,
            strategy,
          });

    return {
      result: {
        url,
        pageId,
        strategy,
        performanceScore: payload.scores.performance,
        accessibilityScore: payload.scores.accessibility,
        bestPracticesScore: payload.scores["best-practices"],
        seoScore: payload.scores.seo,
        lcpMs: payload.metrics.largestContentfulPaint.numericValue,
        cls: payload.metrics.cumulativeLayoutShift.numericValue,
        inpMs: payload.metrics.interactionToNextPaint.numericValue,
        ttfbMs: payload.metrics.serverResponseTime.numericValue,
      },
      payloadJson: JSON.stringify(payload),
      screenshotDataUri: screenshot ?? null,
    };
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    // Lighthouse runtime errors (ERRORED_DOCUMENT_REQUEST, NOT_HTML, NO_FCP) mean the
    // tenant's page didn't load for the provider's Chrome. The failure is already
    // surfaced on the audit row, so there is nothing for us to act on.
    const log = failed.message.includes(
      "Lighthouse encountered an error with the following code",
    )
      ? console.warn
      : console.error;
    log(`Lighthouse failed for ${url} (${strategy}): ${failed.message}`);
    return failedLighthouseFetch(url, pageId, strategy, failed.message);
  }
}

export async function storeLighthouseResult(input: {
  projectId: string;
  auditId: string;
  fetched: LighthouseFetchResult;
}): Promise<LighthouseResult> {
  if (!input.fetched.payloadJson) {
    return input.fetched.result;
  }

  const { pageId, strategy } = input.fetched.result;
  const prefix = `site-audit/${input.projectId}/${input.auditId}/${pageId}-${strategy}`;
  const uploaded = await putTextToR2(
    `${prefix}.json`,
    input.fetched.payloadJson,
  );

  return {
    ...input.fetched.result,
    r2Key: uploaded.key,
    payloadSizeBytes: uploaded.sizeBytes,
    screenshotR2Key: await storeScreenshot(
      prefix,
      input.fetched.screenshotDataUri,
    ),
  };
}

/**
 * Upload the run's screenshot beside its payload. A screenshot is a nice-to-
 * have on a paid check that already succeeded, so an upload failure is logged
 * and dropped rather than failing the step and re-charging the audit.
 */
async function storeScreenshot(
  prefix: string,
  dataUri: string | null,
): Promise<string | null> {
  if (!dataUri) return null;
  const decoded = decodeImageDataUri(dataUri);
  if (!decoded) return null;
  const extension = decoded.contentType === "image/png" ? "png" : "jpg";
  try {
    const uploaded = await putBytesToR2(
      `${prefix}-screenshot.${extension}`,
      decoded.bytes,
      decoded.contentType,
    );
    return uploaded.key;
  } catch (error) {
    console.warn(`Failed to store Lighthouse screenshot for ${prefix}:`, error);
    return null;
  }
}

/**
 * Select which pages to run Lighthouse on, based on the chosen strategy.
 */
export function selectLighthouseSample(
  pages: LighthouseSamplePage[],
  startUrl: string,
  strategy: LighthouseStrategy,
): string[] {
  if (strategy === "none") return [];

  // Only consider pages that loaded successfully
  const validPages = pages.filter(
    (p) => p.statusCode >= 200 && p.statusCode < 300,
  );

  // strategy === "auto": homepage + 1 per URL pattern, capped at 10
  const selected = new Set<string>();

  // Always include the start URL / homepage. Prefer an exact canonical match
  // so distinct 2xx `/path` and `/path/` pages stay distinct, then tolerate a
  // trailing-slash redirect when the exact start URL was not crawled as 2xx.
  const startKey = canonicalUrlKey(startUrl);
  const startPage =
    validPages.find((p) => canonicalUrlKey(p.url) === startKey) ??
    validPages.find(
      (p) =>
        canonicalUrlKeyWithoutTrailingSlash(p.url) ===
        canonicalUrlKeyWithoutTrailingSlash(startUrl),
    );
  if (startPage) selected.add(startPage.url);

  // Group by URL template pattern
  const templateGroups = new Map<string, LighthouseSamplePage>();
  if (startPage) {
    templateGroups.set(
      detectUrlTemplate(new URL(startPage.url).pathname),
      startPage,
    );
  }
  for (const page of validPages) {
    if (selected.has(page.url)) continue;
    const template = detectUrlTemplate(new URL(page.url).pathname);
    if (!templateGroups.has(template)) {
      templateGroups.set(template, page);
    }
  }

  // Add one page per template group
  for (const [, page] of templateGroups) {
    if (selected.size >= 10) break;
    selected.add(page.url);
  }

  return Array.from(selected);
}
