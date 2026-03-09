#!/bin/bash
# Setup weekly airdrop cleanup cron job
# This script adds a weekly cron job to drain residual funds from airdrop wallets

SCRIPT_PATH="/opt/FatTips/scripts/run-cleanup-docker.sh"
LOG_PATH="/opt/FatTips/logs/airdrop-cleanup.log"

# Create log directory if it doesn't exist
mkdir -p /opt/FatTips/logs

# Create the cron job entry (runs every Sunday at 3 AM)
# Uses the Docker wrapper script which handles all required environment variables
CRON_JOB="0 3 * * 0 $SCRIPT_PATH >> $LOG_PATH 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "run-cleanup-docker.sh"; then
    echo "Cron job already exists. To update, remove it first with: crontab -l | grep -v 'run-cleanup-docker.sh' | crontab -"
    exit 0
fi

# Add new cron job
(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo "Weekly airdrop cleanup cron job installed!"
echo ""
echo "Schedule: Every Sunday at 3:00 AM"
echo "Script: $SCRIPT_PATH"
echo "Log: $LOG_PATH"
echo ""
echo "To verify, run: crontab -l"
echo "To view logs: tail -f $LOG_PATH"
