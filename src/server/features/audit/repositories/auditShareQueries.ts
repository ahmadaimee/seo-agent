import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditIssues,
  auditLighthouseResults,
  auditPages,
  audits,
} from "@/db/schema";

/**
 * Queries behind read-only share links. Lives beside AuditRepository (same
 * pattern as auditSummaryQueries) to keep the main repository under the
 * file-size limit.
 *
 * These are the only audit reads keyed by something other than a project id —
 * the share token is the caller's whole credential — so keeping them together
 * makes that boundary easy to review.
 */

/**
 * Store (or clear) an audit's share link. Passing nulls revokes it, which also
 * retires any outstanding view tokens, since those are keyed on the hash.
 */
export async function setAuditShare(
  auditId: string,
  projectId: string,
  share: {
    shareToken: string | null;
    sharePasswordHash: string | null;
    shareCreatedAt: string | null;
  },
) {
  await db
    .update(audits)
    .set(share)
    .where(and(eq(audits.id, auditId), eq(audits.projectId, projectId)));
}

/** Resolve a share token to its audit. Unique index — at most one row. */
export async function getAuditByShareToken(shareToken: string) {
  return db.query.audits.findFirst({
    where: eq(audits.shareToken, shareToken),
  });
}

/** Everything the read-only report renders, keyed by audit id alone. */
export async function getAuditResultsById(auditId: string) {
  const [pages, lighthouse, issues] = await Promise.all([
    db.query.auditPages.findMany({
      where: eq(auditPages.auditId, auditId),
    }),
    db.query.auditLighthouseResults.findMany({
      where: eq(auditLighthouseResults.auditId, auditId),
    }),
    db.query.auditIssues.findMany({
      where: eq(auditIssues.auditId, auditId),
    }),
  ]);

  return { pages, lighthouse, issues };
}
