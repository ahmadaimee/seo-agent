import { isLighthouseFailure } from "@/client/features/audit/results/AuditResultsTableFilterLogic";

/**
 * Summary figures for the audit header, shared by the in-app results view and
 * the read-only shared report. Both surfaces quote the same numbers to the
 * same audit, so the arithmetic lives here rather than in either component —
 * two copies would eventually disagree, and the one a client sees is the copy
 * nobody would notice had drifted.
 */

/**
 * Only the fields these figures actually read. Structural rather than tied to
 * AuditResultsData: the shared report serves a narrower row that omits the R2
 * keys, and both surfaces must be able to quote the same numbers.
 */
interface LighthouseScoreRow {
  errorMessage: string | null;
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
}

interface PageResponseRow {
  responseTimeMs: number | null;
}

interface LighthouseSummary {
  /** Rows attempted, including the ones that failed. */
  tested: number;
  failed: number;
  avgPerformance: number | null;
  avgSeo: number | null;
  avgAccessibility: number | null;
}

export function computeAverageResponseMs(
  pages: readonly PageResponseRow[],
): number {
  if (pages.length === 0) return 0;
  const total = pages.reduce(
    (sum, page) => sum + (page.responseTimeMs ?? 0),
    0,
  );
  return Math.round(total / pages.length);
}

export function summarizeLighthouse(
  lighthouse: readonly LighthouseScoreRow[],
): LighthouseSummary {
  const successful = lighthouse.filter((row) => !isLighthouseFailure(row));

  // Failed runs carry null scores; averaging over them would quietly drag every
  // score toward zero and read as a site problem rather than a run problem.
  const averageScore = (
    key: "performanceScore" | "seoScore" | "accessibilityScore",
  ): number | null => {
    const values = successful
      .map((row) => row[key])
      .filter((value): value is number => value != null);
    if (values.length === 0) return null;
    return Math.round(
      values.reduce((sum, value) => sum + value, 0) / values.length,
    );
  };

  return {
    tested: lighthouse.length,
    failed: lighthouse.length - successful.length,
    avgPerformance: averageScore("performanceScore"),
    avgSeo: averageScore("seoScore"),
    avgAccessibility: averageScore("accessibilityScore"),
  };
}

/** Lighthouse's own banding: 90+ good, 50-89 needs work, below 50 poor. */
export function scoreClass(score: number | null): string {
  if (score == null) return "";
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-error";
}

export function formatScore(score: number | null): string {
  return score == null ? "—" : String(score);
}
