#!/bin/bash
# Wrapper script to run airdrop cleanup inside Docker container
# This is called by cron

set -e

# Navigate to project directory
cd /opt/FatTips

# Source environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Build arguments for the cleanup script:
# 1. CLEANUP_DESTINATION (or use default: 9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY)
# 2. DATABASE_URL - use internal Docker network address
# 3. MASTER_ENCRYPTION_KEY
# 4. SOLANA_RPC_URL

DESTINATION="${CLEANUP_DESTINATION:-9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY}"
INTERNAL_DB_URL="postgresql://fattips_user:${POSTGRES_PASSWORD}@postgres:5432/fattips"

echo "Running airdrop cleanup..."
echo "  Destination: $DESTINATION"
echo "  Database: using internal Docker network"

# Install dependencies in container if needed, then run cleanup
# Using NODE_PATH to point to installed modules
docker exec fattips-bot sh -c '
  set -e
  DEPS_DIR="/tmp/cleanup-deps"
  
  # Install dependencies if not present
  if [ ! -d "$DEPS_DIR/node_modules" ]; then
    echo "Installing dependencies in container..."
    mkdir -p "$DEPS_DIR"
    cd "$DEPS_DIR"
    npm init -y >/dev/null 2>&1
    npm install --silent pg @solana/web3.js @solana/spl-token >/dev/null 2>&1
    echo "Dependencies installed."
  fi
  
  # Copy latest script to deps dir
  cp /app/scripts/cleanup-airdrops.js "$DEPS_DIR/" 2>/dev/null || true
  
  # Run with NODE_PATH pointing to modules
  cd "$DEPS_DIR"
  NODE_PATH="$DEPS_DIR/node_modules" node cleanup-airdrops.js \
    "'"$DESTINATION"'" \
    "'"$INTERNAL_DB_URL"'" \
    "'"$MASTER_ENCRYPTION_KEY"'" \
    "'"$SOLANA_RPC_URL"'"
' 2>&1
