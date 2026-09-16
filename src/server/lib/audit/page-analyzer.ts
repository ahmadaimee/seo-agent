/**
 * HTML page analyzer using htmlparser2's streaming tokenizer.
 *
 * Extracts SEO-relevant data from a page's HTML: title, meta description,
 * headings, images, links, canonical, OG tags, structured data, robots meta,
 * word count, hreflang.
 *
 * Deliberately NOT a DOM parser: the previous cheerio implementation built a
 * full DOM (~5-10x the HTML's size) per page, and with 25 concurrent parses
 * on a 128MB isolate that was the audit engine's dominant OOM cause. The
 * tokenizer keeps only the accumulated text and extracted fields in memory.
 */
import { Parser } from "htmlparser2";
import { normalizeUrl, isSameOrigin } from "./url-utils";
import type { PageAnalysis, PageFavicon, PageLink } from "./types";

const SKIPPED_LINK_PROTOCOLS = /^(javascript:|mailto:|tel:|#)/;
/** Subtrees whose text is not visible content. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const MAX_ANCHOR_CHARS = 200;
/**
 * Per-page caps on the extracted collections. Crawler-trap and mega-menu
 * pages can carry thousands of links/images per page, and crawled pages sit
 * in memory in 25-page persist batches — uncapped collections were part of
 * the audit engine's exceededMemory profile. Counts derived from these
 * arrays saturate at the cap on such pathological pages.
 */
const MAX_EXTRACTED_LINKS = 1_000;
const MAX_EXTRACTED_IMAGES = 1_000;
/**
 * A head declares a handful of icons at most; the cap only guards against
 * malformed pages that repeat the tag.
 */
const MAX_EXTRACTED_FAVICONS = 20;

/**
 * rel tokens that name an icon a search engine or browser would use. The
 * "shortcut icon" spelling arrives as two tokens, so matching "icon" covers
 * it. rel="mask-icon" is excluded: it is a monochrome Safari pinned-tab
 * glyph, never used as the site's icon in search results.
 */
const FAVICON_REL_TOKENS = new Set([
  "icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
]);

/**
 * Analytics and tag-manager ids. Both halves matter: GA4 usually arrives as a
 * gtag.js <script src>, while Google Tag Manager is an inline snippet that
 * injects its own script at runtime, so a src-only scan would miss every
 * GTM-managed site.
 */
const ANALYTICS_ID_PATTERN =
  /\b(?:GTM-[A-Z0-9]{4,10}|G-[A-Z0-9]{8,12}|UA-\d{4,10}-\d{1,4})\b/g;
/**
 * Requiring a nearby product marker before matching ids keeps a minified
 * bundle that happens to contain a G-shaped token from being read as an
 * analytics install.
 */
const ANALYTICS_MARKER_PATTERN =
  /googletagmanager|google-analytics|gtag\(|dataLayer/;
const MAX_ANALYTICS_IDS = 10;

function collectAnalyticsIds(text: string, into: Set<string>): void {
  if (into.size >= MAX_ANALYTICS_IDS || !text) return;
  if (!ANALYTICS_MARKER_PATTERN.test(text)) return;
  for (const match of text.matchAll(ANALYTICS_ID_PATTERN)) {
    into.add(match[0]);
    if (into.size >= MAX_ANALYTICS_IDS) return;
  }
}

/**
 * Explicit comparator so the sort is deterministic and locale-independent
 * (the codebase targets ES2022, where Array#toSorted is not available).
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** og:image:width / og:image:height carry pixel counts as strings. */
function toPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface OpenAnchor {
  href: string;
  rel: string;
  text: string[];
}

/**
 * Analyze an HTML string and extract all SEO-relevant data.
 */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  statusCode: number,
  responseTimeMs: number,
  redirectUrl: string | null = null,
): PageAnalysis {
  let title: string | null = null;
  let titleDepth = 0;
  let titleDone = false;
  // parse5 (the old DOM path) treats <noscript> content as raw text when
  // scripting is enabled; skip element extraction inside it to match.
  let noscriptDepth = 0;
  let metaDescription: string | null = null;
  let canonical: string | null = null;
  let robotsMeta: string | null = null;
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let ogImage: string | null = null;
  // og:image:url and og:image:secure_url are sub-properties of a preceding
  // og:image, but several CMS templates emit them *instead* of the bare tag;
  // keep them as a fallback rather than reporting the page as image-less.
  let ogImageFallback: string | null = null;
  let ogImageAlt: string | null = null;
  let ogImageWidth: number | null = null;
  let ogImageHeight: number | null = null;
  let twitterImage: string | null = null;
  let hasStructuredData = false;
  let googleSiteVerification: string | null = null;
  let bingSiteVerification: string | null = null;
  const hreflangTags: string[] = [];
  const favicons: PageFavicon[] = [];
  const analyticsIds = new Set<string>();

  const h1s: string[] = [];
  const headingOrder: number[] = [];
  let openH1: string[] | null = null;

  const images: Array<{ src: string | null; alt: string | null }> = [];
  const linksByTarget = new Map<string, PageLink>();
  let openAnchor: OpenAnchor | null = null;

  // Visible text: prefer text inside an explicit <body>; when the document
  // never opens one (fragments), fall back to all non-head text. Both
  // exclude NON_CONTENT_TAGS subtrees.
  let suppressDepth = 0;
  // Tracked separately from suppressDepth: script text is excluded from the
  // word count but still scanned for analytics ids.
  let scriptDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let sawBody = false;
  const bodyParts: string[] = [];
  const fallbackParts: string[] = [];

  /** og:image's sub-properties, split out to keep handleMetaTag simple. */
  const handleOgImageMeta = (
    property: string,
    content: string | undefined,
  ): boolean => {
    switch (property) {
      case "og:image":
        ogImage ??= content ?? null;
        return true;
      case "og:image:url":
      case "og:image:secure_url":
        ogImageFallback ??= content ?? null;
        return true;
      case "og:image:alt":
        ogImageAlt ??= content ?? null;
        return true;
      case "og:image:width":
        ogImageWidth ??= toPositiveInt(content);
        return true;
      case "og:image:height":
        ogImageHeight ??= toPositiveInt(content);
        return true;
      default:
        return false;
    }
  };

  const handleMetaTag = (attribs: Record<string, string>) => {
    const content = attribs["content"];
    const name = attribs["name"];
    const property = attribs["property"];

    if (property !== undefined && handleOgImageMeta(property, content)) return;

    switch (name) {
      case "description":
        metaDescription ??= content?.trim() ?? "";
        return;
      case "robots":
        robotsMeta ??= content ?? null;
        return;
      case "google-site-verification":
        googleSiteVerification ??= content?.trim() || null;
        return;
      case "msvalidate.01":
        // Bing Webmaster Tools' meta method; Yahoo and DuckDuckGo read the
        // same index, so this one tag covers them.
        bingSiteVerification ??= content?.trim() || null;
        return;
    }

    if (property === "og:title") {
      ogTitle ??= content ?? null;
      return;
    }
    if (property === "og:description") {
      ogDescription ??= content ?? null;
      return;
    }

    // Twitter cards are specified with name=, but property= is common enough
    // in the wild (and honored by the scrapers) to accept both.
    const twitterKey = name ?? property;
    if (twitterKey === "twitter:image" || twitterKey === "twitter:image:src") {
      twitterImage ??= content ?? null;
    }
  };

  const handleHeadingTag = (name: string) => {
    const headingLevel = HEADING_LEVELS[name];
    if (headingLevel === undefined) return;
    headingOrder.push(headingLevel);
    if (headingLevel === 1 && openH1 === null) openH1 = [];
  };

  const handleScriptTag = (attribs: Record<string, string>) => {
    scriptDepth += 1;
    if (attribs["type"] === "application/ld+json") {
      hasStructuredData = true;
    }
    collectAnalyticsIds(attribs["src"] ?? "", analyticsIds);
  };

  const handleLinkTag = (attribs: Record<string, string>) => {
    if (attribs["rel"] === "canonical") {
      canonical ??= attribs["href"] ?? null;
      return;
    }
    if (attribs["rel"] === "alternate" && attribs["hreflang"]) {
      hreflangTags.push(attribs["hreflang"]);
      return;
    }
    // rel is a space-separated token list ("shortcut icon"), so match tokens
    // rather than the raw attribute value.
    const href = attribs["href"]?.trim();
    if (!href || favicons.length >= MAX_EXTRACTED_FAVICONS) return;
    const relTokens = (attribs["rel"] ?? "").toLowerCase().split(/\s+/);
    if (!relTokens.some((token) => FAVICON_REL_TOKENS.has(token))) return;
    favicons.push({
      rel: relTokens.filter(Boolean).join(" "),
      href,
      // data: and blob: icons are legitimate markup but nothing to fetch, so
      // they resolve to null and are only counted as "an icon is declared".
      resolvedUrl: normalizeUrl(href, pageUrl),
      sizes: attribs["sizes"]?.trim() || null,
      type: attribs["type"]?.trim().toLowerCase() || null,
    });
  };

  const closeAnchor = () => {
    if (!openAnchor) return;
    const { href, rel, text } = openAnchor;
    openAnchor = null;
    if (linksByTarget.size >= MAX_EXTRACTED_LINKS) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved || linksByTarget.has(resolved)) return;
    const anchor = text
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANCHOR_CHARS);
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (NON_CONTENT_TAGS.has(name)) {
          suppressDepth += 1;
        }
        if (name === "noscript") noscriptDepth += 1;
        if (noscriptDepth > 0) return;
        switch (name) {
          case "title":
            // Ignore <title> inside <svg> — only the document title counts.
            if (!titleDone && suppressDepth === 0) {
              titleDepth += 1;
              if (title === null) title = "";
            }
            break;
          case "head":
            headDepth += 1;
            break;
          case "body":
            bodyDepth += 1;
            sawBody = true;
            break;
          case "meta":
            handleMetaTag(attribs);
            break;
          case "link":
            handleLinkTag(attribs);
            break;
          case "img":
            if (images.length < MAX_EXTRACTED_IMAGES) {
              images.push({
                src: attribs["src"] ?? null,
                alt: "alt" in attribs ? attribs["alt"] : null,
              });
            }
            break;
          case "script":
            handleScriptTag(attribs);
            break;
          case "a": {
            // HTML forbids nested <a>; browsers implicitly close the open
            // one, and the tokenizer has no tree correction, so mirror that.
            closeAnchor();
            const href = attribs["href"];
            if (href && !SKIPPED_LINK_PROTOCOLS.test(href)) {
              openAnchor = {
                href,
                rel: attribs["rel"]?.toLowerCase() ?? "",
                text: [],
              };
            }
            break;
          }
        }
        handleHeadingTag(name);
      },
      ontext(text) {
        // Before the suppression check: the GTM snippet lives inside a
        // <script>, which is exactly the text the word count discards.
        if (scriptDepth > 0) collectAnalyticsIds(text, analyticsIds);
        if (suppressDepth > 0) return;
        if (titleDepth > 0) {
          if (title !== null) title += text;
          return;
        }
        if (openH1) openH1.push(text);
        if (openAnchor) openAnchor.text.push(text);
        if (bodyDepth > 0) {
          bodyParts.push(text);
        } else if (headDepth === 0) {
          fallbackParts.push(text);
        }
      },
      onclosetag(name) {
        if (NON_CONTENT_TAGS.has(name) && suppressDepth > 0) {
          suppressDepth -= 1;
        }
        if (name === "noscript" && noscriptDepth > 0) {
          noscriptDepth -= 1;
          return;
        }
        if (noscriptDepth > 0) return;
        if (name === "script" && scriptDepth > 0) scriptDepth -= 1;
        if (name === "title" && titleDepth > 0) {
          titleDepth -= 1;
          if (titleDepth === 0) titleDone = true;
        }
        if (name === "head" && headDepth > 0) headDepth -= 1;
        if (name === "body" && bodyDepth > 0) bodyDepth -= 1;
        if (name === "a") closeAnchor();
        if (name === "h1" && openH1) {
          h1s.push(openH1.join("").trim());
          openH1 = null;
        }
      },
    },
    // Defaults (non-XML mode): lowercased tag/attribute names, decoded
    // entities — matching what the DOM-based implementation saw.
  );
  parser.write(html);
  parser.end();

  const sortedAnalyticsIds = Array.from(analyticsIds);
  sortedAnalyticsIds.sort(compareStrings);

  const rawText = (sawBody ? bodyParts : fallbackParts).join("");
  const bodyText = rawText.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  return {
    url: pageUrl,
    statusCode,
    redirectUrl,
    responseTimeMs,
    title: (title ?? "").trim(),
    metaDescription: metaDescription ?? "",
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage: ogImage ?? ogImageFallback,
    ogImageAlt,
    ogImageWidth,
    ogImageHeight,
    twitterImage,
    favicons,
    googleSiteVerification,
    bingSiteVerification,
    // Sorted so the result does not depend on where in the document each tag
    // happened to appear.
    analyticsIds: sortedAnalyticsIds,
    h1s,
    headingOrder,
    wordCount,
    bodyText,
    images,
    links: Array.from(linksByTarget.values()),
    hasStructuredData,
    hreflangTags,
  };
}
