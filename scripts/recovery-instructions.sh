#!/bin/bash
# Recovery Instructions for Stuck Airdrop Funds
# 
# IMPORTANT: The funds may be unrecoverable without the private keys
# This script helps you identify what was lost and check if any logs exist

echo "🔍 Airdrop Fund Recovery Assistant"
echo "=================================="
echo ""
echo "From your logs, I can see:"
echo "  - Transaction: 3ETpEoS25CF7A8XP9JThvuhCi4PgqMruBL8mnS9RQd7P51kWeSraTFobPoSfqai7qkiYA1CHK9UoQNYxzeHuoiJx"
echo "  - Amount: ~0.151 SOL"
echo "  - User Discord ID: 921423957377310720"
echo ""

# Step 1: Look up the transaction on-chain
echo "Step 1: Looking up transaction on Solana..."
echo "You can manually check this transaction at:"
echo "  https://solscan.io/tx/3ETpEoS25CF7A8XP9JThvuhCi4PgqMruBL8mnS9RQd7P51kWeSraTFobPoSfqai7qkiYA1CHK9UoQNYxzeHuoiJx"
echo ""

# Step 2: Check for any log files that might have captured the wallet address
echo "Step 2: Checking for ephemeral wallet in logs..."
echo ""
echo "Searching for wallet generation logs..."

# Search for wallet generation patterns in logs
if [ -f "logs/bot.log" ]; then
    echo "Found logs/bot.log - searching..."
    grep -n "ephemeral\|EphemeralWallet\|createEncryptedWallet" logs/bot.log | tail -20 || echo "No matches in logs/bot.log"
fi

if [ -f "logs/app.log" ]; then
    echo "Found logs/app.log - searching..."
    grep -n "ephemeral\|EphemeralWallet\|createEncryptedWallet" logs/app.log | tail -20 || echo "No matches in logs/app.log"
fi

# Check Docker logs if available
if command -v docker &> /dev/null; then
    echo ""
    echo "Checking Docker logs..."
    docker logs fattips-bot 2>&1 | grep -i "ephemeral\|airdrop.*wallet\|publicKey" | tail -20 || echo "No Docker logs or no matches"
fi

echo ""
echo "⚠️  CRITICAL INFORMATION:"
echo "========================"
echo ""
echo "When the airdrop verification failed, the ephemeral wallet's private key"
echo "was lost because it was never saved to the database."
echo ""
echo "To find the stuck funds:"
echo "1. Visit: https://solscan.io/tx/3ETpEoS25CF7A8XP9JThvuhCi4PgqMruBL8mnS9RQd7P51kWeSraTFobPoSfqai7qkiYA1CHK9UoQNYxzeHuoiJx"
echo "2. Look for the 'To' address in the transfer - that's the ephemeral wallet"
echo "3. Check that wallet's balance on Solscan"
echo ""
echo "🚨 UNFORTUNATELY: Without the private key, these funds cannot be recovered."
echo ""
echo "✅ PREVENTION: The fix has been applied that:"
echo "  1. Waits for transaction confirmation before balance verification"
echo "  2. Retries balance check up to 5 times with 1-second delays"
echo "  3. This should prevent future occurrences of this issue"
echo ""
echo "💡 RECOMMENDATION: Consider implementing a 'pending_funding' status for"
echo "   airdrops that saves the ephemeral wallet BEFORE funding, allowing"
echo "   recovery if verification fails."
echo ""
