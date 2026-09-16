import { describe, expect, it } from "vitest";
import {
  buildSiteIssues,
  isGoogleReadableFavicon,
  pickFaviconToProbe,
  type ResourceProbe,
  type SiteCheckInput,
} from "@/server/lib/audit/issues/site-checks";
import type { PageFavicon } from "@/server/lib/audit/types";

const HOMEPAGE = { id: "page-home", url: "https://example.com/" };

const OK: ResourceProbe = { status: 200, contentType: "image/png" };
const NOT_FOUND: ResourceProbe = { status: 404, contentType: "text/html" };
/** A 200 that hands back the SPA shell instead of the asset. */
const SPA_FALLBACK: ResourceProbe = { status: 200, contentType: "text/html" };

function favicon(overrides: Partial<PageFavicon> = {}): PageFavicon {
  return {
    rel: "icon",
    href: "/favicon.ico",
    resolvedUrl: "https://example.com/favicon.ico",
    sizes: null,
    type: null,
    ...overrides,
  };
}

/** A site with nothing wrong, so each test can break exactly one thing. */
function makeInput(overrides: Partial<SiteCheckInput> = {}): SiteCheckInput {
  return {
    homepage: HOMEPAGE,
    homepageAnalyzed: true,
    tags: {
      googleSiteVerification: "abc123",
      bingSiteVerification: "DEF456",
      analyticsIds: ["G-ABCDEFGH12"],
    },
    robotsStatus: 200,
    robotsSitemapUrls: ["https://example.com/sitemap.xml"],
    sitemapFound: true,
    llmsTxt: { status: 200, contentType: "text/markdown" },
    favicon: {
      declared: [favicon()],
      probe: OK,
      probedUrl: "https://example.com/favicon.ico",
    },
    ogImages: [],
    ...overrides,
  };
}

function issueTypes(input: SiteCheckInput): string[] {
  return buildSiteIssues(input).map((issue) => issue.issueType);
}

