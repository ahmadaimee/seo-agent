/**
 * Site-level checks that need IO: probe the files a site is expected to serve
 * at its root, and verify the social preview images its pages declare.
 *
 * The decisions live in site-checks.ts; this module only gathers evidence,
 * mirroring the multipage.ts / multipage-checks.ts split. Every request here
 * is a read, so the whole step is safe to replay after a Workflow retry.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditPages } from "@/db/schema";
import { parseRobotsTxt } from "@/server/lib/audit/discovery";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import {
  buildSiteIssues,
  pickFaviconToProbe,
  type OgImageCheck,
  type ResourceProbe,
  type SitePageRef,
  type SiteTagCheck,
} from "@/server/lib/audit/issues/site-checks";
import type { PageFavicon } from "@/server/lib/audit/types";
import { canonicalUrlKey } from "@/server/lib/audit/url-utils";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_USER_AGENT = "SEOAgent-Audit/1.0";
/**
 * Distinct og:image URLs to verify. Sites overwhelmingly reuse one sitewide
 * default plus a handful of per-template images, so this covers the real
 * variety without turning a 500-page audit into 500 extra requests.
 */
const MAX_OG_IMAGE_PROBES = 25;
const OG_IMAGE_PROBE_CONCURRENCY = 5;

const faviconsSchema = z.array(
  z.object({
    rel: z.string(),
    href: z.string(),
    resolvedUrl: z.string().nullable(),
    sizes: z.string().nullable(),
    type: z.string().nullable(),
  }),
);

/**
 * One probe. Uses a ranged GET rather than HEAD: HEAD is rejected or
 * mishandled by enough CDNs and image hosts that it would report working
 * images as broken. The body is cancelled as soon as the headers arrive.
 */
async function probe(url: string): Promise<ResourceProbe> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": PROBE_USER_AGENT,
        // Ask for the first byte only; servers that ignore Range answer 200
        // with a full body, which the cancel below discards unread.
        Range: "bytes=0-0",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return {
      // 206 Partial Content is the success case for a ranged request; map it
      // onto 200 so callers only ever reason about "2xx or not".
      status: response.status === 206 ? 200 : response.status,
      contentType: response.headers.get("content-type"),
    };
  } catch {
    return { status: 0, contentType: null };
  }
}

/** Run probes in small waves so a wide audit cannot open dozens of sockets. */
async function probeAll<T>(
  items: T[],
  urlOf: (item: T) => string,
  concurrency: number,
): Promise<Array<{ item: T; probe: ResourceProbe }>> {
  const results: Array<{ item: T; probe: ResourceProbe }> = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const wave = items.slice(i, i + concurrency);
    results.push(
      ...(await Promise.all(
        wave.map(async (item) => ({ item, probe: await probe(urlOf(item)) })),
      )),
    );
  }
  return results;
}

function parseFavicons(raw: string | null): PageFavicon[] {
  if (!raw) return [];
  try {
    const parsed = faviconsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseAnalyticsIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * The crawled row for the audit's start URL. Site-level findings are attributed
 * to it, and its <head> is where the favicon declaration is read from. Matched
 * on the canonical key so a start URL that resolved through a trailing-slash or
 * www redirect still finds its page.
 */
async function findHomepage(
  auditId: string,
  startUrl: string,
): Promise<{
  ref: SitePageRef;
  analyzed: boolean;
  favicons: PageFavicon[];
  tags: SiteTagCheck;
}> {
  const rows = await db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      faviconsJson: auditPages.faviconsJson,
      googleSiteVerification: auditPages.googleSiteVerification,
      bingSiteVerification: auditPages.bingSiteVerification,
      analyticsIdsJson: auditPages.analyticsIdsJson,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));

  const startKey = canonicalUrlKey(startUrl);
  const candidates = rows.filter(
    (row) => canonicalUrlKey(row.url) === startKey,
  );
  const served = candidates.find(
    (row) =>
      row.fetchClass === "ok" &&
      row.statusCode !== null &&
      row.statusCode >= 200 &&
      row.statusCode < 300,
  );
  const match = served ?? candidates[0];

  // A crawl that never reached the start URL (blocked, redirected off-origin)
  // still gets site-level findings; they just carry no page id.
  return {
    ref: { id: match?.id ?? null, url: match?.url ?? startUrl },
    analyzed: served !== undefined,
    favicons: parseFavicons(match?.faviconsJson ?? null),
    tags: {
      googleSiteVerification: served?.googleSiteVerification ?? null,
      bingSiteVerification: served?.bingSiteVerification ?? null,
      analyticsIds: parseAnalyticsIds(served?.analyticsIdsJson ?? null),
    },
  };
}

