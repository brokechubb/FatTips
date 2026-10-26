# Deployment Guide

## Prerequisites

- VPS with 4GB RAM, 4 vCPU minimum
- Domain name
- SSL certificate (Let's Encrypt recommended)
- Docker and Docker Compose installed

## Environment Setup

1. Clone repository on VPS
2. Copy `.env.example` to `.env`
3. Configure all environment variables (See `.env.example`)
   - **Important:** Get a free API key from [Jupiter Portal](https://portal.jup.ag) for USD price conversion.
   - **Important:** Get a free API key from [Helius](https://dev.helius.xyz/) for Solana RPC.
4. Set up PostgreSQL database

## Discord Configuration

If setting up your own bot instance in the Discord Developer Portal:

### 1. Scopes & Permissions

- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:**
  - Send Messages
  - Embed Links
  - Attach Files
  - Read Message History
  - Use External Emojis

### 2. Privileged Gateway Intents

FatTips uses two privileged intents and one standard gateway intent:

- **Presence Intent:** OFF
- **Server Members Intent:** ON (Required for role-based rain and member lookups)
- **Message Content Intent:** ON (Required for prefix commands like `ftip`)
- **Guild Voice States:** ON (Standard intent — required for voice channel tips and voice rain: `/vctip`, `/rain voice:true`)

### 3. Installation Contexts

Enable **User Install** to allow users to add the bot to their account.

- **Supported Contexts:** Guild Install, User Install (Guilds, DMs)

## Docker Deployment

```bash
# Build and start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

## SSL Certificate (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot

# Obtain certificate
sudo certbot certonly --standalone -d domain.com

# Auto-renewal is set up automatically
```

## Database Migrations

```bash
# Run migrations
docker-compose exec api pnpm db:migrate

# Check status
docker-compose exec api pnpm db:status
```

## Monitoring

### Error Tracking (Sentry)

FatTips uses **Sentry** for real-time error tracking and performance monitoring.

- **Automatic Error Capture**: Crashes in the bot are automatically sent to Sentry with full stack traces and user context.
- **Performance Monitoring**: Slow endpoints and database queries are tracked to identify bottlenecks.
- **Alerts**: Configure alert rules in Sentry to receive Slack/email notifications when errors spike.

**Access**: Ask the project maintainer for Sentry DSN access.

- Use `docker-compose logs -f bot` to view real-time bot logs
- Consider setting up PM2 or systemd for process management
- Set up monitoring (recommended: UptimeRobot for alerts)

## Backup Strategy

1. Database backups (daily automated)
2. Encrypted wallet database backups
3. Store backups in secure off-site location

## Production Deployment (FatTips)

Production is deployed from a workstation with `scripts/deploy-prod.sh` — the server never builds. It reads its target from `DEPLOY_SERVER_USER`, `DEPLOY_SERVER_HOST`, `DEPLOY_SERVER_PORT` and `DEPLOY_REMOTE_DIR` (set in `.env` or the environment).

The script, in order:

1. Creates a **GPG-encrypted** database backup on the server (key: `fattips-backup`) and pulls a copy into `backups/offsite/`. Encryption is non-interactive because the key lives on the server.
2. Builds `fattips-bot` / `fattips-api` locally on Node 22 with `pnpm install --frozen-lockfile`. `.dockerignore` keeps `.env`, `.git`, `backups/` (production dumps), `node_modules` and local-only ops scripts out of the images — without it they end up in the 1.4GB image that gets shipped to the server.
3. Tags the running images `fattips-bot:rollback` / `fattips-api:rollback`, uploads the new images, and applies migrations **against the new image** before any service restarts.
4. Restarts services and **verifies** them: API `GET /health`, bot logging `Bot logged in as`, and zero container restarts. If any check fails the script exits non-zero and prints the rollback command.

Rollback without re-uploading (~2.8GB):

```bash
ssh -p "$DEPLOY_SERVER_PORT" "$DEPLOY_SERVER_USER@$DEPLOY_SERVER_HOST" \
  'cd /opt/FatTips && docker tag fattips-bot:rollback fattips-bot:latest \
   && docker tag fattips-api:rollback fattips-api:latest && docker compose up -d'
```

**Backup key escrow (required):** backups are encrypted to the server's `fattips-backup` public key. Export the private key once (`gpg --export-secret-keys fattips-backup`) and store it offline, somewhere other than the server — otherwise neither the server-side backups nor the offsite copies can be restored if the server is lost.

## Updates

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker-compose down
docker-compose up -d --build
```

## Troubleshooting

See [GitHub Issues](https://github.com/yourusername/fattips/issues) for common problems.
