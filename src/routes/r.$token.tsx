import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Lock } from "lucide-react";
import { SharedReportView } from "@/client/features/audit/share/SharedReportView";
import { getSharedAuditReport } from "@/serverFunctions/auditShare";

/**
 * Public, read-only audit report.
 *
 * Deliberately outside every authenticated layout: the share token in the path
 * is the credential, so a recipient with no account (and no access to the
 * workspace) can open it. The loader runs the same unauthenticated server
 * function the password form re-submits to.
 */
export const Route = createFileRoute("/r/$token")({
  loader: async ({ params }) =>
    getSharedAuditReport({ data: { shareToken: params.token } }),
  component: SharedReportPage,
});

function SharedReportPage() {
  const initial = Route.useLoaderData();
  const { token } = Route.useParams();
  const [unlocked, setUnlocked] = useState<typeof initial | null>(null);
  const result = unlocked ?? initial;

  // Not the server function: those POST to /_serverFn, which the self-host
  // Basic-auth guard protects, and a share-link recipient has no credentials
  // for it. The loader above can use it because it runs during SSR.
  const unlock = useMutation({
    mutationFn: async (password: string): Promise<typeof initial> => {
      const response = await fetch("/api/audit/shared-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareToken: token, password }),
      });
      if (!response.ok) throw new Error("Could not open the report");
      return response.json();
    },
    onSuccess: setUnlocked,
  });

  if (result.state === "not-found") {
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