/** Distinct og:image URLs across the audit, most-used first. */
async function findOgImages(
  auditId: string,
): Promise<
  Array<{ imageUrl: string; page: SitePageRef; affectedPages: number }>
> {
  const rows = await db
    .select({
      imageUrl: auditPages.ogImageUrl,
      pageCount: sql<number>`count(*)`.as("page_count"),
      pageId: sql<string>`min(${auditPages.id})`.as("page_id"),
      pageUrl: sql<string>`min(${auditPages.url})`.as("page_url"),
    })
    .from(auditPages)
    .where(
      and(eq(auditPages.auditId, auditId), isNotNull(auditPages.ogImageUrl)),
    )
    .groupBy(auditPages.ogImageUrl)
    .orderBy(sql`page_count desc`)
    .limit(MAX_OG_IMAGE_PROBES);

  return rows.flatMap((row) =>
    row.imageUrl
      ? [
          {
            imageUrl: row.imageUrl,
            page: { id: row.pageId, url: row.pageUrl },
            affectedPages: Number(row.pageCount),
          },
        ]
      : [],
  );
}

export async function runSiteChecks(input: {
  auditId: string;
  origin: string;
  startUrl: string;
  /** robots.txt body from discovery, or null when it was missing/unreachable. */
  robotsText: string | null;
  /** HTTP status discovery saw for /robots.txt; 0 when it never answered. */
  robotsStatus: number;
  /** Whether discovery parsed at least one sitemap document. */
  sitemapFound: boolean;
}): Promise<DetectedIssue[]> {
  const { auditId, origin, startUrl, robotsText, robotsStatus, sitemapFound } =
    input;

  const [homepage, ogImages] = await Promise.all([
    findHomepage(auditId, startUrl),
    findOgImages(auditId),
  ]);

  // Only one favicon is worth a request: the one Google would read. With none
  // declared, probe the implicit /favicon.ico every browser falls back to.
  const declaredFaviconUrl = pickFaviconToProbe(homepage.favicons);
  const faviconUrl =
    homepage.favicons.length === 0
      ? `${origin}/favicon.ico`
      : declaredFaviconUrl;

  const [llmsTxt, faviconProbe, ogImageProbes] = await Promise.all([
    probe(`${origin}/llms.txt`),
    faviconUrl ? probe(faviconUrl) : Promise.resolve(null),
    probeAll(ogImages, (image) => image.imageUrl, OG_IMAGE_PROBE_CONCURRENCY),
  ]);

  return buildSiteIssues({
    homepage: homepage.ref,
    homepageAnalyzed: homepage.analyzed,
    tags: homepage.tags,
    robotsStatus,
    // Re-parsed from the checkpointed text so a replay sees the exact
    // directives the original run did.
    robotsSitemapUrls: parseRobotsTxt(origin, robotsText).sitemapUrls,
    sitemapFound,
    llmsTxt,
    favicon: {
      declared: homepage.favicons,
      probe: faviconProbe,
      probedUrl: faviconUrl,
    },
    ogImages: ogImageProbes.map(
      ({ item, probe: imageProbe }): OgImageCheck => ({
        imageUrl: item.imageUrl,
        probe: imageProbe,
        page: item.page,
        affectedPages: item.affectedPages,
      }),
    ),
  });
}
