# Deployment Guide

## Prerequisites

- VPS with 4GB RAM, 4 vCPU minimum
- Domain name (codestats.gg)
- SSL certificate (Let's Encrypt recommended)
- Docker and Docker Compose installed

## Environment Setup

1. Clone repository on VPS
2. Copy `.env.example` to `.env`
3. Configure all environment variables (See `.env.example`)
   - **Important:** Get a free API key from [Jupiter Portal](https://portal.jup.ag) for USD price conversion.
   - **Important:** Get a free API key from [Helius](https://dev.helius.xyz/) for Solana RPC.
4. Set up PostgreSQL database

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
sudo certbot certonly --standalone -d codestats.gg

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

- Use `docker-compose logs` to view logs
- Consider setting up PM2 or systemd for process management
- Set up monitoring (recommended: UptimeRobot for alerts)

## Backup Strategy

1. Database backups (daily automated)
2. Encrypted wallet database backups
3. Store backups in secure off-site location

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
