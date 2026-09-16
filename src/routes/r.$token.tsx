import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { SharedReportView } from "@/client/features/audit/share/SharedReportView";
import type { SharedReportEndpointResult } from "@/server/features/audit/services/sharedReportEndpoint";

/**
 * Public, read-only audit report.
 *
 * Deliberately outside every authenticated layout: the share token in the path
 * is the credential, so a recipient with no account (and no access to the
 * workspace) can open it.
 *
 * Rendered client-side against a plain API route rather than through a route
 * loader and a server function. Server functions all run the global function
 * middleware (see src/start.ts), which includes ensureUser — so a "public"
 * server function is not actually public, and an anonymous recipient hit the
 * auth path instead of the report. The API route carries no such middleware,
 * and using it for both the first load and the password unlock keeps one code
 * path for one piece of data.
 */
export const Route = createFileRoute("/r/$token")({
  ssr: false,
  component: SharedReportPage,
});

async function fetchSharedReport(
  shareToken: string,
  password?: string,
): Promise<SharedReportEndpointResult> {
  const response = await fetch("/api/audit/shared-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shareToken, password }),
  });
  if (!response.ok) throw new Error("Could not open the report");
  return response.json();
}

function SharedReportPage() {
  const { token } = Route.useParams();
  const [unlocked, setUnlocked] = useState<SharedReportEndpointResult | null>(
    null,
  );

  const initial = useQuery({
    queryKey: ["shared-report", token],
    queryFn: () => fetchSharedReport(token),
    // The token either opens the report or it does not; retrying a miss just
    // delays the "not available" card.
    retry: false,
    refetchOnWindowFocus: false,
  });

  const unlock = useMutation({
    mutationFn: (password: string) => fetchSharedReport(token, password),
    onSuccess: setUnlocked,
  });

  const result = unlocked ?? initial.data;

  if (initial.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200/40">
        <Loader2 className="size-6 animate-spin text-base-content/40" />
      </div>
    );
  }

  if (!result || result.state === "not-found") {
    return (
      <CenteredCard title="This report is not available">
        <p className="text-sm text-base-content/60">
          The link may have been revoked, or it was mistyped. Ask whoever shared
          it for a new one.
        </p>
      </CenteredCard>
    );
  }

  if (result.state === "password-required") {
    return (
      <CenteredCard title="This report is password protected">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const password = new FormData(event.currentTarget).get("password");
            if (typeof password === "string" && password) {
              unlock.mutate(password);
            }
          }}
        >
          <label className="form-control">
            <span className="sr-only">Password</span>
            <input
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="Password"
              className="input input-bordered w-full"
            />
          </label>
          {result.wrongPassword && (
            <p className="text-sm text-error">
              That password did not match. Try again.
            </p>
          )}
          {unlock.isError && (
            <p className="text-sm text-error">
              Something went wrong opening the report. Try again.
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={unlock.isPending}
          >
            {unlock.isPending ? "Checking…" : "View report"}
          </button>
        </form>
      </CenteredCard>
    );
  }

  return (
    <SharedReportView
      report={result.report}
      shareToken={token}
      viewToken={result.viewToken}
    />
  );
}

function CenteredCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base-200/40 p-4">
      <div className="w-full max-w-sm rounded-box border border-base-300 bg-base-100 p-6">
        <div className="mb-4 flex items-center gap-2">
          <Lock className="size-4 text-base-content/50" />
          <h1 className="font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
