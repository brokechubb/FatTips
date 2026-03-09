#!/bin/bash
set -e

# Configuration
LOG_DIR="./logs/bot"
BACKUP_DIR="./backups/database"
KEEP_BACKUPS=5

echo "🧹 Starting aggressive cleanup..."

# 1. Docker Cleanup
# Remove all unused containers, networks, images (both dangling and unreferenced), and optionally build cache
echo "🐳 Pruning Docker system (unused images, containers, networks)..."
# -a: Remove all unused images, not just dangling ones
# -f: Force, do not prompt
docker system prune -a -f

# 2. Log Cleanup
if [ -d "$LOG_DIR" ]; then
  echo "📄 Truncating log files in $LOG_DIR..."
  # Truncate files larger than 10MB to 0 (or just delete old ones)
  find "$LOG_DIR" -name "*.log" -type f -size +10M -exec truncate -s 0 {} \;
  
  # Remove rotated logs (e.g. app.log.1, app.log.2023-01-01) older than 7 days
  find "$LOG_DIR" -type f -mtime +7 -name "*.log.*" -delete
else
  echo "⚠️ Log directory $LOG_DIR not found, skipping."
fi

# 3. Backup Cleanup (Remote)
if [ -d "$BACKUP_DIR" ]; then
  echo "💾 Cleaning old database backups (keeping last $KEEP_BACKUPS)..."
  # List files, sort by time (oldest first), exclude the last N, delete the rest
  find "$BACKUP_DIR" -name "*.sql.gz" -type f -printf '%T@ %p\n' | \
    sort -n | \
    head -n -"$KEEP_BACKUPS" | \
    cut -d' ' -f2- | \
    xargs -r rm -f
else
  echo "⚠️ Backup directory $BACKUP_DIR not found, skipping."
fi

# 4. Temp Files
echo "🗑️ Cleaning temporary files..."
rm -rf /tmp/* 2>/dev/null || true

echo "✨ Cleanup complete! Checking disk usage..."
df -h .
docker system df
