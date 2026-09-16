import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { IssuesView } from "@/client/features/audit/results/IssuesView";
import { PagesTable } from "@/client/features/audit/results/PagesTable";
import {
  extractHostname,
  formatDate,
  LighthouseScoreBadge,
} from "@/client/features/audit/shared";
import { isLighthouseFailure } from "@/client/features/audit/results/AuditResultsTableFilterLogic";
import {
  ScreenshotThumbnail,
  screenshotUrl,
} from "@/client/features/audit/screenshot";
import { getIssueDescriptor } from "@/shared/audit-issues";
import type { SharedAuditReport } from "@/client/features/audit/share/types";

type SharedTab = "issues" | "pages" | "performance";

const TAB_LABELS: Record<SharedTab, string> = {
  issues: "Issues",
  pages: "Pages",
  performance: "Performance",
};

/**
 * The read-only report a share link opens. Everything here is interactive —
 * tabs, filters, sorting, expanding an issue — but nothing writes: there is no
 * export, no re-run, no project navigation, and no way back into the app.
 */
export function SharedReportView({
  report,
  shareToken,
  viewToken,
}: {
  report: SharedAuditReport;
  shareToken: string;
  viewToken: string | null;
}) {
  const { audit, pages, lighthouse, issues } = report;
  const hasPerformance = lighthouse.length > 0;
  const [tab, setTab] = useState<SharedTab>("issues");
  const activeTab = tab === "performance" && !hasPerformance ? "issues" : tab;

  const severityCounts = useMemo(() => {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const issue of issues) {
      const severity =
        getIssueDescriptor(issue.issueType)?.severity ?? issue.severity;
      if (severity === "critical") counts.critical += 1;
      else if (severity === "warning") counts.warning += 1;
      else counts.info += 1;
    }
    return counts;
  }, [issues]);

  const tabs: SharedTab[] = hasPerformance
    ? ["issues", "pages", "performance"]
    : ["issues", "pages"];

  return (
    <div className="min-h-screen bg-base-200/40">
      <header className="border-b border-base-300 bg-base-100">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <p className="text-xs uppercase tracking-wider text-base-content/50">
            SEO audit
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {extractHostname(audit.startUrl)}
            <a
              href={audit.startUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-base-content/40 hover:text-base-content"
              aria-label="Open the audited site"
            >
              <ExternalLink className="size-4" />
            </a>
          </h1>
          <p className="mt-1 text-sm text-base-content/60">
            {audit.completedAt
              ? `Completed ${formatDate(audit.completedAt)}`
              : `Started ${formatDate(audit.startedAt)}`}
            {" · "}
            {audit.pagesCrawled} {audit.pagesCrawled === 1 ? "page" : "pages"}{" "}
            crawled
          </p>

          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat label="Critical" value={severityCounts.critical} tone="text-error" />
            <SummaryStat label="Warnings" value={severityCounts.warning} tone="text-warning" />
            <SummaryStat label="Notices" value={severityCounts.info} />
            <SummaryStat label="Pages" value={pages.length} />
          </dl>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div role="tablist" className="tabs tabs-bordered mb-4">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={activeTab === name}
              className={`tab ${activeTab === name ? "tab-active" : ""}`}
              onClick={() => setTab(name)}
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>

        {activeTab === "issues" && <IssuesView issues={issues} />}
        {activeTab === "pages" && (
          <PagesTable pages={pages} startUrl={audit.startUrl} issues={issues} />
        )}
        {activeTab === "performance" && (
          <SharedPerformanceTable
            auditId={audit.id}
            lighthouse={lighthouse}
            pages={pages}
            shareToken={shareToken}
            viewToken={viewToken}
          />
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-base-content/40 sm:px-6">
        Read-only report. Figures reflect the crawl on{" "}
        {formatDate(audit.completedAt ?? audit.startedAt)} and do not update.
      </footer>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-box border border-base-300 bg-base-100 px-3 py-2">
      <dt className="text-xs text-base-content/50">{label}</dt>
      <dd className={`text-xl font-semibold ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

/**
 * A viewer-facing performance table. Unlike the in-app one it has no
 * drill-down into the stored Lighthouse payload — just the scores, the field
 * metrics and the screenshot of what the page rendered as.
 */
function SharedPerformanceTable({
  auditId,
  lighthouse,
  pages,
  shareToken,
  viewToken,
}: {
  auditId: string;
  lighthouse: SharedAuditReport["lighthouse"];
  pages: SharedAuditReport["pages"];
  shareToken: string;
  viewToken: string | null;
}) {
  const pageUrlById = useMemo(
    () => new Map(pages.map((page) => [page.id, page.url])),
    [pages],
  );

  return (
    <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Page</th>
            <th>Device</th>
            <th className="text-right">Perf</th>
            <th className="text-right">A11y</th>
            <th className="text-right">SEO</th>
            <th className="text-right">LCP</th>
            <th className="text-right">CLS</th>
            <th>Screenshot</th>
          </tr>
        </thead>
        <tbody>
          {lighthouse.map((row) => {
            const failed = isLighthouseFailure(row);
            return (
              <tr key={`${row.pageId}-${row.strategy}`}>
                <td className="max-w-xs truncate font-mono text-xs">
                  {pageUrlById.get(row.pageId) ?? row.pageId}
                </td>
                <td className="capitalize">{row.strategy}</td>
                {failed ? (
                  <td colSpan={5} className="text-xs text-base-content/50">
                    {row.errorMessage ?? "Check failed"}
                  </td>
                ) : (
                  <>
                    <td className="text-right">
                      <LighthouseScoreBadge score={row.performanceScore} />
                    </td>
                    <td className="text-right">
                      <LighthouseScoreBadge score={row.accessibilityScore} />
                    </td>
                    <td className="text-right">
                      <LighthouseScoreBadge score={row.seoScore} />
                    </td>
                    <td className="text-right text-xs">
                      {formatMs(row.lcpMs)}
                    </td>
                    <td className="text-right text-xs">
                      {row.cls == null ? "-" : row.cls.toFixed(3)}
                    </td>
                  </>
                )}
                <td>
                  {row.hasScreenshot ? (
                    <ScreenshotThumbnail
                      src={screenshotUrl({
                        auditId,
                        pageId: row.pageId,
                        strategy: row.strategy,
                        shareToken,
                        viewToken,
                      })}
                      alt={`${row.strategy} rendering of ${pageUrlById.get(row.pageId) ?? "the page"}`}
                    />
                  ) : (
                    <span className="text-xs text-base-content/30">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatMs(value: number | null): string {
  if (value == null) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}
