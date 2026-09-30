import type { CrawledPageResult, PageLink } from "@/server/lib/audit/types";

/** A healthy internal link, so link-based checks stay quiet by default. */
export const HEALTHY_LINK: PageLink = {
  targetUrl: "https://example.com/catalog",
  anchor: "Catalog",
  isInternal: true,
  isNofollow: false,
};

/**
 * A crawled page that is healthy on every axis, so a test only has to override
 * the one field it exercises. The defaults are deliberately "sound" (a real
 * og:image, structured data, breadcrumbs) so unrelated reporters stay silent
 * and do not drown the assertion under test.
 */
export function makePage(
  overrides: Partial<CrawledPageResult>,
): CrawledPageResult {
  return {
    id: "page-1",
    url: "https://example.com/a",
    statusCode: 200,
    fetchClass: "ok",
    redirectUrl: null,
    title: "A perfectly reasonable page title",
    metaDescription:
      "A reasonable meta description that says something useful about the page.",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: "https://example.com/og.png",
    ogImageUrl: "https://example.com/og.png",
    ogImageAlt: null,
    ogImageWidth: null,
    ogImageHeight: null,
    twitterImage: null,
    favicons: [],
    googleSiteVerification: null,
    bingSiteVerification: null,
    analyticsIds: [],
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1, 2, 3],
    wordCount: 500,
    contentHash: "abc123",
    isHtml: true,
    htmlBytes: 10_000,
    rateLimited: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [HEALTHY_LINK],
    hasStructuredData: true,
    hasBreadcrumbList: true,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 200,
    crawlDepth: 1,
    inSitemap: true,
    ...overrides,
  };
}
