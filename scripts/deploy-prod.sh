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
# Explicitly build the images defined in docker-compose.yml
docker compose build bot api

# Tag images to ensure consistent naming for upload
docker tag fattips-bot fattips-bot:latest
docker tag fattips-api fattips-api:latest

# 2. Upload Images to Server
echo "📤 Uploading compressed images to production..."
# Save both images, compress with gzip, and pipe to remote docker load
docker save fattips-bot:latest fattips-api:latest | gzip | ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST "gunzip | docker load"

# 3. Sync Configuration Files
echo "📦 Syncing configuration files..."
# We only need docker-compose.yml, scripts, and basic config. Source code is inside the image!
# Use --delete to remove files on remote that are not in the source list (cleans up old source code)
rsync -avz -e "ssh -p $SERVER_PORT" --delete \
  --exclude 'logs' \
  docker-compose.yml \
  scripts \
  package.json \
  .env \
  pnpm-lock.yaml \
  .env.example \
  $SERVER_USER@$SERVER_HOST:$REMOTE_DIR/

# 4. Restart Services on Remote
echo "🔄 Restarting services on server..."
ssh -p $SERVER_PORT $SERVER_USER@$SERVER_HOST << EOF
  cd $REMOTE_DIR
  
  # Ensure scripts are executable
  chmod +x scripts/deploy-prod.sh
  
  # CLEANUP: Remove source code directories (now unused as we use pre-built images)
  echo "🧹 Removing unused source code..."
  rm -rf apps packages programs docker docs
  
  echo "🚀 Starting services with new images..."
  # Use the images we just loaded
  docker compose up -d
  
  # 5. Run Migrations
  echo "🐘 Running database migrations..."
  sleep 10
  docker compose exec -T bot pnpm --filter fattips-database migrate:prod
  
  echo "🧹 Cleaning up..."
  docker image prune -f
  
  echo "✅ Deployment complete!"
  docker compose ps
EOF
