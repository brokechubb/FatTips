#!/bin/bash

# FatTips Automated Backup Setup Script
# Sets up automated database backups using cron
# Usage: ./scripts/setup-backup-cron.sh

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-database.sh"
CRON_FILE="/tmp/fattips-cron"

# Function to print colored output
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if backup script exists
if [ ! -f "$BACKUP_SCRIPT" ]; then
    log_error "Backup script not found: ${BACKUP_SCRIPT}"
    exit 1
fi

# Make sure backup script is executable
chmod +x "$BACKUP_SCRIPT"

log_info "FatTips Automated Backup Setup"
echo ""
log_info "This script will set up automated database backups using cron."
echo ""

# Show current cron jobs
log_info "Current cron jobs for ${USER}:"
crontab -l 2>/dev/null || echo "  (none)"
echo ""

# Ask user for backup schedule
echo "Choose a backup schedule:"
echo "  1) Every hour"
echo "  2) Every 6 hours"
echo "  3) Daily at 2 AM"
echo "  4) Daily at midnight"
echo "  5) Twice daily (midnight and noon)"
echo "  6) Custom cron expression"
echo ""
read -p "Select option (1-6): " schedule_option

case $schedule_option in
    1)
        CRON_SCHEDULE="0 * * * *"
        SCHEDULE_DESC="every hour"
        ;;
    2)
        CRON_SCHEDULE="0 */6 * * *"
        SCHEDULE_DESC="every 6 hours"
        ;;
    3)
        CRON_SCHEDULE="0 2 * * *"
        SCHEDULE_DESC="daily at 2 AM"
        ;;
    4)
        CRON_SCHEDULE="0 0 * * *"
        SCHEDULE_DESC="daily at midnight"
        ;;
    5)
        CRON_SCHEDULE="0 0,12 * * *"
        SCHEDULE_DESC="twice daily (midnight and noon)"
        ;;
    6)
        read -p "Enter custom cron expression (e.g., '0 3 * * *'): " CRON_SCHEDULE
        SCHEDULE_DESC="custom schedule: ${CRON_SCHEDULE}"
        ;;
    *)
        log_error "Invalid option"
        exit 1
        ;;
esac

echo ""
log_info "Selected schedule: ${SCHEDULE_DESC}"
log_info "Cron expression: ${CRON_SCHEDULE}"
echo ""

# Create cron job entry
CRON_ENTRY="${CRON_SCHEDULE} ${BACKUP_SCRIPT} >> /tmp/fattips-backup.log 2>&1"

# Show what will be added
log_warn "The following cron job will be added:"
echo "  ${CRON_ENTRY}"
echo ""
read -p "Continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    log_info "Setup cancelled"
    exit 0
fi

# Add cron job
log_info "Adding cron job..."

# Get existing crontab (if any)
crontab -l 2>/dev/null > "$CRON_FILE" || true

# Remove any existing FatTips backup jobs
sed -i '/fattips.*backup-database\.sh/d' "$CRON_FILE" 2>/dev/null || true

# Add new cron job with comment
echo "# FatTips Database Backup - ${SCHEDULE_DESC}" >> "$CRON_FILE"
echo "$CRON_ENTRY" >> "$CRON_FILE"

# Install new crontab
crontab "$CRON_FILE"
rm "$CRON_FILE"

log_info "✅ Cron job installed successfully!"
echo ""
log_info "Backup schedule: ${SCHEDULE_DESC}"
log_info "Logs will be written to: /tmp/fattips-backup.log"
echo ""
log_info "To view your cron jobs: crontab -l"
log_info "To remove this cron job: crontab -e (then delete the FatTips backup line)"
echo ""

# Optionally run a test backup
read -p "Run a test backup now? (yes/no): " run_test

if [ "$run_test" = "yes" ]; then
    log_info "Running test backup..."
    "$BACKUP_SCRIPT"
    echo ""
    log_info "✅ Test backup complete!"
fi

log_info "Setup complete!"
log_warn ""
log_warn "📋 IMPORTANT NOTES:"
log_warn "  • Backups are stored in: ${PROJECT_ROOT}/backups/"
log_warn "  • Old backups (30+ days) are automatically deleted"
log_warn "  • Make sure Docker is always running for backups to work"
log_warn "  • Consider backing up to external storage (cloud/NAS) for safety"
log_warn "  • Test the restore process: ./scripts/restore-database.sh"
