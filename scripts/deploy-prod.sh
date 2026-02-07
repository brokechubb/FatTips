#!/bin/bash
set -e

# Configuration
SERVER_USER="chubb"
SERVER_HOST="codestats.gg"
SERVER_PORT="1337"
REMOTE_DIR="/opt/FatTips"

echo "🚀 Deploying FatTips to production (Local Build Strategy)..."

# 1. Build Docker images locally
echo "🏗️  Building Docker images locally..."
docker compose build

# 2. Upload Images to Server
echo "📤 Uploading compressed images to production..."
# Save both images, compress with gzip, and pipe to remote docker load
docker save fattips-bot:latest fattips-api:latest | gzip | ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST "gunzip | docker load"

# 3. Sync Configuration Files
echo "📦 Syncing configuration files..."
# We only need docker-compose.yml and scripts, NOT the source code
rsync -avz -e "ssh -p $SERVER_PORT" \
  docker-compose.yml \
  scripts/ \
  package.json \
  pnpm-lock.yaml \
  $SERVER_USER@$SERVER_HOST:$REMOTE_DIR/

# 4. Restart Services on Remote
echo "🔄 Restarting services on server..."
ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST << EOF
  cd $REMOTE_DIR
  
  echo "🚀 Starting services with new images..."
  docker compose up -d
  
  # 5. Run Migrations
  echo "🐘 Running database migrations..."
  # Wait for DB to be ready
  sleep 5
  docker compose exec -T bot pnpm --filter fattips-database migrate:prod
  
  echo "🧹 Cleaning up unused images..."
  docker image prune -f
  
  echo "✅ Deployment complete!"
  docker compose ps
EOF
