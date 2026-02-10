#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_USER="chubb"
SERVER_HOST="codestats.gg"
SERVER_PORT="1337"
REMOTE_DIR="/opt/FatTips"

echo "🚀 Deploying FatTips to production (Local Build Strategy)..."

# 0. Create database backup before deployment (SAFETY CRITICAL)
echo "💾 Preparing backup script on remote..."
# Ensure remote scripts dir exists
ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST "mkdir -p $REMOTE_DIR/scripts"

# Upload latest backup script
scp -P $SERVER_PORT -o ConnectTimeout=30 "$SCRIPT_DIR/backup-database.sh" $SERVER_USER@$SERVER_HOST:$REMOTE_DIR/scripts/
scp -P $SERVER_PORT -o ConnectTimeout=30 "$SCRIPT_DIR/cleanup.sh" $SERVER_USER@$SERVER_HOST:$REMOTE_DIR/scripts/

echo "💾 Creating database backup before deployment..."
# Combine chmod and execution to reduce connections and potential hang
ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST "chmod +x $REMOTE_DIR/scripts/backup-database.sh && cd $REMOTE_DIR && ./scripts/backup-database.sh --no-encrypt"

if [ $? -ne 0 ]; then
  echo "❌ Backup failed! Aborting deployment for safety."
  exit 1
fi

echo "✅ Backup created successfully. Proceeding with deployment..."

# 0.5. Pull backup to local machine (offsite copy)
echo "📥 Pulling backup to local machine for offsite storage..."
LOCAL_BACKUP_DIR="$PROJECT_ROOT/backups/offsite"
mkdir -p "$LOCAL_BACKUP_DIR"

# Get the latest backup filename from remote
LATEST_BACKUP=$(ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST "ls -t $REMOTE_DIR/backups/database/*.sql.gz 2>/dev/null | head -1")

if [ -z "$LATEST_BACKUP" ]; then
  echo "⚠️  Warning: Could not find backup file on remote. Continuing with deployment..."
else
  # Download the latest backup
  scp -P $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST:"$LATEST_BACKUP" "$LOCAL_BACKUP_DIR/"
  
  if [ $? -eq 0 ]; then
    echo "✅ Offsite backup saved to: $LOCAL_BACKUP_DIR/$(basename "$LATEST_BACKUP")"
    
    # Keep only last 10 backups locally
    # List full paths sorted by time (newest first), skip first 10, remove the rest
    ls -t "$LOCAL_BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
    echo "🧹 Cleaned up old local backups (keeping 10 most recent)"
  else
    echo "⚠️  Warning: Failed to download backup. Continuing with deployment..."
  fi
fi

# Ensure we're in the project root for subsequent commands
cd "$PROJECT_ROOT"
echo "📂 Working directory for deployment: $(pwd)"

# 1. Build Docker images locally
echo "🏗️  Building Docker images locally..."
# Explicitly build the images defined in docker-compose.yml
docker compose build bot api

# Tag images to ensure consistent naming for upload
docker tag fattips-bot fattips-bot:latest
docker tag fattips-api fattips-api:latest

# 1.5. Pre-cleanup on Remote
echo "🧹 Cleaning up old images on remote to free space..."
# Remove dangling images (previous deployments) and stopped containers
ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST "docker system prune -f"

# 2. Upload Images to Server
echo "📤 Uploading compressed images to production..."
# Save both images, compress with gzip, and pipe to remote docker load
docker save fattips-bot:latest fattips-api:latest | gzip | ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST "gunzip | docker load"

# 3. Sync Configuration Files
echo "📦 Syncing configuration files..."
# We only need docker-compose.yml, scripts, and basic config. Source code is inside the image!
# NOTE: .env is NOT synced - production has its own .env with secrets
# Use --delete to remove files on remote that are not in the source list (cleans up old source code)
rsync -avz -e "ssh -p $SERVER_PORT -o ConnectTimeout=30" --delete \
  --exclude 'logs' \
  docker-compose.yml \
  scripts \
  package.json \
  pnpm-lock.yaml \
  .env.example \
  $SERVER_USER@$SERVER_HOST:$REMOTE_DIR/

# 4. Restart Services on Remote
echo "🔄 Restarting services on server..."
ssh -p $SERVER_PORT -o ConnectTimeout=30 $SERVER_USER@$SERVER_HOST << EOF
  cd $REMOTE_DIR
  
  # Ensure scripts are executable
  chmod +x scripts/*.sh
  
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
  
  echo "🧹 Post-deployment cleanup..."
  docker system prune -f
  
  echo "✅ Deployment complete!"
  docker compose ps
EOF
