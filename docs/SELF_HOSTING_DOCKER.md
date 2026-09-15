# Docker Self-Hosting

Run S.E.O Agent locally with Docker. This fork is self-host only: no S.E.O Agent account, no subscription, no telemetry. It builds from source by default and listens on port 3010.

In Docker mode, S.E.O Agent uses `AUTH_MODE=local_noauth` (no auth checks, local admin user `admin@localhost`). Only expose it behind your own auth-protected reverse proxy, tunnel, or private network.

The default `compose.yaml` uses the published GHCR image:

- `seo-agent:local` (built from this repository)

## Prerequisites

- Docker Desktop (or Docker Engine + Docker Compose)
- A DataForSEO API key (see [`DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md))

## Quickstart

```bash
cp .env.example .env
```

Set `DATAFORSEO_API_KEY` in `.env` using the [DataForSEO setup guide](./DATAFORSEO_API_KEY.md), then start S.E.O Agent:

```bash
docker compose up -d --build
```

Open `http://localhost:<PORT>` (default `3010`). The first start builds the app and may take 1-2 minutes; follow progress with `docker compose logs -f`.

Optional env values:

- `PORT` (defaults to `3001`)
- `ALLOWED_HOST` (single reverse-proxy hostname to allow in Vite preview)
- `AUTH_MODE=local_noauth` (already set in compose)
- `SEO_AGENT_IMAGE` (defaults to `seo-agent:local` (built from this repository))
- `OPENROUTER_API_KEY` (required for AI features such as SAM; see [OpenRouter](https://openrouter.ai/settings/keys))

If you are putting Docker behind a reverse proxy or a temporary tunnel, remember that Docker self-hosting runs with app auth disabled. Only expose it behind your own auth-protected reverse proxy, tunnel, or private network, and add the public hostname before restarting:

```bash
ALLOWED_HOST=yourdomain.com docker compose up -d
```

You can also persist it in `.env`.

## Telemetry

None. This fork removed the upstream usage heartbeat, MCP call counter and preflight beacon at the source; nothing is sent to PostHog or github.com/ahmadaimee/seo-agent.

## Pin to a specific image tag

Set `SEO_AGENT_IMAGE` in `.env` and restart:

```bash
SEO_AGENT_IMAGE=ghcr.io/ahmadaimee/seo-agent:v1.2.3
docker compose up -d --build
```

## Build your own image locally

If you are testing local code changes, build and run a local tag:

```bash
docker build -f Dockerfile.selfhost -t seo-agent:local .
SEO_AGENT_IMAGE=seo-agent:local docker compose up -d
```

## Common commands

- Restart service after env changes:

```bash
docker compose up -d seo-agent
```

- Pull latest published image and restart:

```bash
docker compose pull && docker compose up -d
```

- Stop:

```bash
docker compose down
```

## Health and troubleshooting

Startup checks appear in `docker compose logs` before the build. Once running, `/api/health` reports configuration and database status, and `docker compose ps` reports container health.

## Troubleshooting environment variables

To confirm Docker Compose is using the expected environment variables:

```bash
docker compose config
```

Check that `AUTH_MODE=local_noauth`, and that `DATAFORSEO_API_KEY` is the base64
encoded value of your DataForSEO email and API password in this format:
`email:password`.

If you changed `.env`, recreate the container so Compose reapplies it:

```bash
docker compose up -d --force-recreate seo-agent
```
