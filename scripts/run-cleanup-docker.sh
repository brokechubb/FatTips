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

# Ensure the script is in the container (copy if needed)
if ! docker exec fattips-bot test -f /app/scripts/cleanup-airdrops.js; then
    docker exec -u root fattips-bot mkdir -p /app/scripts
    docker cp /opt/FatTips/scripts/cleanup-airdrops.js fattips-bot:/app/scripts/cleanup-airdrops.js
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

# Run the cleanup script inside the container with all required arguments
# Run from /app/scripts so node can find the locally installed node_modules
docker exec fattips-bot sh -c "cd /app/scripts && node cleanup-airdrops.js \
    '$DESTINATION' \
    '$INTERNAL_DB_URL' \
    '$MASTER_ENCRYPTION_KEY' \
    '$SOLANA_RPC_URL'" 2>&1
