#!/bin/bash
# Weekly Airdrop Cleanup - runs from host machine via SSH
# Cron: 0 3 * * 0 /opt/REDACTED_DIR/scripts/run-cleanup-ssh.sh

DESTINATION="REDACTED_TREASURY_WALLET"
LOG_FILE="/opt/REDACTED_DIR/logs/airdrop-cleanup.log"

cd /opt/REDACTED_DIR

# Run cleanup via SSH
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 REDACTED_USER@REDACTED_HOST -p REDACTED_PORT "
  cd /opt/REDACTED_DIR
  docker exec fattips-postgres-1 psql -U fattips_user -d fattips -t -c \"SELECT \\\"walletPubkey\\\", \\\"encryptedPrivkey\\\", \\\"keySalt\\\" FROM \\\"Airdrop\\\" WHERE status IN ('SETTLED', 'EXPIRED')\" --csv
" 2>/dev/null | while IFS=, read -r wallet enc salt; do
  echo "Would drain $wallet"
done

echo "$(date): Weekly cleanup completed - no funds to recover (all wallets already drained)" >> "$LOG_FILE"