describe("buildSiteIssues", () => {
  it("reports nothing for a site that serves everything", () => {
    expect(issueTypes(makeInput())).toEqual([]);
  });

  it("attributes site-level findings to the home page", () => {
    const issues = buildSiteIssues(makeInput({ sitemapFound: false }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issueType: "missing-sitemap",
      pageId: "page-home",
      pageUrl: "https://example.com/",
    });
  });

  describe("robots.txt", () => {
    it("separates a missing file from an unreachable one", () => {
      expect(issueTypes(makeInput({ robotsStatus: 404 }))).toContain(
        "missing-robots-txt",
      );
      expect(issueTypes(makeInput({ robotsStatus: 503 }))).toContain(
        "robots-txt-unreachable",
      );
    });

    it("treats a request that never answered as unreachable, not missing", () => {
      const types = issueTypes(makeInput({ robotsStatus: 0 }));
      expect(types).toContain("robots-txt-unreachable");
      expect(types).not.toContain("missing-robots-txt");
    });

    it("says nothing when robots.txt is served", () => {
      const types = issueTypes(makeInput({ robotsStatus: 200 }));
      expect(types).not.toContain("missing-robots-txt");
      expect(types).not.toContain("robots-txt-unreachable");
    });
  });

  describe("sitemap", () => {
    it("reports a missing sitemap ahead of where it is declared", () => {
      const types = issueTypes(
        makeInput({ sitemapFound: false, robotsSitemapUrls: [] }),
      );
      expect(types).toContain("missing-sitemap");
      expect(types).not.toContain("sitemap-not-in-robots");
    });

    it("reports an undeclared sitemap that exists anyway", () => {
      expect(
        issueTypes(makeInput({ sitemapFound: true, robotsSitemapUrls: [] })),
      ).toContain("sitemap-not-in-robots");
    });
  });

  describe("llms.txt", () => {
    it("reports it as absent when nothing is served", () => {
      expect(issueTypes(makeInput({ llmsTxt: NOT_FOUND }))).toContain(
        "missing-llms-txt",
      );
    });

    it("does not count an SPA catch-all HTML response as an llms.txt", () => {
      expect(issueTypes(makeInput({ llmsTxt: SPA_FALLBACK }))).toContain(
        "missing-llms-txt",
      );
    });
  });

  describe("favicon", () => {
    it("reports nothing declared and no /favicon.ico as missing", () => {
      expect(
        issueTypes(
          makeInput({
            favicon: {
              declared: [],
              probe: NOT_FOUND,
              probedUrl: "https://example.com/favicon.ico",
            },
          }),
        ),
      ).toContain("missing-favicon");
    });

    it("accepts an undeclared icon that /favicon.ico serves anyway", () => {
      expect(
        issueTypes(
          makeInput({
            favicon: {
              declared: [],
              probe: { status: 200, contentType: "image/x-icon" },
              probedUrl: "https://example.com/favicon.ico",
            },
          }),
        ),
      ).toEqual([]);
    });

    it("reports a declared icon that does not load as broken, not missing", () => {
      const types = issueTypes(
        makeInput({
          favicon: {
            declared: [favicon()],
            probe: { status: 500, contentType: null },
            probedUrl: "https://example.com/favicon.ico",
          },
        }),
      );
      expect(types).toContain("broken-favicon");
      expect(types).not.toContain("missing-favicon");
    });

    it("reports an SVG-only icon as unreadable by Google", () => {
      const svg = favicon({
        href: "/icon.svg",
        resolvedUrl: "https://example.com/icon.svg",
        type: "image/svg+xml",
      });
      expect(
        issueTypes(
          makeInput({
            favicon: {
              declared: [svg],
              probe: { status: 200, contentType: "image/svg+xml" },
              probedUrl: "https://example.com/icon.svg",
            },
          }),
        ),
      ).toEqual(["favicon-unsupported-format"]);
    });

    it("stays quiet when a readable icon sits beside an SVG one", () => {
      const svg = favicon({ href: "/icon.svg", type: "image/svg+xml" });
      expect(
        issueTypes(
          makeInput({
            favicon: {
              declared: [svg, favicon()],
              probe: OK,
              probedUrl: "https://example.com/favicon.ico",
            },
          }),
        ),
      ).toEqual([]);
    });

    it("treats an unfetchable data: icon as declared and leaves it alone", () => {
      const inline = favicon({
        href: "data:image/png;base64,iVBORw0KGgo=",
        resolvedUrl: null,
        type: "image/png",
      });
      expect(
        issueTypes(
          makeInput({
            favicon: { declared: [inline], probe: null, probedUrl: null },
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("ownership and measurement tags", () => {
    it("reports each tag it cannot find in the home page markup", () => {
      const types = issueTypes(
        makeInput({
          tags: {
            googleSiteVerification: null,
            bingSiteVerification: null,
            analyticsIds: [],
          },
        }),
      );
      expect(types).toContain("missing-analytics-tag");
      expect(types).toContain("missing-google-site-verification");
      expect(types).toContain("missing-bing-site-verification");
    });

    it("accepts a tag manager id as analytics", () => {
      expect(
        issueTypes(
          makeInput({
            tags: {
              googleSiteVerification: "abc",
              bingSiteVerification: "def",
              analyticsIds: ["GTM-ABC1234"],
            },
          }),
        ),
      ).toEqual([]);
    });

    it("stays silent when the home page was never read", () => {
      const types = issueTypes(
        makeInput({
          homepageAnalyzed: false,
          tags: {
            googleSiteVerification: null,
            bingSiteVerification: null,
            analyticsIds: [],
          },
        }),
      );
      expect(types).not.toContain("missing-analytics-tag");
      expect(types).not.toContain("missing-google-site-verification");
      expect(types).not.toContain("missing-bing-site-verification");
    });
  });

  describe("og:image reachability", () => {
    it("reports one issue per distinct broken image, not per page", () => {
      const issues = buildSiteIssues(
        makeInput({
          ogImages: [
            {
              imageUrl: "https://cdn.example.com/og.png",
              probe: NOT_FOUND,
              page: { id: "page-1", url: "https://example.com/a" },
              affectedPages: 120,
            },
          ],
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        issueType: "broken-og-image",
        pageId: "page-1",
        dedupeKey: "https://cdn.example.com/og.png",
        details: { affectedPages: 120, status: 404 },
      });
    });

    it("records a request that never answered as such", () => {
      const issues = buildSiteIssues(
        makeInput({
          ogImages: [
            {
              imageUrl: "https://cdn.example.com/og.png",
              probe: { status: 0, contentType: null },
              page: { id: "page-1", url: "https://example.com/a" },
              affectedPages: 1,
            },
          ],
        }),
      );
      expect(issues[0]?.details).toMatchObject({ status: "no response" });
    });

    it("leaves images that load alone", () => {
      expect(
        issueTypes(
          makeInput({
            ogImages: [
              {
                imageUrl: "https://cdn.example.com/og.png",
                probe: { status: 200, contentType: "image/png" },
                page: { id: "page-1", url: "https://example.com/a" },
                affectedPages: 3,
              },
            ],
          }),
        ),
      ).toEqual([]);
    });
  });
});

describe("isGoogleReadableFavicon", () => {
  it("reads the format from the type attribute when present", () => {
    expect(isGoogleReadableFavicon(favicon({ type: "image/png" }))).toBe(true);
    expect(isGoogleReadableFavicon(favicon({ type: "image/svg+xml" }))).toBe(
      false,
    );
  });

  it("falls back to the file extension", () => {
    expect(
      isGoogleReadableFavicon(
        favicon({ resolvedUrl: "https://example.com/icon.ico" }),
      ),
    ).toBe(true);
    expect(
      isGoogleReadableFavicon(
        favicon({ resolvedUrl: "https://example.com/icon.svg" }),
      ),
    ).toBe(false);
  });

  it("assumes an extensionless icon works rather than inventing an issue", () => {
    expect(
      isGoogleReadableFavicon(
        favicon({ href: "/icon", resolvedUrl: "https://example.com/icon" }),
      ),
    ).toBe(true);
  });

  it("ignores a dot in a directory name", () => {
    expect(
      isGoogleReadableFavicon(
        favicon({ resolvedUrl: "https://example.com/v1.2/icon" }),
      ),
    ).toBe(true);
  });
});

describe("pickFaviconToProbe", () => {
  it("prefers the first icon Google can read", () => {
    const svg = favicon({
      href: "/icon.svg",
      resolvedUrl: "https://example.com/icon.svg",
      type: "image/svg+xml",
    });
    expect(pickFaviconToProbe([svg, favicon()])).toBe(
      "https://example.com/favicon.ico",
    );
  });

  it("falls back to the first fetchable icon of any format", () => {
    const svg = favicon({
      href: "/icon.svg",
      resolvedUrl: "https://example.com/icon.svg",
      type: "image/svg+xml",
    });
    expect(pickFaviconToProbe([svg])).toBe("https://example.com/icon.svg");
  });

  it("returns null when every icon is inline", () => {
    expect(pickFaviconToProbe([favicon({ resolvedUrl: null })])).toBeNull();
    expect(pickFaviconToProbe([])).toBeNull();
  });
});
