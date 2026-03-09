#!/bin/bash
# Emergency Fund Recovery Script
# Run this on the production server to recover funds from failed airdrops

set -e

echo "🚨 Emergency Airdrop Fund Recovery"
echo "=================================="
echo ""

# Navigate to project directory
cd /opt/FatTips

# Source environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Check if Docker is running
if ! docker ps | grep -q "fattips-bot"; then
    echo "❌ Error: fattips-bot container is not running!"
    echo "Please start the services first with: docker-compose up -d"
    exit 1
fi

echo "✓ Docker container is running"
echo ""

# Copy the recovery script to the container
echo "📁 Copying recovery script to container..."
docker cp /opt/FatTips/scripts/recover-airdrop-funds.js fattips-bot:/app/scripts/recover-airdrop-funds.js
echo "✓ Script copied"
echo ""

# Set up internal database URL
INTERNAL_DB_URL="postgresql://fattips_user:${POSTGRES_PASSWORD}@postgres:5432/fattips"

echo "🔑 Environment setup:"
echo "  Database: Using internal Docker network"
echo "  RPC: ${SOLANA_RPC_URL}"
echo ""

# Run the recovery script inside the container
echo "💰 Running recovery script..."
echo "=================================="
docker exec fattips-bot sh -c "cd /app/scripts && DATABASE_URL='$INTERNAL_DB_URL' MASTER_ENCRYPTION_KEY='$MASTER_ENCRYPTION_KEY' SOLANA_RPC_URL='$SOLANA_RPC_URL' node recover-airdrop-funds.js" 2>&1

echo ""
echo "=================================="
echo "✅ Recovery process complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Check the transaction signatures above"
echo "  2. Verify funds arrived in your wallet"
echo "  3. Check Discord for any notifications"
