import { describe, expect, it } from "vitest";
import { runPageReporters } from "@/server/lib/audit/issues/page-reporters";
import {
  findDuplicates,
  findRedirectChainsAndLoops,
  type SlimPage,
} from "@/server/lib/audit/issues/multipage-checks";
import type { CrawledPageResult } from "@/server/lib/audit/types";
import {
  HEALTHY_LINK,
  makePage,
} from "@/server/lib/audit/issues/page-reporters.fixtures";

function issueTypes(page: CrawledPageResult): string[] {
  return runPageReporters(page).map((issue) => issue.issueType);
}

describe("runPageReporters", () => {
  it("reports nothing for a healthy page", () => {
    expect(issueTypes(makePage({}))).toEqual([]);
  });

  it.each([
    {
      name: "missing-structured-data on an indexable page with no JSON-LD",
      page: { hasStructuredData: false },
      issue: "missing-structured-data",
      present: true,
    },
    {
      name: "no missing-structured-data on a non-indexable page",
      page: { hasStructuredData: false, isIndexable: false },
      issue: "missing-structured-data",
      present: false,
    },
    {
      name: "missing-breadcrumbs below the top level with no BreadcrumbList",
      page: { url: "https://example.com/blog/post", hasBreadcrumbList: false },
      issue: "missing-breadcrumbs",
      present: true,
    },
    {
      name: "no missing-breadcrumbs on a top-level page",
      page: { url: "https://example.com/about", hasBreadcrumbList: false },
      issue: "missing-breadcrumbs",
      present: false,
    },
    {
      name: "no missing-breadcrumbs when BreadcrumbList is present",
      page: { url: "https://example.com/blog/post", hasBreadcrumbList: true },
      issue: "missing-breadcrumbs",
      present: false,
    },
    {
      name: "deep-url-path for a deeply nested URL path",
      page: { url: "https://example.com/a/b/c/d/e" },
      issue: "deep-url-path",
      present: true,
    },
    {
      name: "no deep-url-path for a shallow URL path",
      page: { url: "https://example.com/a/b" },
      issue: "deep-url-path",
      present: false,
    },
  ])("reports $name", ({ page, issue, present }) => {
    const types = issueTypes(makePage(page));
    if (present) expect(types).toContain(issue);
    else expect(types).not.toContain(issue);
  });

  it("reports only blocked-page for a blocked fetch", () => {
    expect(
      issueTypes(makePage({ fetchClass: "blocked", statusCode: 403 })),
    ).toEqual(["blocked-page"]);
  });

  it("reports only rate-limited-page for a fetch the site kept 429ing", () => {
    expect(
      issueTypes(makePage({ fetchClass: "rate_limited", statusCode: 429 })),
    ).toEqual(["rate-limited-page"]);
  });

  it("reports nothing for a fetch error", () => {
    expect(
      issueTypes(makePage({ fetchClass: "error", statusCode: 0 })),
    ).toEqual([]);
  });

  it("classifies error statuses by range", () => {
    expect(issueTypes(makePage({ statusCode: 500 }))).toEqual(["server-error"]);
    expect(issueTypes(makePage({ statusCode: 404 }))).toEqual(["broken-page"]);
    expect(
      issueTypes(
        makePage({
          statusCode: 301,
          redirectUrl: "https://example.com/b",
        }),
      ),
    ).toEqual([]);
  });

  it("checks titles and meta descriptions", () => {
    expect(issueTypes(makePage({ title: "" }))).toContain("missing-title");
    expect(issueTypes(makePage({ title: "x".repeat(70) }))).toContain(
      "title-too-long",
    );
    expect(issueTypes(makePage({ title: "Tiny" }))).toContain(
      "title-too-short",
    );
    expect(issueTypes(makePage({ metaDescription: "" }))).toContain(
      "missing-meta-description",
    );
    expect(
      issueTypes(makePage({ metaDescription: "x".repeat(200) })),
    ).toContain("meta-description-too-long");
    expect(issueTypes(makePage({ metaDescription: "x".repeat(69) }))).toContain(
      "meta-description-too-short",
    );
    expect(
      issueTypes(makePage({ metaDescription: "x".repeat(70) })),
    ).not.toContain("meta-description-too-short");
    expect(
      runPageReporters(makePage({ metaDescription: "x".repeat(69) })).find(
        (issue) => issue.issueType === "meta-description-too-short",
      )?.details,
    ).toEqual({ length: 69 });
  });

  it("checks headings", () => {
    expect(issueTypes(makePage({ h1Count: 0 }))).toContain("missing-h1");
    expect(issueTypes(makePage({ h1Count: 3 }))).toContain("multiple-h1");
    expect(issueTypes(makePage({ headingOrder: [1, 2, 4] }))).toContain(
      "heading-order-skip",
    );
  });

  it("skips content checks for non-HTML responses", () => {
    const nonHtml = makePage({
      isHtml: false,
      title: "",
      metaDescription: "",
      h1Count: 0,
      headingOrder: [],
      wordCount: 0,
      contentHash: null,
    });
    expect(issueTypes(nonHtml)).toEqual([]);
  });

  it("still checks empty-shell HTML pages", () => {
    const shell = makePage({
      isHtml: true,
      title: "",
      metaDescription: "",
      h1Count: 0,
      headingOrder: [],
      wordCount: 0,
      contentHash: null,
    });
    const types = issueTypes(shell);
    expect(types).toContain("missing-title");
    expect(types).toContain("missing-h1");
    expect(types).toContain("thin-content");
  });

  it("flags indexability and canonical signals", () => {
    expect(
      issueTypes(makePage({ isIndexable: false, robotsMeta: "noindex" })),
    ).toContain("noindex-page");

    const conflicted = issueTypes(
      makePage({
        canonicalUrl: "https://example.com/canonical-a",
        headerCanonicalUrl: "https://example.com/canonical-b",
      }),
    );
    expect(conflicted).toContain("canonical-conflict");
    expect(conflicted).toContain("canonicalized-page");

    expect(
      issueTypes(makePage({ canonicalUrl: "https://example.com/a" })),
    ).not.toContain("canonicalized-page");
  });

  it("flags thin content only on indexable pages", () => {
    expect(issueTypes(makePage({ wordCount: 50 }))).toContain("thin-content");
    expect(
      issueTypes(
        makePage({ wordCount: 50, isIndexable: false, robotsMeta: "noindex" }),
      ),
    ).not.toContain("thin-content");
  });

  it("flags slow responses and deep pages", () => {
    expect(issueTypes(makePage({ responseTimeMs: 3000 }))).toContain(
      "slow-response",
    );
    expect(issueTypes(makePage({ crawlDepth: 6 }))).toContain("deep-page");
    expect(issueTypes(makePage({ crawlDepth: null }))).not.toContain(
      "deep-page",
    );
  });

  it("flags indexable pages with no outgoing links", () => {
    expect(issueTypes(makePage({ links: [] }))).toContain("no-outgoing-links");
    expect(
      issueTypes(makePage({ links: [], isIndexable: false })),
    ).not.toContain("no-outgoing-links");
    expect(issueTypes(makePage({ links: [HEALTHY_LINK] }))).not.toContain(
      "no-outgoing-links",
    );
  });

  describe("social preview image", () => {
    const noImage = { ogImage: null, ogImageUrl: null };

    it("flags an indexable page with neither og:image nor twitter:image", () => {
      expect(issueTypes(makePage(noImage))).toContain("missing-og-image");
    });

    it("accepts a twitter:image when og:image is absent", () => {
      expect(
        issueTypes(
          makePage({ ...noImage, twitterImage: "https://example.com/tw.png" }),
        ),
      ).not.toContain("missing-og-image");
    });

    it("leaves noindex pages alone", () => {
      expect(
        issueTypes(makePage({ ...noImage, isIndexable: false })),
      ).not.toContain("missing-og-image");
    });

    it("flags a relative og:image instead of calling it missing", () => {
      const types = issueTypes(makePage({ ogImage: "/og.png" }));
      expect(types).toContain("og-image-relative-url");
      expect(types).not.toContain("missing-og-image");
    });

    it("flags a protocol-relative og:image, which scrapers mishandle", () => {
      expect(
        issueTypes(makePage({ ogImage: "//cdn.example.com/og.png" })),
      ).toContain("og-image-relative-url");
    });

    it("accepts an absolute og:image whatever its case", () => {
      expect(
        issueTypes(makePage({ ogImage: "HTTPS://example.com/og.png" })),
      ).not.toContain("og-image-relative-url");
    });

    it("flags declared dimensions below the platform minimum", () => {
      expect(
        issueTypes(makePage({ ogImageWidth: 1200, ogImageHeight: 100 })),
      ).toContain("og-image-too-small");
      expect(
        issueTypes(makePage({ ogImageWidth: 1200, ogImageHeight: 630 })),
      ).not.toContain("og-image-too-small");
    });

    it("says nothing about size when only one dimension is declared", () => {
      expect(issueTypes(makePage({ ogImageWidth: 10 }))).not.toContain(
        "og-image-too-small",
      );
    });
  });
});

