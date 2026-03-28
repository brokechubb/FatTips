# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- QR code for deposit addresses - scan with mobile wallet to deposit easily
- Privacy Policy and Terms of Service documentation
- **Solana network monitor** (`NetworkMonitor` in `packages/solana`) — polls TPS and priority fees every 30s, classifies network as `healthy`, `degraded`, or `congested`
- **Bot presence reflects network health** — Discord status updates every 30s: Online (healthy), Idle (degraded), DND (congested) with live TPS in the activity text
- **Congestion warnings before tips/rain/send** — users receive a DM (prefix) or ephemeral message (slash) warning them of network conditions before their transaction is queued
- **Dynamic priority fees** — priority fee is now fetched live from Helius `getPriorityFeeEstimate` before each transaction attempt, replacing the previous hardcoded 50k microLamports value
- **Priority fee escalation on retry** — fee multiplies 3x per retry attempt (capped at 5M microLamports ~$0.05) to improve inclusion odds under congestion
- **Congestion status update during retry** — if a transaction needs to retry, the "Processing transaction..." message is edited to inform the user about congestion and that a higher-fee retry is in progress

### Changed

- Deposit command now shows QR code with embedded address (slash, prefix, and balance interaction)
- Code formatting improvements across transaction handlers
- **`maxRetries: 0`** set on `sendTransaction` — the bot now fully owns the retry lifecycle instead of racing with the RPC node's internal retry loop
- **Max retry attempts reduced from 3 → 2** — fail fast with a clear error rather than making users wait up to 5+ minutes
- **Removed 2s delay before on-chain status check** on retry — eliminated wasted time on the failure path
- **Withdrawal processing messages** (modal and prefix) now say "✅ Withdrawal queued — you'll receive a DM when it completes" instead of "⏳ Processing transaction...", accurately reflecting that the worker DMs the result
- **`channelId`/`messageId` no longer passed to withdrawal jobs** from modal interactions — removes the dead code path since the WITHDRAWAL worker branch never used them

### Fixed

- **Silent tip notification failures** — worker now falls back to `channel.send()` if the original "Processing..." message can't be edited, and falls back to a DM if the channel itself is inaccessible; the stuck "Processing..." message is deleted when a fallback send is used
- **Bare `catch {}` in worker failure path** — replaced with logged warnings so channel fetch errors are no longer silently swallowed
- **Orphaned "Processing..." messages** — prefix tip/rain/withdrawal commands now wrap `transactionQueue.add()` in try/catch and edit the processing message to show an error if queuing fails (e.g. Redis down)
- **Ephemeral "Processing transaction..." stuck forever on withdrawals** — modal and send-form withdrawal interactions no longer leave the ephemeral reply in a permanent pending state

### Removed

- Temporary development documentation files (GIT_CLEANUP_INSTRUCTIONS.md, RELEASE_READINESS_SUMMARY.md, SECURITY.md, SECURITY_AUDIT.md)

## [0.1.0] - 2026-02-12

### Added

- Automated weekly cleanup system for residual airdrop wallet funds
- `cleanedUpAt` tracking in database to avoid re-checking wallets
- Rent exemption checks for USDC/USDT transfers (ATA creation)
- Recipient rent exemption checks for SOL tips

### Changed

- Balance command now shows in channel (not DM) with privacy note
- History reduced to 3 transactions with reference to /history
- Withdrawal notifications now sent via DM instead of channel editing
- Solscan links use raw URL format to prevent embed previews

### Fixed

- Gas buffer calculation to account for rent exemption (0.00089 SOL per winner)
- Balance check retry logic for settlement reliability
- Funds verification in airdrop wallet before creation
- Zero-amount validation for airdrops
- Deploy script now runs migrations before starting services

---

## How to Use

When releasing a new version:

1. Copy the relevant changes to a Discord announcement
2. Update the version number and date above
3. Move changes to the new version section as "[Unreleased]"

### Discord Post Format Example

```markdown
**FatTips Update**

**New Features:**

- Feature A
- Feature B

**Improvements:**

- Improvement A
- Improvement B

**Bug Fixes:**

- Fix A
- Fix B
```
