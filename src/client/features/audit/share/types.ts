import type { getSharedAuditReport } from "@/serverFunctions/auditShare";

type SharedReportResponse = Awaited<ReturnType<typeof getSharedAuditReport>>;

export type SharedAuditReport = Extract<
  SharedReportResponse,
  { state: "ok" }
>["report"];
