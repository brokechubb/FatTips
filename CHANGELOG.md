# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Production images no longer carry secrets, git history, or database dumps** — added a root `.dockerignore`. Docker never read `.gitignore`, so `COPY . .` was baking `.git` (5MB), `backups/` (18MB of production `*.sql.gz` dumps), `node_modules` (1.1GB) and every local-only ops script into 1.4GB images that are `docker save`d and shipped to the server. A local `.env` (which `deploy-prod.sh` requires for `DEPLOY_*`) would have been embedded the same way. Build context is now a few MB instead of ~210MB.
- **Deploy backups are encrypted again** — `deploy-prod.sh` had hardcoded `--no-encrypt`, so every pre-deploy dump of the production database (including user rows and encrypted wallet blobs) was written unencrypted on the server and pulled to local offsite storage. GPG encryption is back on using the server's `fattips-backup` key, and the offsite pull/retention logic now matches `*.sql.gz` and `*.sql.gz.gpg`. **Required follow-up:** the matching private key also needs to live somewhere other than the server, otherwise the offsite copies cannot be restored.

- **Sensitive data purged from the repository and its entire git history** — a security review found that tracked files (and every commit in history) contained production SSH/deploy connection details, internal and treasury wallet addresses, incident transaction signatures/amounts, and a user's Discord ID. All 24 commits were rewritten with `git-filter-repo` (sensitive values replaced with `REDACTED_*` placeholders) and force-pushed. Anyone with an existing clone or fork is on the old history — re-clone.
  - `deploy-prod.sh` now reads its deploy target from `DEPLOY_SERVER_USER` / `DEPLOY_SERVER_HOST` / `DEPLOY_SERVER_PORT` / `DEPLOY_REMOTE_DIR` (see `.env.example`) instead of hardcoded values, and fails fast if they are unset
  - Cleanup/recovery scripts use script-relative paths and require `CLEANUP_DESTINATION` (no hardcoded destination wallets)
  - Incident-specific ops scripts were untracked from the repo and added to `.gitignore` (they remain available locally); deploy/server details were scrubbed from `scripts/README.md`
  - The real wallet address used as a placeholder example in the `/send` command UI was replaced with a clearly-fake placeholder

