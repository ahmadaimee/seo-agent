import type { SharedReportEndpointResult } from "@/server/features/audit/services/sharedReportEndpoint";

export type SharedAuditReport = Extract<
  SharedReportEndpointResult,
  { state: "ok" }
>["report"];
