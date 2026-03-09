# Complete Git History Cleanup Guide

**Purpose:** Remove all git history and start fresh for public open source release

**⚠️ WARNING:** This is a **DESTRUCTIVE OPERATION** that cannot be undone.

---

## Why Clean History?

Your repository has **100 commits** of history. Even though we deleted sensitive files, they may still exist in:

- Old commits
- Git objects
- Reflogs

**Nuclear option:** Delete entire `.git` directory and start fresh.

---

## Prerequisites

✅ Sensitive files already deleted:

- `.env`
- `fattips_dump.sql`
- `fattips-api.local`

✅ `.gitignore` updated to prevent re-committing

---

## Option 1: Complete Fresh Start (RECOMMENDED)

This removes ALL history and creates a single initial commit.

### Step 1: Backup Current State

```bash
cd /home/chubb/bots/FatTips

# Create backup of git info
mkdir -p /tmp/fattips-git-backup-$(date +%Y%m%d-%H%M%S)
git branch -a > /tmp/fattips-git-backup/branches.txt
git log --oneline > /tmp/fattips-git-backup/commit-history.txt
git remote -v > /tmp/fattips-git-backup/remotes.txt
```

### Step 2: Remove Git Repository

```bash
# Delete the entire .git directory
rm -rf .git
```

### Step 3: Initialize Fresh Repository

```bash
# Initialize new repo
git init -b main

# Re-add remote
git remote add origin https://github.com/brokechubb/FatTips.git
```

### Step 4: Stage All Files

```bash
# Add everything
git add .

# Verify what's being added
git status
```

### Step 5: Create Initial Commit

```bash
git commit -m "Initial public release - Clean repository

FatTips is a non-custodial Solana tipping bot for Discord.

Features:
- Discord tipping (SOL, USDC, USDT)
- Airdrop functionality with pool wallets
- REST API for integrations
- Non-custodial wallet management
- AES-256-GCM encryption

Security:
- No sensitive files in repository
- All secrets from environment variables
- Production credentials rotated"
```

### Step 6: Verify Before Pushing

```bash
# Check what will be pushed
git log --stat

# Verify no sensitive files
git ls-files | grep -E "\.env|fattips-api|\.sql$" | grep -v example | grep -v migration
# Should return nothing
```

### Step 7: Force Push to GitHub

```bash
# DANGEROUS - This rewrites all history!
git push --force --set-upstream origin main
```

**Expected output:**

```
Enumerating objects: XXX, done.
Counting objects: 100% (XXX/XXX), done.
Delta compression using up to X threads
Compressing objects: 100% (XXX/XXX), done.
Writing objects: 100% (XXX/XXX), done.
Total XXX (delta XXX), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (XXX/XXX), done.
To https://github.com/brokechubb/FatTips.git
 + [old-hash]...[new-hash] main -> main (forced update)
```

---

## Option 2: Keep Some History (ADVANCED)

If you want to keep commit history but remove specific files:

### Using BFG Repo-Cleaner

```bash
# Download BFG
wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar

# Remove sensitive files from history
java -jar bfg-1.14.0.jar --delete-files .env
java -jar bfg-1.14.0.jar --delete-files "*.sql"
java -jar bfg-1.14.0.jar --delete-files "fattips-api.*"

# Clean up
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push
git push --force --set-upstream origin main
```

**⚠️ WARNING:** This is complex and may not catch everything. **Option 1 is safer.**

---

## After Cleanup: Verification

### 1. Check GitHub Repository

Visit: https://github.com/brokechubb/FatTips

- Should show only 1 commit
- No sensitive files in file list
- Clean commit history

### 2. Test Fresh Clone

```bash
cd /tmp
rm -rf FatTips-test
git clone https://github.com/brokechubb/FatTips.git FatTips-test
cd FatTips-test

# Verify no sensitive files
ls -la .env fattips-api.* 2>&1
# Should say "No such file or directory"

# Check git history
git log --oneline
# Should show only 1 commit
```

### 3. Verify Build Works

```bash
cd /tmp/FatTips-test
pnpm install
pnpm build
```

---

## After Cleanup: GitHub Settings

### 1. Make Repository Public

1. Go to: https://github.com/brokechubb/FatTips/settings
2. Scroll to "Danger Zone"
3. Click "Change visibility"
4. Select "Make public"
5. Confirm

