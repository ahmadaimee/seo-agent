import { afterEach, describe, expect, it, vi } from "vitest";

const getOptionalEnvValueMock = vi.hoisted(() =>
  vi.fn<(name: string) => Promise<string | undefined>>(async () => undefined),
);

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: getOptionalEnvValueMock,
}));

import {
  fetchPagespeedLighthouse,
  resolveLighthouseProvider,
} from "@/server/lib/pagespeed/lighthouse";

afterEach(() => {
  vi.unstubAllGlobals();
  getOptionalEnvValueMock.mockReset();
  getOptionalEnvValueMock.mockImplementation(async () => undefined);
});

function envValues(values: Record<string, string | undefined>): void {
  getOptionalEnvValueMock.mockImplementation(async (name) => values[name]);
}

/** The URL `fetch` was called with, narrowed from RequestInfo at runtime. */
function toRequestUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw new Error(
      `fetch was not called with a URL string (got ${typeof value})`,
    );
  }
  return new URL(value);
}

function lighthouseResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lighthouseResult: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      lighthouseVersion: "12.0.0",
      categories: {
        performance: { score: 0.91, auditRefs: [{ id: "unused-css-rules" }] },
        accessibility: { score: 0.8 },
        "best-practices": { score: 0.75 },
        seo: { score: 1 },
      },
      audits: {
        "largest-contentful-paint": {
          score: 0.9,
          displayValue: "1.8 s",
          numericValue: 1800,
        },
        "unused-css-rules": {
          title: "Reduce unused CSS",
          description: "Remove dead rules.",
          score: 0.2,
          scoreDisplayMode: "binary",
          details: { overallSavingsMs: 450, items: [{ url: "a.css" }] },
        },
        "final-screenshot": {
          details: { data: "data:image/jpeg;base64,AAAA" },
        },
      },
      ...overrides,
    },
  };
}

describe("resolveLighthouseProvider", () => {
  it("defaults to dataforseo when no PageSpeed key is configured", async () => {
    await expect(resolveLighthouseProvider()).resolves.toBe("dataforseo");
  });

  it("defaults to pagespeed once PAGESPEED_API_KEY is set", async () => {
    envValues({ PAGESPEED_API_KEY: "test-key" });
    await expect(resolveLighthouseProvider()).resolves.toBe("pagespeed");
  });

  it("lets LIGHTHOUSE_PROVIDER override the key-based default", async () => {
    envValues({
      PAGESPEED_API_KEY: "test-key",
      LIGHTHOUSE_PROVIDER: "dataforseo",
    });
    await expect(resolveLighthouseProvider()).resolves.toBe("dataforseo");
  });
});

describe("fetchPagespeedLighthouse", () => {
  it("maps a PageSpeed response into the stored payload", async () => {
    envValues({ PAGESPEED_API_KEY: "test-key" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(lighthouseResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await fetchPagespeedLighthouse({
      url: "https://example.com/",
      strategy: "mobile",
    });

    expect(payload.source).toBe("pagespeed-lighthouse");
    expect(payload.metadata).toMatchObject({
      finalUrl: "https://example.com/",
      strategy: "mobile",
      lighthouseVersion: "12.0.0",
      taskId: null,
      cost: null,
    });
    expect(payload.scores).toEqual({
      performance: 91,
      accessibility: 80,
      "best-practices": 75,
      seo: 100,
    });
    expect(payload.metrics.largestContentfulPaint.numericValue).toBe(1800);
    expect(payload.issues[0]).toMatchObject({
      auditKey: "unused-css-rules",
      severity: "critical",
    });
    // The screenshot the audit uploads to R2 must survive the PSI path too.
    expect(payload.screenshot).toBe("data:image/jpeg;base64,AAAA");

    const requestUrl = toRequestUrl(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    expect(requestUrl.searchParams.get("url")).toBe("https://example.com/");
    expect(requestUrl.searchParams.get("strategy")).toBe("mobile");
    expect(requestUrl.searchParams.getAll("category")).toEqual([
      "PERFORMANCE",
      "ACCESSIBILITY",
      "BEST_PRACTICES",
      "SEO",
    ]);
    expect(requestUrl.searchParams.get("key")).toBe("test-key");
  });

  it("omits the key parameter when none is configured", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(lighthouseResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPagespeedLighthouse({
      url: "https://example.com/",
      strategy: "desktop",
    });

    const requestUrl = toRequestUrl(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl.searchParams.has("key")).toBe(false);
  });

  it("fails when the response carries no lighthouseResult", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "run" })),
    );

    await expect(
      fetchPagespeedLighthouse({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toThrow("missing lighthouseResult");
  });

  it("reports a quota rejection and points at the API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            {
              error: {
                message: "Quota exceeded",
                status: "RESOURCE_EXHAUSTED",
              },
            },
            { status: 429 },
          ),
        ),
    );

    await expect(
      fetchPagespeedLighthouse({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toThrow(/rate limit exceeded \(HTTP 429\).*PAGESPEED_API_KEY/s);
  });

  it("fails on a non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("upstream failure", { status: 500 })),
    );

    await expect(
      fetchPagespeedLighthouse({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toThrow("PageSpeed Insights returned HTTP 500");
  });
});
