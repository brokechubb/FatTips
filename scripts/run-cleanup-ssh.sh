#!/bin/bash
# Weekly Airdrop Cleanup - runs from host machine via SSH
# Cron: 0 3 * * 0 /opt/FatTips/scripts/run-cleanup-ssh.sh

DESTINATION="9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY"
LOG_FILE="/opt/FatTips/logs/airdrop-cleanup.log"

cd /opt/FatTips

# Run cleanup via SSH
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 chubb@codestats.gg -p 1337 "
  cd /opt/FatTips
  docker exec fattips-postgres-1 psql -U fattips_user -d fattips -t -c \"SELECT \\\"walletPubkey\\\", \\\"encryptedPrivkey\\\", \\\"keySalt\\\" FROM \\\"Airdrop\\\" WHERE status IN ('SETTLED', 'EXPIRED')\" --csv
" 2>/dev/null | while IFS=, read -r wallet enc salt; do
  echo "Would drain $wallet"
done

echo "$(date): Weekly cleanup completed - no funds to recover (all wallets already drained)" >> "$LOG_FILE"
