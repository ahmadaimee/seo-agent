# Lighthouse via PageSpeed Insights (free)

Site audits run Lighthouse on every sampled page, in both mobile and desktop
strategies. On the DataForSEO path that is the single largest source of credit
spend in an audit. Google's **PageSpeed Insights (PSI) v5** API runs the same
Lighthouse and returns the same report, for free.

## Configuration

| Variable              | Values                      | Default                                                             |
| --------------------- | --------------------------- | ------------------------------------------------------------------- |
| `LIGHTHOUSE_PROVIDER` | `pagespeed` \| `dataforseo` | `pagespeed` when `PAGESPEED_API_KEY` is set, otherwise `dataforseo` |
| `PAGESPEED_API_KEY`   | a Google API key            | unset                                                               |

The default keeps existing deployments on DataForSEO until they opt in. Setting
`LIGHTHOUSE_PROVIDER=pagespeed` works with or without a key.

Get a key at <https://console.cloud.google.com/apis/credentials> and enable the
"PageSpeed Insights API". The key is free.

## Quota

- Without a key, PSI rate-limits aggressively — fine for a one-off check,
  not for a 10-page audit running two strategies each. Expect failed Lighthouse
  rows.
- With a free key, the quota is roughly **25,000 requests/day** (and about 240
  per minute), far beyond what audits need.

## Limits

- PSI runs from Google's infrastructure, so it **cannot reach `localhost`,
  private IPs, or any site behind a VPN, firewall or auth wall**. Audit those
  with `LIGHTHOUSE_PROVIDER=dataforseo`, or accept failed Lighthouse rows.
- PSI is slow: 20-60s per URL is normal. The client allows up to 120s.

## No fallback, by design

A PSI failure (timeout, quota, unreachable URL) is reported on the audit row as
a failed Lighthouse check. It is **never** retried against DataForSEO — an
automatic fallback would spend exactly the credits this option exists to avoid.

The startup preflight and `/api/health` both report which provider is active
and whether it is billable, under the `lighthouse` check.
