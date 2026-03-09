# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