### 2. Enable Security Features

1. **GitHub Actions:**
   - Settings > Actions > General
   - Enable "Allow all actions"

2. **Dependabot:**
   - Create `.github/dependabot.yml`
   - Settings > Code security and analysis > Enable Dependabot

3. **Secret Scanning:**
   - Settings > Code security and analysis
   - Enable "Secret scanning"

4. **Vulnerability Alerts:**
   - Settings > Code security and analysis
   - Enable "Dependabot alerts"

### 3. Add Repository Topics

Settings > Topics:

- `solana`
- `discord-bot`
- `tipping`
- `cryptocurrency`
- `typescript`
- `monorepo`
- `turborepo`

---

## Notify Collaborators

**⚠️ IMPORTANT:** Anyone who cloned the old repository will need to re-clone.

**Message template:**

```
📢 FatTips Repository History Cleanup

The FatTips repository has been cleaned for public release.
All git history has been rewritten to remove sensitive files.

ACTION REQUIRED:
1. Delete your old clone:
   rm -rf FatTips

2. Re-clone fresh:
   git clone https://github.com/brokechubb/FatTips.git

3. Your old fork/clone will NOT work with the new history.

Reason: Security cleanup for open source release.
Questions? Contact @brokechubb
```

---

## Rollback Plan (If Something Goes Wrong)

If you need to restore old history:

```bash
# From backup
cd /home/chubb/bots/FatTips

# Remove new repo
rm -rf .git

# Restore from backup (if you saved .git directory)
# This is why you should backup .git BEFORE deleting it
cp -r /path/to/backup/.git .

# Force push back
git push --force --set-upstream origin main
```

**⚠️ WARNING:** Only rollback if absolutely necessary. The cleanup is for security.

---

## Checklist

### Before Cleanup

- [ ] Backup git info (branches, logs)
- [ ] Verify sensitive files deleted
- [ ] Verify `.gitignore` updated
- [ ] Notify collaborators (optional)
- [ ] Create this backup: `cp -r .git /tmp/fattips-git-backup-full`

### During Cleanup

- [ ] Remove `.git` directory
- [ ] Initialize fresh repo
- [ ] Add all files
- [ ] Create initial commit
- [ ] Verify no sensitive files

### After Cleanup

- [ ] Force push to GitHub
- [ ] Verify on GitHub (1 commit only)
- [ ] Test fresh clone
- [ ] Make repository public
- [ ] Enable GitHub security features
- [ ] Add repository topics
- [ ] Notify collaborators

---

## Commands Summary (Copy-Paste)

```bash
# Navigate to repo
cd /home/chubb/bots/FatTips

# Backup git info
mkdir -p /tmp/fattips-git-backup-$(date +%Y%m%d-%H%M%S)
git branch -a > /tmp/fattips-git-backup/branches.txt
git log --oneline > /tmp/fattips-git-backup/commit-history.txt

# NUCLEAR OPTION - Remove all git history
rm -rf .git

# Start fresh
git init -b main
git remote add origin https://github.com/brokechubb/FatTips.git

# Add files
git add .

# Verify
git status
git ls-files | grep -E "\.env|fattips-api"

# Commit
git commit -m "Initial public release - Clean repository"

# Verify one more time
git log --stat

# FORCE PUSH (point of no return)
git push --force --set-upstream origin main

# Test fresh clone
cd /tmp
git clone https://github.com/brokechubb/FatTips.git test-clone
cd test-clone
ls -la .env  # Should not exist
git log --oneline  # Should show 1 commit
```

---

## FAQ

**Q: Will this affect my production deployment?**  
A: **NO** - Production uses the `.env` file on the server, not in git.

**Q: What about my collaborators?**  
A: They must delete their old clone and re-clone from scratch.

**Q: Can I undo this?**  
A: Only if you backed up the `.git` directory before deleting it.

**Q: Will GitHub show me as the only contributor?**  
A: Yes, all commits will be replaced with one initial commit by you.

**Q: Should I keep some history?**  
A: **NO** - For security, complete fresh start is safest.

---

## Support

If you encounter issues:

- Check git status: `git status`
- Check remote: `git remote -v`
- Test push: `git push --dry-run --force`

**Contact:** @brokechubb

---

**Last Updated:** 2026-03-09  
**Document Version:** 1.0
