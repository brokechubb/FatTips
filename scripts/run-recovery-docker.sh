#!/bin/bash
# Airdrop Fund Recovery Script
# Recovers stranded funds from failed/settled airdrop pool wallets.
# Safe to run as a weekly cron job.
#
# Cron example (runs Sundays at 4 AM):
#   0 4 * * 0 /opt/FatTips/scripts/run-recovery-docker.sh >> /opt/FatTips/logs/recovery.log 2>&1

LOG_DIR="/opt/FatTips/logs"
mkdir -p "$LOG_DIR"

echo ""
echo "========================================"
echo "  Airdrop Fund Recovery — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"
echo ""

# Navigate to project directory
cd /opt/FatTips

# Source environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Validate required env vars
if [ -z "$POSTGRES_PASSWORD" ] || [ -z "$MASTER_ENCRYPTION_KEY" ] || [ -z "$SOLANA_RPC_URL" ]; then
    echo "❌ Error: Missing required environment variables (POSTGRES_PASSWORD, MASTER_ENCRYPTION_KEY, SOLANA_RPC_URL)"
    exit 1
fi

# Check if Docker container is running
if ! docker ps --format '{{.Names}}' | grep -q "^fattips-bot$"; then
    echo "❌ Error: fattips-bot container is not running"
    echo "   Start services with: docker-compose up -d"
    exit 1
fi

echo "✓ Docker container is running"
echo ""

# Copy the recovery script to the container
echo "📁 Copying recovery script to container..."
docker cp /opt/FatTips/scripts/recover-airdrop-funds.js fattips-bot:/app/scripts/recover-airdrop-funds.js
echo "✓ Script copied"
echo ""

# Set up internal database URL (container-network hostname)
INTERNAL_DB_URL="postgresql://fattips_user:${POSTGRES_PASSWORD}@postgres:5432/fattips"

echo "🔑 Environment:"
echo "   Database: postgres (Docker network)"
echo "   RPC: ${SOLANA_RPC_URL}"
echo ""

# Install npm dependencies inside the container only if not already present.
# /tmp/recovery persists for the container's lifetime, so subsequent runs are instant.
echo "📦 Checking script dependencies..."
docker exec fattips-bot sh -c "
  if [ ! -d /tmp/recovery/node_modules/@solana ]; then
    echo '  Installing dependencies (first run)...'
    mkdir -p /tmp/recovery
    cd /tmp/recovery
    npm init -y > /dev/null 2>&1
    npm install pg @solana/web3.js @solana/spl-token --save > /dev/null 2>&1
    echo '  ✓ Dependencies installed'
  else
    echo '  ✓ Dependencies already present'
  fi
"
echo ""

# Run the recovery script
echo "💰 Running recovery..."
echo "----------------------------------------"
docker exec fattips-bot sh -c "
  NODE_PATH=/tmp/recovery/node_modules \
  DATABASE_URL='$INTERNAL_DB_URL' \
  MASTER_ENCRYPTION_KEY='$MASTER_ENCRYPTION_KEY' \
  SOLANA_RPC_URL='$SOLANA_RPC_URL' \
  node /app/scripts/recover-airdrop-funds.js
"
EXIT_CODE=$?
echo "----------------------------------------"
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Recovery complete"
else
    echo "❌ Recovery exited with code $EXIT_CODE"
fi

exit $EXIT_CODE
