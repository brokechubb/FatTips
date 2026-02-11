#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    echo "Usage: $0 <discord_id> [name]"
    echo ""
    echo "Create a wallet and API key for a user on the FatTips API server."
    echo ""
    echo "Arguments:"
    echo "  discord_id   Discord user ID (must have Developer Mode enabled to copy)"
    echo "  name         Optional name for the API key (default: 'Default')"
    echo ""
    echo "Environment Variables:"
    echo "  API_URL      API server URL (default: https://codestats.gg/api)"
    echo "  ADMIN_API_KEY Admin API key (required, reads from .env if not set)"
    echo ""
    echo "Examples:"
    echo "  # Reads ADMIN_API_KEY from .env in current directory"
    echo "  $0 123456789 JakeyBot"
    echo ""
    echo "  # Using custom API URL"
    echo "  API_URL=http://localhost:3001 $0 123456789"

    exit 1
}

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Parse arguments
DISCORD_ID=""
KEY_NAME=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            usage
            ;;
        --url)
            API_URL="$2"
            shift 2
            ;;
        *)
            if [[ -z "$DISCORD_ID" ]]; then
                DISCORD_ID="$1"
            elif [[ -z "$KEY_NAME" ]]; then
                KEY_NAME="$1"
            else
                error "Unknown argument: $1"
            fi
            shift
            ;;
    esac
done

# Validate required arguments
if [[ -z "$DISCORD_ID" ]]; then
    error "Discord ID is required"
fi

if [[ -z "$KEY_NAME" ]]; then
    KEY_NAME="Default"
fi

# Load ADMIN_API_KEY from .env if it exists in current directory or parent directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE=""
for dir in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
    if [[ -f "$dir/.env" ]]; then
        ENV_FILE="$dir/.env"
        break
    fi
done

if [[ -n "$ENV_FILE" ]]; then
    log "Loading ADMIN_API_KEY from: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
fi

# Set defaults
API_URL="${API_URL:-https://codestats.gg/api}"

# Check for admin key
if [[ -z "$ADMIN_API_KEY" ]]; then
    error "ADMIN_API_KEY not found. Set it in .env or as an environment variable"
fi

log "Creating wallet for Discord ID: $DISCORD_ID"
log "API URL: $API_URL"
log "Key name: $KEY_NAME"

# Step 1: Create wallet if it doesn't exist
log "Creating/verifying wallet..."
WALLET_RESPONSE=$(curl -s -X POST "$API_URL/wallet/create" \
    -H "Content-Type: application/json" \
    -d "{\"discordId\": \"$DISCORD_ID\"}")

WALLET_SUCCESS=$(echo "$WALLET_RESPONSE" | grep -o '"success": *[^,}]*' | grep -o 'true')

if [[ "$WALLET_SUCCESS" == "true" ]]; then
    WALLET_PUBKEY=$(echo "$WALLET_RESPONSE" | grep -o '"walletPubkey": *"[^"]*"' | cut -d'"' -f4)
    log "Wallet created/verified: $WALLET_PUBKEY"
else
    WALLET_ERROR=$(echo "$WALLET_RESPONSE" | grep -o '"error": *"[^"]*"' | cut -d'"' -f4)
    if [[ "$WALLET_ERROR" == "User already has a wallet" ]]; then
        log "Wallet already exists"
    else
        error "Failed to create wallet: $WALLET_ERROR"
    fi
fi

# Step 2: Create API key
log "Creating API key..."
KEY_RESPONSE=$(curl -s -X POST "$API_URL/keys/create" \
    -H "X-Admin-API-Key: $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"discordId\": \"$DISCORD_ID\", \"name\": \"$KEY_NAME\"}")

KEY_SUCCESS=$(echo "$KEY_RESPONSE" | grep -o '"success": *[^,}]*' | grep -o 'true')

if [[ "$KEY_SUCCESS" == "true" ]]; then
    API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"apiKey": *"[^"]*"' | cut -d'"' -f4)
    CREATED=$(echo "$KEY_RESPONSE" | grep -o '"createdAt": *"[^"]*"' | cut -d'"' -f4)

    echo ""
    echo "========================================"
    echo -e "${GREEN}API Key Created Successfully!${NC}"
    echo "========================================"
    echo ""
    echo "Discord ID: $DISCORD_ID"
    echo "Key Name:   $KEY_NAME"
    echo "Created:    $CREATED"
    echo ""
    echo -e "${RED}WARNING: Copy this key now! It will not be shown again.${NC}"
    echo ""
    echo "$API_KEY"
    echo ""
    echo "========================================"
    echo ""

    # Offer to save to file
    read -p "Save API key to file? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        FILENAME="api_key_${DISCORD_ID}_$(date +%Y%m%d_%H%M%S).txt"
        echo "API Key for Discord ID: $DISCORD_ID" > "$FILENAME"
        echo "Name: $KEY_NAME" >> "$FILENAME"
        echo "Created: $CREATED" >> "$FILENAME"
        echo "" >> "$FILENAME"
        echo "$API_KEY" >> "$FILENAME"
        log "Saved to $FILENAME"
        log "SECURE THIS FILE or delete it after storing the key securely!"
    fi
else
    KEY_ERROR=$(echo "$KEY_RESPONSE" | grep -o '"error": *"[^"]*"' | cut -d'"' -f4)
    error "Failed to create API key: $KEY_ERROR"
fi
