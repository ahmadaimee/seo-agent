# Railway Self-Hosting

Run S.E.O Agent on [Railway](https://railway.com). This fork is self-host only: no S.E.O Agent account, no subscription, no telemetry. The only external cost is DataForSEO, billed to you directly per API call.

`railway.json` in the repo root already tells Railway what to do — build the `Dockerfile.selfhost` image, health-check `/api/health`, and restart on failure. You supply a volume and a handful of variables.

## Prerequisites

- A Railway account with a project you can deploy into
- A DataForSEO API key (see [`DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md))

## Deploy

1. **Create the service.** In your Railway project: *New → GitHub Repo →* this repository. Railway reads `railway.json` and builds from `Dockerfile.selfhost`; no builder settings to change.

2. **Add a volume — do this before the first successful boot.** The SQLite (D1) database lives inside the container at `/app/.wrangler`. Without a volume mounted there, every redeploy starts from an empty database and all projects, audits and saved keywords are gone.

   *Service → Variables → Volumes → New Volume*, mount path `/app/.wrangler`.

3. **Set variables.** *Service → Variables*:

   | Variable | Required | Notes |
   |---|---|---|
   | `DATAFORSEO_API_KEY` | yes | base64 of `login:password` — see the [key guide](./DATAFORSEO_API_KEY.md) |
   | `SELFHOST_BASIC_AUTH_USER` | strongly recommended | see [Protect the deployment](#protect-the-deployment) |
   | `SELFHOST_BASIC_AUTH_PASSWORD` | strongly recommended | |
   | `ALLOWED_HOST` | yes, once you have a domain | hostnames the app will answer on, comma-separated — e.g. `seo-agent-production.up.railway.app,seo.example.com` |
   | `OPENROUTER_API_KEY` | optional | enables SAM, the in-app chat agent |
   | `OPENROUTER_MODEL` | optional | overrides the default model |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `BETTER_AUTH_SECRET` | optional | Search Console and GA4 — see [`SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`](./SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md) |

   `PORT` is injected by Railway; leave it unset. `AUTH_MODE`, `CLOUDFLARE_INCLUDE_PROCESS_ENV` and the telemetry opt-outs are baked into the image and need no entry here.

4. **Generate a domain.** *Service → Settings → Networking → Generate Domain*, then put that hostname in `ALLOWED_HOST` and redeploy. Vite's preview server rejects requests for hostnames it was not told about, so a missing `ALLOWED_HOST` shows up as a blocked-host error rather than the app. To serve your own domain instead, see [Use your own domain](#use-your-own-domain).

The first deploy runs migrations and a full build inside the container and takes several minutes; `railway.json` allows 900 seconds for the health check to pass. Later deploys reuse the previous build when no build-relevant variable changed.

## Use your own domain

Railway serves the app on a `*.up.railway.app` subdomain by default. Moving it to your own domain is two changes — one at Railway, one in the app's variables — and the second is the one people forget.

1. **Add the domain at Railway.** *Service → Settings → Networking → Custom Domain*, enter the hostname you want (`seo.example.com`). Railway shows a CNAME target that looks like `abc123.up.railway.app`.

2. **Create the DNS record at your registrar.**

   | Record | Name | Value |
   |---|---|---|
   | CNAME | `seo` (the subdomain) | the target Railway showed you |

   A subdomain is the straightforward case. For an apex/root domain (`example.com` with no subdomain) your DNS provider has to support CNAME flattening or ALIAS records — Cloudflare, Netlify DNS and Route 53 do; many registrars do not. If yours does not, use a subdomain.

   If you are on Cloudflare, set the record to **DNS only** (grey cloud) until Railway reports the domain as active. Proxying it (orange cloud) before the certificate is issued makes the validation fail.

3. **Add the hostname to `ALLOWED_HOST`.** This is the step that bites: the app runs behind Vite's preview server, which rejects any `Host` header it was not told about, so a correctly configured domain still returns a blocked-host error until you list it.

   Keep both hostnames during the cutover:

   ```
   ALLOWED_HOST=seo-agent-production.up.railway.app,seo.example.com
   ```

   Saving the variable redeploys the service. Once you are happy on the new domain you can drop the Railway subdomain from the list.

4. **Re-point anything that hardcoded the old URL:**

   - Google OAuth redirect URIs, if you use Search Console or GA4 — add `https://seo.example.com/api/gsc/oauth/callback` and `.../api/ga4/oauth/callback` to your OAuth client (see [`SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`](./SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md)). Google matches these exactly — scheme, host and no trailing slash.
   - `SEO_AGENT_MCP_URL` on any machine running the Claude Code plugin.
   - Audit share links already handed out: those are path-based (`/r/<token>`), so they keep working on whichever hostname the recipient uses, as long as it is in `ALLOWED_HOST`.

Railway issues and renews the TLS certificate itself; there is nothing to configure and no certificate to upload.

### If the domain does not come up

**"Blocked request" or an invalid-host error.** `ALLOWED_HOST` does not contain the hostname you typed in the browser. Check for a stray space, and remember `www.example.com` and `example.com` are different entries.

**Railway shows the domain as pending for a long time.** DNS has not propagated, or a proxy is in front of the validation. `dig CNAME seo.example.com` should return Railway's target; on Cloudflare, switch the record to DNS-only.

**The site loads but Google sign-in fails with `redirect_uri_mismatch`.** Step 4 — the new origin is not registered on the OAuth client.

## Protect the deployment

S.E.O Agent runs in `AUTH_MODE=local_noauth`: there is no sign-in, and anyone who reaches the URL has full access to your projects and your DataForSEO spend. A Railway domain is public.

Set `SELFHOST_BASIC_AUTH_USER` and `SELFHOST_BASIC_AUTH_PASSWORD` to put HTTP Basic auth in front of everything except `/api/health` (left open for Railway's health check) and shared audit reports, which carry their own token in the URL. Do this before you put a real DataForSEO key on a public URL.

To reach the MCP server from Claude Code through Basic auth, set these on your own machine:

- `SEO_AGENT_MCP_URL` — `https://your-host/mcp`
- `SEO_AGENT_MCP_AUTH` — `Basic <base64 of user:password>`

## Updating

Push to the branch the service tracks; Railway rebuilds and redeploys. Database migrations run on container start, before the app serves traffic.

## Health and troubleshooting

`/api/health` reports configuration and database status without auth, so `curl https://your-host/api/health` is the first thing to check. Startup validation (the preflight) prints to the deploy logs before the build and names the exact variable when something is missing.

**Data disappeared after a deploy.** The volume is missing or mounted somewhere other than `/app/.wrangler`. Check *Service → Volumes*.

**"Blocked request" / invalid host.** `ALLOWED_HOST` does not match the hostname you are visiting.

**Everything works but no SEO data.** Usually `DATAFORSEO_API_KEY` is not base64-encoded. It must be `printf '%s' 'YOUR_LOGIN:YOUR_PASSWORD' | base64`, not the raw password.

**Build times out.** The SSR build is large; `.npmrc` raises Node's heap ceiling for it. If Railway's build resources are constrained, a larger plan or a longer `healthcheckTimeout` in `railway.json` is the lever.

## Local development

Railway is the deployment target; for working on the code, run it directly with `pnpm dev` — see [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md).

## Telemetry

None. This fork removed the upstream usage heartbeat, MCP call counter and preflight beacon at the source.
