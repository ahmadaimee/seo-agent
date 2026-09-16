/**
 * Pure site-level checks: the files a site is expected to serve at its root
 * (robots.txt, an XML sitemap, a favicon, optionally llms.txt) and the
 * reachability of the social preview images its pages declare.
 *
 * Every function here is a decision over already-fetched results — the probes
 * themselves live in site.ts, mirroring the multipage.ts / multipage-checks.ts
 * split. One issue per finding, anchored to the home page, because these are
 * properties of the site rather than of a page.
 */
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type { PageFavicon } from "@/server/lib/audit/types";

/** Result of a single HEAD/GET probe. */
export interface ResourceProbe {
  /** HTTP status; 0 when the request never completed (timeout, DNS, reset). */
  status: number;
  contentType: string | null;
}

/** The page an issue is attributed to. */
export interface SitePageRef {
  id: string | null;
  url: string;
}

/**
 * Formats Google Search reads a favicon from. SVG is deliberately absent:
 * browsers render it, Google does not, so an SVG-only site gets the generic
 * icon in search results.
 */
const GOOGLE_FAVICON_TYPES = new Set([
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/ico",
  "image/icon",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/tiff",
  "image/x-portable-pixmap",
]);

const GOOGLE_FAVICON_EXTENSIONS = new Set([
  "ico",
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "ppm",
]);

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * A 200 that hands back an HTML document is the classic "SPA catch-all route
 * answers for a missing asset" bug, so it counts as absent. Anything else is
 * accepted: plenty of servers label .ico as application/octet-stream, and
 * rejecting those would invent failures.
 */
function servesNonHtmlResource(probe: ResourceProbe): boolean {
  if (!isOkStatus(probe.status)) return false;
  return !probe.contentType?.toLowerCase().includes("text/html");
}