- **Dependency security overhaul: 127 → 15 advisories, 0 critical** — adopted the audited in-range dependency patches from the [`automatelife-hub/FatTips`](https://github.com/automatelife-hub/FatTips) fork (its "non-breaking security patches" PR; the fork's other two branches were evaluated and rejected — one superseded, one runtime-breaking), then applied targeted follow-up bumps and a lockfile refresh:
  - `express ^4.22.3` — pulls patched `proxy-addr 2.0.8` (fixes critical IP-spoofing advisory GHSA-jqcg-44mw-7w3h), `body-parser 1.20.9`, `qs 6.16.0`, `path-to-regexp 0.1.13`
  - `discord.js ^14.27.0` — via `@discordjs/rest 2.6.3` → patched `undici 6.28.x` (fixes 3 undici advisories)
  - `zod ^4.6.7`, `morgan ^1.12.1`, `vitest ^4.1.11`, `express-rate-limit ^8.6.0`, TypeScript 5.9.3, Prisma 5.22, `@solana/web3.js 1.99.0`, root-pinned `eslint ^8.57.1` (prevents broken ESLint 10 auto-install)
  - Closes July 2026's critical vitest CVE (arbitrary file read/execute via Vitest UI server) and all reachable high advisories
- **Remaining 15 advisories documented and accepted**: `bigint-buffer` (high — no upstream patch exists; via `@solana/spl-token`), `turbo 1.x` (dev-only; needs major v2 + `turbo.json` migration), `mocha`/`serialize-javascript`/`anchor`/`toml` (dev-only `programs/airdrop` scaffold), and `jayson`'s `uuid 8`/`stream-json 1.9` (moderate — verified unreachable: the uuid advisory affects v3/v5/v6 APIs only while jayson uses v4; stream-json is not imported by the jayson client that `@solana/web3.js` loads).
- **Runtime verified after the refresh**: express routing, Discord REST round-trip, and a live Solana devnet RPC call all pass; full `pnpm build`, `typecheck`, and the solana test suite pass.

### Fixed

- **Tip delays eliminated — dropped broadcasts now recover in ~5s instead of ~15s** — production logs showed a tip stalling for the full soft window and then landing **0.4s** after re-propagation (submit ≈08:38:36 → timeout 08:38:51.6 → landed 08:38:52.0): the signature of a lost first send, not network congestion (median/p90 recent priority fees were 0 at the time). Three changes, in `packages/solana/src/transaction.ts` and `apps/bot/src/workers/transaction.worker.ts`:
  - **Queued tips were sending with no priority fee at all** — the worker passed only `{ onRetry }` to `transfer`/`batchTransfer`, overriding the `{ priorityFee: true }` default, so prefix-command and context-menu tips (and rain/multi-tip payouts) went out with zero priority fee and no ComputeBudget instructions; only withdrawals opted in explicitly. Both branches now set `priorityFee: true`.
  - **Priority fees are now absolute lamports, not per-CU prices** — Helius' `high` level (~167k µL/CU) is calibrated for 100k+ CU transactions; on a ~3.5k CU tip it diluted to ~600 lamports (~$0.0001), which is deprioritized and dropped. The fee is now computed as an absolute amount via this transaction's CU limit and clamped to [10k, 500k] lamports (≈$0.002 typical, ≈$0.10 hard ceiling), with 3x retry escalation and the 25k-lamport RPC-failure fallback preserved. Checked against every buffer that reserves fee headroom (withdrawals 0.001 SOL with `skipPriorityFee` for `max`, airdrop settlement's 0.001 SOL/winner, `MIN_SOL_FOR_GAS`) — the worst-case fee stays well inside all of them.
  - **Faster drop recovery** — the RPC now rebroadcasts on its own (`maxRetries: 5`, was `0`), and the confirmation soft window is 5s (was 15s), so a dropped first broadcast costs ~5s instead of ~15s. Re-propagation stays idempotent (same signed tx), and the 30s per-attempt budget is unchanged. Worst-case wait per attempt stays ~30s.
- **Deploy pipeline hardening** (`scripts/deploy-prod.sh`):
  - `set -euo pipefail` — the image upload is `docker save | gzip | ssh`, and without `pipefail` a failed local `docker save` was masked by the ssh exit status, silently deploying stale images
  - **Post-deploy health verification** — the script now fails (and prints rollback instructions) unless the API answers `GET /health`, the bot logs `Bot logged in as`, and neither container has restarted. Previously `docker compose ps` printing "Up" was treated as success even if the bot never authenticated with Discord
  - **Rollback images preserved** — the currently deployed images are retagged `:rollback` before the upload, so a bad release can be reverted without re-uploading ~2.8GB (old images were previously pruned immediately after the new ones loaded)
  - **Cleanup-script dependencies pinned** — `npm install pg @solana/web3.js` in the running container is now `pg@8.23.1 @solana/web3.js@1.99.0`. Unpinned installs had pulled web3.js **3.1.1** (with transitive deps requiring Node ≥24) next to the app's v1.99
  - Offsite backup discovery uses `find` instead of a `*.sql.gz` glob, so encrypted and unencrypted backups are both found
- **Dockerfiles: Node 22 and reproducible installs** — both images moved from `node:20-alpine` (EOL) to `node:22-alpine`, and `pnpm install --force` / `--no-frozen-lockfile` was replaced with `--frozen-lockfile` (verified against the committed lockfile), so a deploy builds exactly what is pinned. Both Dockerfiles are now structurally identical, and the non-root users are created with an explicit `nodejs` group.
- **50-second transaction stalls resolved** — ~1 in 10 transactions hit a ~50s wall: a dropped transaction waited the full blockhash expiry before retrying. Confirmation now uses a soft 15s window — if the tx hasn't confirmed, it checks on-chain status, re-propagates the signed transaction while the blockhash is still valid (idempotent, cannot double-send), and only escalates to a fresh-blockhash retry once the blockhash provably expires. Worst-case wait per attempt drops from ~50s to ~30s, and retries start ~30s sooner.
- **Priority fees now use the 'high' level** — `getPriorityFeeEstimate {recommended}` returns ~10k µL, which validators drop during congestion. Fees are now read from the full Helius fee ladder (`includeAllPriorityFeeLevels`) and use `high` (typically ~50k µL — fractions of a cent more per transfer), with fallback down the ladder (`medium` → `low` → `recommended`) if a level is missing. Retry escalation (3x, capped) is unchanged.
- **Transaction worker now processes 4 jobs concurrently** (was serial) — one slow confirmation no longer stalls the entire payout queue behind it. Airdrop settlements that previously took 6+ minutes of sequential waiting now proceed while a stuck transaction retries independently. Safe because jobs are idempotency-keyed per sender and balances are re-verified at execution time.
- **NetworkMonitor backoff** — when Helius intermittently returns 500s on fee polling, the monitor backs off exponentially (30s → 5 min max) and logs the first failure plus every 5th, instead of erroring every 30s.
- **Airdrop settlement crash recovery** — a burst of RPC 429s during large settlements crashed the bot mid-payout (unhandled websocket error), leaving airdrops stuck in `SETTLING` with unpaid participants forever. Airdrops stuck in `SETTLING` are now automatically reverted to `ACTIVE` on startup and re-settled, skipping participants already paid (no double payments).
- **Fair shares on resumed settlements** — when settlement resumes after a crash, unpaid winners now receive the same per-winner share the earlier winners got, instead of a share recomputed from the drained wallet balance.
- **Accurate `amountClaimed`** — settlement now records total paid across resume attempts (previously underreported on retries).
- **Settlement serialization** — expired-airdrop sweeps no longer run concurrently, preventing RPC 429 storms during large settlements; transfers are paced 300ms apart.
- **Process survives transient Solana RPC websocket 429s** — logged to Sentry instead of crashing the bot; genuinely fatal uncaught exceptions still restart the process.

### Added

- **Voice channel tips** — tip everyone in your current voice channel with the new `/vctip` command (slash) and `f vctip` (prefix). Supports `split`/`each` modes, USD/token amounts, and auto-creates wallets for members who don't have one. Recipients are the human members of your voice channel (excluding you and bots); per-guild rain role gating applies.
- **Voice rain** — `/rain` gains a `voice` option and `f rain vc <amount> [count]` rains on members of your current voice channel, randomly selecting up to `count` (default: all, capped at 25). Cannot be combined with the `role` option.
- **`GUILD_VOICE_STATES` intent** — required to read voice channel membership.

- **Role-based rain** — `/rain` and `f rain` now accept an optional `role` parameter to rain on members of a specific Discord role instead of active chatters. When a role has more than 25 members, 25 are randomly selected with a notification in the embed. Shares the same mode option (`split`/`each`) as `/tip`.
- **Role mention redirect from `/tip`** — if a user types a role mention in `/tip` or `f tip`, the bot redirects them to use `/rain` instead with the `role` option.
- **`mode` option on `/rain`** — supports `split` (total ÷ N, default) and `each` (per-user amount) mode, matching `/tip` behavior.

### Changed

- **Bot now requires `GUILD_MEMBERS` privileged intent** for role-based rain to fetch guild member lists.

- **App wallet API keys** — API keys can now own a standalone Solana wallet not tied to any Discord user. Tip/batch-tip/withdraw endpoints accept requests without `fromDiscordId` when using an app wallet key, automatically using the app wallet as the sender.
  - `POST /api/keys/create` with `type: "app"` creates a key with an auto-generated wallet
  - `POST /api/wallet/app/create` (admin) attaches a wallet to an existing key
  - `GET /api/wallet/app` returns the app wallet pubkey
  - `GET /api/balance/app` returns SOL/USDC/USDT balances for the app wallet
  - `fromDiscordId` / `discordId` is now optional on `/send/tip`, `/send/batch-tip`, `/send/withdraw`
- **`/leaderboard` command** (slash + prefix `f lb`) — guild-scoped leaderboards for airdrop creators and rain/tip senders
- **`/stats` command** (slash + prefix `f stats`) — personal tipping stats (tips sent/received, airdrops created/won)
- **Guild stats** — server-wide tip volume, unique senders/receivers, and airdrop totals via `f lb guild`
- **`guildId` field** on Transaction and Airdrop models — enables per-guild reporting and leaderboards
- **API report endpoints** with full filtering:
  - `GET /api/leaderboard/transactions` — filterable by guildId, fromId, toId, txType, status, tokenMint, minAmountUsd, maxAmountUsd, date range, sorting, pagination
  - `GET /api/leaderboard/airdrops` — filterable by guildId, creatorId, status, tokenMint, minAmountTotal, maxAmountTotal, date range, sorting, pagination
  - `GET /api/leaderboard/user-stats` — per-user stats with optional guildId and date range filters
  - `GET /api/leaderboard/guild-stats` — guild-wide stats with date range filter
  - `GET /api/leaderboard/top-airdrop-creators` and `top-rain-senders` — with guildId, status, and date range filters
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
- **Swap priority fees now use Jupiter's `priorityLevelWithMaxLamports`** format instead of raw microLamport values — fees were previously silently ignored by Jupiter, causing swap failures during network congestion
- **Swap transactions include `dynamicSlippage: true`** per Jupiter's recommended configuration
- **Swap retry priority escalation** — retries escalate from `"high"` to `"veryHigh"` priority level (capped at 0.001 SOL) instead of passing raw numbers Jupiter couldn't interpret
- **USD amounts now accept trailing `$`** — `5$` works the same as `$5` across all commands (swap, tip, rain, send, airdrop, and all interaction handlers)

### Fixed

- **Silent tip notification failures** — worker now falls back to `channel.send()` if the original "Processing..." message can't be edited, and falls back to a DM if the channel itself is inaccessible; the stuck "Processing..." message is deleted when a fallback send is used
- **Bare `catch {}` in worker failure path** — replaced with logged warnings so channel fetch errors are no longer silently swallowed
- **Orphaned "Processing..." messages** — prefix tip/rain/withdrawal commands now wrap `transactionQueue.add()` in try/catch and edit the processing message to show an error if queuing fails (e.g. Redis down)
- **Ephemeral "Processing transaction..." stuck forever on withdrawals** — modal and send-form withdrawal interactions no longer leave the ephemeral reply in a permanent pending state
- **Swap failures during network congestion** — `JupiterSwapService.executeSwap()` now retries up to 3 times with fresh blockhashes and escalated priority fees (matching `TransactionService` pattern), checks if transaction landed on-chain before retrying, and returns a user-friendly congestion message on exhaustion
- **Swap "timed out" false positive** — the Discord button collector's 60s timer was overwriting the reply with "Swap timed out" while retries were still running and succeeding; collector is now stopped immediately when the user clicks confirm

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
