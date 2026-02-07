#!/bin/bash
set -e

# Configuration
SERVER_USER="chubb"
SERVER_HOST="codestats.gg"
SERVER_PORT="1337"
REMOTE_DIR="/opt/FatTips"

echo "🚀 Deploying FatTips to production..."

# 1. Sync files to server (excluding node_modules, logs, etc)
echo "📦 Syncing files..."
rsync -avz -e "ssh -p $SERVER_PORT" \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'logs' \
  --exclude '.env' \
  --exclude '.turbo' \
  . $SERVER_USER@$SERVER_HOST:$REMOTE_DIR

# 2. Run remote commands
echo "🔄 Updating services on server..."
ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST << EOF
  cd $REMOTE_DIR
  
  # 3. Rebuild and Restart
  echo "🏗️  Rebuilding Docker images..."
  docker compose down
  docker compose build
  
  echo "Starting services..."
  docker compose up -d
  
  # 4. Run Migrations (inside container to access internal DB network)
  echo "🐘 Running database migrations..."
  # Wait for DB to be ready
  sleep 10
  # We use the 'bot' container to run migrations since it has the code + pnpm
  docker compose exec -T bot pnpm --filter fattips-database migrate:prod
  
  echo "✅ Deployment complete!"
  docker compose ps
EOF