function fileExtension(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const lastDot = pathname.lastIndexOf(".");
    const lastSlash = pathname.lastIndexOf("/");
    if (lastDot === -1 || lastDot < lastSlash) return null;
    return pathname.slice(lastDot + 1).toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether Google Search can read this icon. Undecidable cases (no type
 * attribute and no extension, e.g. /icon rendered by a route) count as
 * supported — guessing wrong there would invent an issue on a working site.
 */
export function isGoogleReadableFavicon(favicon: PageFavicon): boolean {
  if (favicon.type) return GOOGLE_FAVICON_TYPES.has(favicon.type);
  const extension = fileExtension(favicon.resolvedUrl ?? favicon.href);
  if (!extension) return true;
  return GOOGLE_FAVICON_EXTENSIONS.has(extension);
}

/**
 * The single icon worth spending a request on: the first one Google can
 * actually read, falling back to the first fetchable icon of any format.
 * data: and blob: icons resolve to null and are never probed.
 */
export function pickFaviconToProbe(declared: PageFavicon[]): string | null {
  const fetchable = declared.filter((icon) => icon.resolvedUrl !== null);
  const readable = fetchable.find(isGoogleReadableFavicon);
  return (readable ?? fetchable[0])?.resolvedUrl ?? null;
}

export interface FaviconCheck {
  /** Icons declared in the home page's <head>. */
  declared: PageFavicon[];
  /** Probe of the icon that was tested, or of /favicon.ico when none was. */
  probe: ResourceProbe | null;
  probedUrl: string | null;
}

export interface OgImageCheck {
  imageUrl: string;
  probe: ResourceProbe;
  /** A page that declares this image, for the issue to point at. */
  page: SitePageRef;
  /** How many crawled pages declare it, so one issue can report the blast radius. */
  affectedPages: number;
}

/** Ownership and measurement tags read from the home page's markup. */
export interface SiteTagCheck {
  googleSiteVerification: string | null;
  bingSiteVerification: string | null;
  analyticsIds: string[];
}

export interface SiteCheckInput {
  homepage: SitePageRef;
  /**
   * False when the crawl never got a readable home page (blocked, errored, or
   * redirected off-origin). The tag checks are skipped in that case: absence
   * of evidence in markup nobody could read is not evidence of absence.
   */
  homepageAnalyzed: boolean;
  tags: SiteTagCheck;
  /** HTTP status of /robots.txt; 0 when the request never completed. */
  robotsStatus: number;
  /** Sitemap URLs declared by robots.txt. */
  robotsSitemapUrls: string[];
  /** True when discovery parsed at least one sitemap document. */
  sitemapFound: boolean;
  llmsTxt: ResourceProbe;
  favicon: FaviconCheck;
  ogImages: OgImageCheck[];
}

export function buildSiteIssues(input: SiteCheckInput): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const report = (
    issueType: DetectedIssue["issueType"],
    details?: Record<string, unknown>,
    dedupeKey?: string,
  ) =>
    issues.push({
      issueType,
      pageId: input.homepage.id,
      pageUrl: input.homepage.url,
      details,
      dedupeKey,
    });

  // robots.txt. A 4xx means "no restrictions" and is merely a missed
  // opportunity; a 5xx or a timeout is the one that stops Google crawling.
  if (input.robotsStatus === 0 || input.robotsStatus >= 500) {
    report("robots-txt-unreachable", {
      status: input.robotsStatus === 0 ? "no response" : input.robotsStatus,
    });
  } else if (input.robotsStatus >= 400) {
    report("missing-robots-txt", { status: input.robotsStatus });
  }

  // Sitemap
  if (!input.sitemapFound) {
    report("missing-sitemap");
  } else if (input.robotsSitemapUrls.length === 0) {
    report("sitemap-not-in-robots");
  }

  // llms.txt
  if (!servesNonHtmlResource(input.llmsTxt)) {
    report("missing-llms-txt", { status: input.llmsTxt.status });
  }

  // Ownership and measurement tags. Every one of these can also be installed
  // by a method that leaves nothing in the HTML, so the findings are framed as
  // "not found here", never as "not set up".
  if (input.homepageAnalyzed) {
    if (input.tags.analyticsIds.length === 0) {
      report("missing-analytics-tag");
    }
    if (!input.tags.googleSiteVerification) {
      report("missing-google-site-verification");
    }
    if (!input.tags.bingSiteVerification) {
      report("missing-bing-site-verification");
    }
  }

  issues.push(...buildFaviconIssues(input.homepage, input.favicon));

  for (const image of input.ogImages) {
    if (servesNonHtmlResource(image.probe)) continue;
    issues.push({
      issueType: "broken-og-image",
      pageId: image.page.id,
      pageUrl: image.page.url,
      // One issue per distinct image URL rather than per page: a broken
      // sitewide default would otherwise fill the report with one row per page.
      dedupeKey: image.imageUrl,
      details: {
        ogImage: image.imageUrl,
        status: image.probe.status === 0 ? "no response" : image.probe.status,
        affectedPages: image.affectedPages,
      },
    });
  }

  return issues;
}

function buildFaviconIssues(
  homepage: SitePageRef,
  favicon: FaviconCheck,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const report = (
    issueType: DetectedIssue["issueType"],
    details?: Record<string, unknown>,
  ) =>
    issues.push({ issueType, pageId: homepage.id, pageUrl: homepage.url, details });

  if (favicon.declared.length === 0) {
    // Nothing declared: the browser default of /favicon.ico is the last thing
    // standing between the site and a generic icon.
    if (!favicon.probe || !servesNonHtmlResource(favicon.probe)) {
      report("missing-favicon", { probedUrl: favicon.probedUrl });
    }
    return issues;
  }

  if (favicon.probe && !servesNonHtmlResource(favicon.probe)) {
    report("broken-favicon", {
      faviconUrl: favicon.probedUrl,
      status: favicon.probe.status === 0 ? "no response" : favicon.probe.status,
    });
  }

  if (!favicon.declared.some(isGoogleReadableFavicon)) {
    report("favicon-unsupported-format", {
      declared: favicon.declared
        .map((icon) => icon.type ?? icon.href)
        .slice(0, 5),
    });
  }

  return issues;
}
