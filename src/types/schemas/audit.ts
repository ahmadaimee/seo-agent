import { z } from "zod";
import {
  DEFAULT_AUDIT_PAGES,
  MIN_AUDIT_PAGES,
  PAID_MAX_AUDIT_PAGES,
} from "@/shared/audit-limits";

// ─── Server function input schemas ──────────────────────────────────────────

export const startAuditSchema = z.object({
  projectId: z.string().min(1),
  startUrl: z.string().min(1, "URL is required").max(2048),
  maxPages: z
    .number()
    .int()
    .min(MIN_AUDIT_PAGES)
    .max(PAID_MAX_AUDIT_PAGES)
    .optional()
    .default(DEFAULT_AUDIT_PAGES),
  lighthouseStrategy: z.enum(["auto", "none"]).optional().default("auto"),
});

export const getAuditStatusSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getAuditResultsSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getAuditHistorySchema = z.object({
  projectId: z.string().min(1),
});

export const deleteAuditSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getCrawlProgressSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const auditShareStateSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const createAuditShareLinkSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
  // Optional second factor on top of the unguessable token. Trimmed and
  // length-checked here so an accidental whitespace password cannot be set.
  password: z.string().trim().min(4).max(200).nullish(),
});

export const revokeAuditShareLinkSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

/** Public: the share token is the only credential, so no project id. */
export const getSharedAuditReportSchema = z.object({
  shareToken: z.string().min(8).max(128),
  password: z.string().max(200).nullish(),
  viewToken: z.string().max(400).nullish(),
});

// ─── URL search params schema for /p/$projectId/audit ────────────────────────

const auditTabs = ["issues", "pages", "performance"] as const;

export const auditSearchSchema = z.object({
  auditId: z.string().optional().catch(undefined),
  tab: z.enum(auditTabs).catch("issues").default("issues"),
});
