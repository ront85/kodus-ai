# Kodus Server — Operations Guide

## Infrastructure Overview

Kodus is self-hosted on the Matterhorn Hetzner dedicated server, managed via Dokploy.

| Component | Details |
|-----------|---------|
| Server | matterhorn.emorise.com (138.201.205.173) |
| SSH Port | **2222** (not default 22) |
| SSH User | root (key auth) |
| Deploy Tool | Dokploy |
| Compose Location | `/etc/dokploy/compose/kodus-kodusai-oiv1h0/code/` |
| Env File | `/etc/dokploy/compose/kodus-kodusai-oiv1h0/code/.env` |

---

## URLs

| Service | URL |
|---------|-----|
| Web UI | https://kodus.emorise.com |
| API | https://kodus-api.emorise.com |
| Webhooks | https://kodus-webhooks.emorise.com |

---

## Docker Containers

| Container | Role |
|-----------|------|
| `kodus_api_prod` | Backend API (port 3001, exposed 3331) |
| `kodus_worker_prod` | Background job worker |
| `kodus_webhooks_prod` | GitHub/GitLab/Bitbucket webhook receiver (port 3332, exposed 3333) |
| `kodus_web_prod` | Next.js web UI (port 3000) |
| `kodus_postgres_prod` | PostgreSQL 16 database |
| `kodus_mongodb_prod` | MongoDB 8 database |

All containers share the `kodus-kodusai-oiv1h0_kodus-backend-services` Docker bridge network.

---

## SSH Access

```bash
# Connect to server
ssh -p 2222 root@matterhorn.emorise.com

# Run a single command
ssh -p 2222 root@matterhorn.emorise.com "<command>"
```

---

## Checking Container Status

```bash
ssh -p 2222 root@matterhorn.emorise.com "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep kodus"
```

---

## Viewing Logs

```bash
# API logs (most useful for debugging)
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_api_prod --tail 50 2>&1"

# Worker logs
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_worker_prod --tail 50 2>&1"

# Webhook logs
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_webhooks_prod --tail 50 2>&1"

# Web UI logs
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_web_prod --tail 50 2>&1"

# Follow logs live
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_api_prod -f 2>&1"

# Filter out noise (Mongoose/observability spam)
ssh -p 2222 root@matterhorn.emorise.com "docker logs kodus_api_prod --tail 100 2>&1 | grep -v Mongoose | grep -v observability | grep -v metric"
```

---

## Restarting Containers

```bash
# Restart backend services (picks up .env changes if container is recreated)
ssh -p 2222 root@matterhorn.emorise.com "docker restart kodus_api_prod kodus_worker_prod kodus_webhooks_prod"

# Restart web UI
ssh -p 2222 root@matterhorn.emorise.com "docker restart kodus_web_prod"
```

> **Note:** `docker restart` reuses the existing container config and does NOT pick up new env vars.
> To apply .env changes, you must **recreate** the containers (see below).

---

## Applying Environment Variable Changes

Edit the env file, then recreate the affected containers:

```bash
# Edit env file on server
ssh -p 2222 root@matterhorn.emorise.com "nano /etc/dokploy/compose/kodus-kodusai-oiv1h0/code/.env"

# Recreate backend containers with new env
ssh -p 2222 root@matterhorn.emorise.com "
  docker stop kodus_api_prod kodus_worker_prod kodus_webhooks_prod &&
  docker rm kodus_api_prod kodus_worker_prod kodus_webhooks_prod &&
  cd /etc/dokploy/compose/kodus-kodusai-oiv1h0/code &&
  docker compose -p kodus-kodusai-oiv1h0 --env-file .env up -d api worker webhooks
"

# Recreate web container with new env
ssh -p 2222 root@matterhorn.emorise.com "
  docker stop kodus_web_prod && docker rm kodus_web_prod &&
  cd /etc/dokploy/compose/kodus-kodusai-oiv1h0/code &&
  docker compose -p kodus-kodusai-oiv1h0 --env-file .env up -d web
"
```

---

## Verify Env Vars Inside a Container

```bash
# Check GitHub App vars are loaded in API container
ssh -p 2222 root@matterhorn.emorise.com "docker inspect kodus_api_prod --format '{{range .Config.Env}}{{println .}}{{end}}' | grep GITHUB"

# Check web container has install URL
ssh -p 2222 root@matterhorn.emorise.com "docker inspect kodus_web_prod --format '{{range .Config.Env}}{{println .}}{{end}}' | grep GITHUB"
```

---

## Database Access

```bash
# PostgreSQL — list tables
ssh -p 2222 root@matterhorn.emorise.com "docker exec kodus_postgres_prod psql -U kodusdev -d kodus_db -c '\dt'"

# PostgreSQL — query a table
ssh -p 2222 root@matterhorn.emorise.com "docker exec kodus_postgres_prod psql -U kodusdev -d kodus_db -c 'SELECT * FROM organizations;'"

# PostgreSQL — check users
ssh -p 2222 root@matterhorn.emorise.com "docker exec kodus_postgres_prod psql -U kodusdev -d kodus_db -c 'SELECT uuid, email, role, status FROM users;'"

# PostgreSQL — check integrations
ssh -p 2222 root@matterhorn.emorise.com "docker exec kodus_postgres_prod psql -U kodusdev -d kodus_db -c 'SELECT * FROM integrations;'"
```

---

## GitHub App Configuration

The GitHub App (`kodus-emorise`) is configured at:
https://github.com/settings/apps/kodus-emorise

| Setting | Value |
|---------|-------|
| App ID | 2951721 |
| Client ID | Iv23liaZ3q3ND4CV7Kt4 |
| Webhook URL | https://kodus-webhooks.emorise.com/github/webhook |
| Setup URL (callback) | https://kodus.emorise.com/github-integration |

Required repository permissions: **Checks** (R/W), **Contents** (R), **Issues** (R/W), **Metadata** (R), **Pull requests** (R/W)

Subscribed events: Pull request, Pull request review, Pull request review comment, Push

---

## Access Control (Traefik Middleware)

Sign-up is restricted via Traefik middleware at:
`/etc/dokploy/traefik/dynamic/kodus-access-control.yml`

- Web `/sign-up` redirects to `/sign-in`
- API `/auth/signUp` is IP-allowlisted (office + home IPs only)

To update allowed IPs, edit that file and reload Traefik:
```bash
ssh -p 2222 root@matterhorn.emorise.com "docker kill --signal=HUP dokploy-traefik"
```

---

## LLM Provider

Currently configured via `API_LLM_PROVIDER_MODEL=auto` in `.env`.

Supported providers (require API key in `.env`):
- `API_ANTHROPIC_API_KEY` — Anthropic Claude
- `API_OPEN_AI_API_KEY` — OpenAI
- `API_GOOGLE_AI_API_KEY` — Google Gemini
- `API_OPENROUTER_KEY` — OpenRouter (recommended: access to all models, pay-per-use)
