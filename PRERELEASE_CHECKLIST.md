# Pre-Release Checklist for Public Open Source Launch

**Target Release Date:** [DATE]  
**Version:** 0.2.1  
**Status:** ⚠️ IN PROGRESS

---

## Phase 1: Security Cleanup ✅ COMPLETED

### Files Deleted

- [x] `.env` - Production credentials removed
- [x] `fattips_dump.sql` - Database dump removed
- [x] `fattips-api.local` - Personal IP removed
- [x] `backups/offsite/*` - Backup contents cleared

### .gitignore Updated

- [x] Added `fattips-api.local`
- [x] Added `fattips-api.conf`
- [x] Added `CLAUDE.md`, `AGENTS.md`
- [x] Added `scripts/check-users-balances.js`

### Documentation Created

- [x] `SECURITY.md` - Public security policy
- [x] `SECURITY_AUDIT.md` - Internal audit report
- [x] `PRERELEASE_CHECKLIST.md` - This file

---

## Phase 2: Credential Rotation 🔴 CRITICAL

**⚠️ MUST COMPLETE BEFORE PUBLIC RELEASE**

### Discord Credentials

- [ ] Regenerate Discord Bot Token
  - URL: https://discord.com/developers/applications
  - Location: Your App > Bot > Reset Token
- [ ] Regenerate Discord Client Secret
  - URL: https://discord.com/developers/applications
  - Location: Your App > OAuth2 > Reset Secret
- [ ] Update production server `.env` with new values

### Database Credentials

- [ ] Change PostgreSQL password
  ```sql
  ALTER USER fattips_user WITH PASSWORD 'NEW_STRONG_PASSWORD_HERE';
  ```
- [ ] Update production server `.env`
- [ ] Test database connectivity

### Solana RPC

- [ ] Regenerate Helius API Key
  - URL: https://www.helius.xyz/dashboard
  - Action: Create new API key, revoke old one
- [ ] Update production server `.env`

### Encryption Keys

- [ ] **DECISION REQUIRED:** Rotate Master Encryption Key?
  - ⚠️ **WARNING:** This breaks decryption of existing wallets
  - **Option A:** Keep old key (safer, but was exposed)
  - **Option B:** Rotate key (requires wallet migration)

  **If rotating:**

  ```bash
  # Generate new key
  openssl rand -base64 32

  # Migration script needed:
  # 1. Decrypt all wallets with old key
  # 2. Re-encrypt with new key
  # 3. Update database
  ```

### API Keys

- [ ] Regenerate Jupiter API Key
  - URL: https://portal.jup.ag
- [ ] Regenerate Admin API Key
  ```bash
  openssl rand -base64 32
  ```
- [ ] Update production server `.env`

### Verification

- [ ] Restart all Docker containers
  ```bash
  cd /opt/FatTips
  docker compose restart
  ```
- [ ] Test bot commands in Discord
  - `/balance`
  - `/tip`
  - `/airdrop`
- [ ] Test API endpoints
  ```bash
  curl http://localhost:3001/health
  ```
- [ ] Check Sentry for errors
- [ ] Monitor logs for 24 hours

---

## Phase 3: Git History Cleanup

### Check for Accidental Commits

```bash
# Check if sensitive files were ever committed
cd /home/chubb/bots/FatTips

# Search git history
git log --all --full-history -- .env
git log --all --full-history -- "*password*"
git log --all --full-history -- "*.sql"

# Check current status
git status
git ls-files --others --exclude-standard
```

### If Secrets Found in History

```bash
# Install BFG Repo-Cleaner
wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar

# Remove sensitive files from history
java -jar bfg-1.14.0.jar --delete-files .env
java -jar bfg-1.14.0.jar --delete-files "*.sql"
java -jar bfg-1.14.0.jar --delete-files "fattips-api.*"

# Clean up git
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push (DANGEROUS - coordinates with collaborators first!)
git push --force --all
git push --force --tags
```

### Final Git Verification

- [ ] `git status` shows clean working directory
- [ ] `git ls-files` shows no sensitive files
- [ ] Git history is clean
- [ ] All branches are clean

---

## Phase 4: Documentation Review

### Public-Facing Documentation

- [x] `README.md` - Update for public audience
- [x] `SECURITY.md` - Security policy created
- [ ] `CONTRIBUTING.md` - Create contribution guidelines
- [ ] `LICENSE` - Already exists (MIT) ✅
- [ ] `CHANGELOG.md` - Already exists ✅

### Internal Documentation (Keep Private or Remove)

- [ ] `ROADMAP.md` - Remove sensitive details or keep internal
- [ ] `CLAUDE.md` - Add to .gitignore ✅
- [ ] `AGENTS.md` - Add to .gitignore ✅
- [ ] `GEMINI.md` - Add to .gitignore ✅

### Architecture Documentation (Public)

- [x] `docs/ARCHITECTURE_ANALYSIS.md` - Safe for public
- [x] `docs/ARCHITECTURE_DIAGRAMS.md` - Safe for public
- [x] `docs/ARCHITECTURE_SUMMARY.md` - Safe for public
- [x] `docs/COMPONENT_DEPENDENCIES.md` - Safe for public
- [x] `docs/INDEX.md` - Safe for public

### Create Missing Documentation