function makeSlimPage(overrides: Partial<SlimPage>): SlimPage {
  return {
    id: overrides.url ?? "page",
    url: "https://example.com/a",
    statusCode: 200,
    fetchClass: "ok",
    title: null,
    metaDescription: null,
    contentHash: null,
    redirectUrl: null,
    wordCount: 100,
    isIndexable: true,
    canonicalUrl: null,
    headerCanonicalUrl: null,
    ...overrides,
  };
}

describe("findDuplicates", () => {
  it("flags duplicate titles across pages and includes the other URLs", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({ url: "https://example.com/b", title: "Same" }),
      makeSlimPage({ url: "https://example.com/c", title: "Different" }),
    ]);
    const duplicateTitles = issues.filter(
      (issue) => issue.issueType === "duplicate-title",
    );
    expect(duplicateTitles).toHaveLength(2);
    expect(duplicateTitles[0].details?.otherUrls).toEqual([
      "https://example.com/b",
    ]);
  });

  it("excludes noindexed and canonicalized pages from duplicate groups", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({
        url: "https://example.com/b",
        title: "Same",
        canonicalUrl: "https://example.com/a",
      }),
      makeSlimPage({
        url: "https://example.com/c",
        title: "Same",
        isIndexable: false,
      }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("ignores non-2xx and blocked pages", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({
        url: "https://example.com/b",
        title: "Same",
        fetchClass: "blocked",
        statusCode: 403,
      }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("groups duplicate content by hash only when there is text", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", contentHash: "h1" }),
      makeSlimPage({ url: "https://example.com/b", contentHash: "h1" }),
      makeSlimPage({
        url: "https://example.com/empty-1",
        contentHash: "h2",
        wordCount: 0,
      }),
      makeSlimPage({
        url: "https://example.com/empty-2",
        contentHash: "h2",
        wordCount: 0,
      }),
    ]);
    expect(
      issues.filter((issue) => issue.issueType === "duplicate-content"),
    ).toHaveLength(2);
  });
});

describe("findRedirectChainsAndLoops", () => {
  const redirect = (url: string, target: string) =>
    makeSlimPage({ url, statusCode: 301, redirectUrl: target });

  it("ignores single redirects", () => {
    expect(
      findRedirectChainsAndLoops([
        redirect("https://example.com/a", "https://example.com/b"),
        makeSlimPage({ url: "https://example.com/b" }),
      ]),
    ).toHaveLength(0);
  });

  it("flags a chain once, on its head", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/b"),
      redirect("https://example.com/b", "https://example.com/c"),
      makeSlimPage({ url: "https://example.com/c" }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe("redirect-chain");
    expect(issues[0].pageUrl).toBe("https://example.com/a");
    expect(issues[0].details?.hops).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("flags loops", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/b"),
      redirect("https://example.com/b", "https://example.com/a"),
    ]);
    expect(
      issues.filter((issue) => issue.issueType === "redirect-loop").length,
    ).toBeGreaterThan(0);
  });

  it("flags self-loops", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/a"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe("redirect-loop");
  });
});
