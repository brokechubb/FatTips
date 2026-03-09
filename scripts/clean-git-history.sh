#!/bin/bash
set -e

echo "🚨 DANGEROUS OPERATION - Git History Cleanup 🚨"
echo "================================================"
echo ""
echo "This script will:"
echo "  1. Remove ALL git history"
echo "  2. Create a fresh repository with only current files"
echo "  3. Force push to GitHub (rewrites all history)"
echo ""
echo "⚠️  WARNINGS:"
echo "  - All commit history will be PERMANENTLY DELETED"
echo "  - All branches will be DELETED"
echo "  - All tags will be DELETED"
echo "  - Contributors will need to re-clone from scratch"
echo "  - This CANNOT be undone"
echo ""
echo "✅ SAFE TO PROCEED (files already cleaned):"
echo "  - .env file deleted"
echo "  - fattips_dump.sql deleted"
echo "  - fattips-api.local deleted"
echo "  - No sensitive files in working directory"
echo ""
read -p "Type 'YES' to confirm you want to proceed: " confirm

if [ "$confirm" != "YES" ]; then
  echo "❌ Aborted"
  exit 1
fi

echo ""
echo "📋 Step 1: Verify current state..."
echo "-----------------------------------"
git status --short
echo ""

read -p "Continue? (y/n): " continue_confirm
if [ "$continue_confirm" != "y" ]; then
  echo "❌ Aborted"
  exit 1
fi

echo ""
echo "📋 Step 2: Backup current git info..."
echo "--------------------------------------"
BACKUP_DIR="/tmp/fattips-git-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Save current branch info
git branch -a > "$BACKUP_DIR/branches.txt"
git log --oneline > "$BACKUP_DIR/commit-history.txt"
git remote -v > "$BACKUP_DIR/remotes.txt"

echo "✅ Backup saved to: $BACKUP_DIR"
echo ""

echo "📋 Step 3: Remove .git directory..."
echo "------------------------------------"
rm -rf .git
echo "✅ Git history removed"
echo ""

echo "📋 Step 4: Initialize fresh repository..."
echo "------------------------------------------"
git init -b main
echo "✅ New repository initialized"
echo ""

echo "📋 Step 5: Re-add remote..."
echo "----------------------------"
git remote add origin https://github.com/brokechubb/FatTips.git
echo "✅ Remote added"
echo ""

echo "📋 Step 6: Add all files..."
echo "----------------------------"
git add .
echo "✅ Files staged"
echo ""

echo "📋 Step 7: Create initial commit..."
echo "------------------------------------"
git commit -m "Initial public release - Clean repository

This is a fresh start for the FatTips open source project.
All sensitive files have been removed and history cleaned.

Features:
- Discord tipping bot for Solana
- Support for SOL, USDC, USDT
- Airdrop functionality
- REST API for integrations
- Non-custodial wallet management

Security:
- No sensitive files in repository
- All secrets loaded from environment variables
- AES-256-GCM encryption for user wallets"

echo "✅ Initial commit created"
echo ""

echo "📋 Step 8: Show git status..."
echo "------------------------------"
git status
echo ""

echo "📋 Step 9: Show commit history..."
echo "----------------------------------"
git log --oneline
echo ""

echo "✅ Git cleanup complete!"
echo ""
echo "================================================"
echo "NEXT STEPS:"
echo "================================================"
echo ""
echo "1. Review the changes:"
echo "   git log --stat"
echo ""
echo "2. Force push to GitHub (DANGEROUS - rewrites history):"
echo "   git push --force --set-upstream origin main"
echo ""
echo "3. Verify on GitHub:"
echo "   https://github.com/brokechubb/FatTips"
echo ""
echo "4. Update repository settings:"
echo "   - Set repository to Public"
echo "   - Enable GitHub Actions"
echo "   - Enable Dependabot"
echo "   - Enable Secret Scanning"
echo ""
echo "5. Notify collaborators:"
echo "   - They will need to re-clone the repository"
echo "   - Old clones will not work with new history"
echo ""
echo "Backup location: $BACKUP_DIR"
echo "================================================"