- [ ] `.github/SECURITY.md` - Vulnerability reporting
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md` - Bug report template
- [ ] `.github/ISSUE_TEMPLATE/feature_request.md` - Feature request
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` - PR template
- [ ] `CONTRIBUTING.md` - How to contribute

---

## Phase 5: Code Quality

### Linting & Type Checking

```bash
cd /home/chubb/bots/FatTips

# Run all checks
pnpm lint
pnpm typecheck
pnpm format
```

- [ ] No linting errors
- [ ] No type errors
- [ ] Code formatted correctly

### Testing

```bash
# Run tests
pnpm test
```

- [ ] All tests passing
- [ ] Test coverage acceptable
- [ ] Add more tests if needed

### Build Verification

```bash
# Build all packages
pnpm build

# Verify build artifacts
ls -la apps/*/dist/
ls -la packages/*/dist/
```

- [ ] Build succeeds
- [ ] No build warnings
- [ ] Dist files created

---

## Phase 6: GitHub Setup

### Repository Settings

- [ ] Set repository to public
- [ ] Enable GitHub Actions
- [ ] Enable Dependabot
- [ ] Enable GitHub Secret Scanning
- [ ] Set default branch to `main`
- [ ] Add repository topics
  - solana
  - discord-bot
  - tipping
  - cryptocurrency
  - typescript
  - monorepo

### Branch Protection

- [ ] Protect `main` branch
  - Require pull request reviews
  - Require status checks
  - Require signed commits (optional)
  - Include administrators

### GitHub Actions

- [ ] Create `.github/workflows/ci.yml`
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v3
        - uses: pnpm/action-setup@v2
        - uses: actions/setup-node@v3
        - run: pnpm install
        - run: pnpm lint
        - run: pnpm typecheck
        - run: pnpm test
  ```

### Dependabot

- [ ] Create `.github/dependabot.yml`
  ```yaml
  version: 2
  updates:
    - package-ecosystem: 'npm'
      directory: '/'
      schedule:
        interval: 'weekly'
    - package-ecosystem: 'docker'
      directory: '/docker'
      schedule:
        interval: 'weekly'
  ```

---

## Phase 7: Final Verification

### Security Scan

```bash
# Check for any remaining secrets
grep -r "DISCORD_BOT_TOKEN\|SOLANA_RPC_URL\|MASTER_ENCRYPTION_KEY" \
  --include="*.ts" --include="*.js" --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=.git .
```

- [ ] No hardcoded secrets found
- [ ] All secrets use `process.env.*`

### Fresh Clone Test

```bash
# Test fresh installation
cd /tmp
git clone https://github.com/brokechubb/FatTips.git
cd FatTips
pnpm install
pnpm build
```

- [ ] Fresh clone succeeds
- [ ] Dependencies install correctly
- [ ] Build completes without errors

### Documentation Links

- [ ] All links in README.md work
- [ ] All internal documentation links work
- [ ] No broken image references

### Production Verification

- [ ] Production system still running
- [ ] All commands working
- [ ] No errors in logs
- [ ] Users unaffected

---

## Phase 8: Release

### Pre-Release Announcement

- [ ] Draft announcement for Discord
- [ ] Prepare Twitter/social media posts
- [ ] Update website (if applicable)

### Make Public

- [ ] Double-check all checklist items
- [ ] Set repository to public
- [ ] Verify public access works
- [ ] Monitor for issues

### Post-Release

- [ ] Monitor GitHub for issues/PRs
- [ ] Respond to community questions
- [ ] Track stars/forks/watchers
- [ ] Gather feedback

---

## Timeline

| Phase | Task                 | Estimated Time | Status         |
| ----- | -------------------- | -------------- | -------------- |
| 1     | Security Cleanup     | 1 hour         | ✅ DONE        |
| 2     | Credential Rotation  | 2-4 hours      | ⏳ PENDING     |
| 3     | Git History Cleanup  | 1 hour         | ⏳ PENDING     |
| 4     | Documentation Review | 2 hours        | ⏳ IN PROGRESS |
| 5     | Code Quality         | 1 hour         | ⏳ PENDING     |
| 6     | GitHub Setup         | 1 hour         | ⏳ PENDING     |
| 7     | Final Verification   | 2 hours        | ⏳ PENDING     |
| 8     | Release              | 1 hour         | ⏳ PENDING     |

**Total Estimated Time:** 10-12 hours

---

## Sign-Off

### Security Review

- [ ] All credentials rotated
- [ ] No secrets in codebase
- [ ] Git history clean
- [ ] SECURITY.md published

**Reviewed by:** ********\_********  
**Date:** ********\_********

### Code Quality Review

- [ ] All tests passing
- [ ] No linting errors
- [ ] Documentation complete
- [ ] Build successful

**Reviewed by:** ********\_********  
**Date:** ********\_********

### Final Approval

- [ ] All phases complete
- [ ] Ready for public release

**Approved by:** @brokechubb  
**Date:** ********\_********

---

## Emergency Rollback Plan

If issues discovered after release:

1. **Immediately:** Set repository back to private
2. **Assess:** Determine severity of issue
3. **Fix:** Address the problem
4. **Re-verify:** Complete checklist again
5. **Re-release:** Make public again when ready

**Contact:** security@codestats.gg

---

**Checklist Version:** 1.0  
**Last Updated:** 2026-03-09
