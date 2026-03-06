# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FatTips is a Solana-based Discord tipping bot with airdrop functionality. Monorepo using Turborepo + pnpm workspaces.

**Work off ROADMAP.md and keep it updated with progress.**

## Build & Development Commands

```bash
pnpm install            # Install dependencies
pnpm dev                # Run all apps in parallel (tsx watch)
pnpm build              # Build all packages (turbo)
pnpm lint               # Lint all packages
pnpm typecheck          # Type check all packages
pnpm format             # Prettier format all files
pnpm test               # Run tests (Vitest, currently only packages/solana)

pnpm db:generate        # Generate Prisma client (required after schema changes)
pnpm db:migrate         # Run database migrations
pnpm db:studio          # Open Prisma Studio GUI
pnpm db:seed            # Seed database

pnpm docker:up          # Start all Docker services
pnpm docker:down        # Stop all Docker services

./scripts/deploy-prod.sh  # Full production deploy (backup, build, upload, migrate, start)
```

## Architecture

**Package dependency graph:**
```
packages/database (Prisma + PostgreSQL)
packages/solana   (Solana blockchain: wallets, transfers, swaps, pricing)
packages/shared   (constants, Redis pub/sub, activity tracking, airdrop pool)
    ↑ all three are consumed by ↓
apps/bot          (Discord bot - discord.js v14)
apps/api          (REST API - Express on port 3001)
```

**Key data flow — tipping:**
```
Discord command → command handler → BullMQ transaction queue
  → transaction.worker.ts → TransactionService (on-chain)
  → prisma.$transaction() for DB atomicity
```

**Key data flow — airdrops:**
Each airdrop uses a **pooled wallet** from `AirdropPoolWallet` (reused across airdrops). Creator funds it, users claim via Discord buttons, settlement happens at expiry or when max participants reached. Status machine: `ACTIVE → SETTLING → SETTLED/FAILED/RECLAIMED`. After settlement, wallets are released back to the pool.

**Critical: Pool wallet reuse** — Because wallets are reused, any code that associates a wallet with a user (e.g., fund recovery) must look at the airdrop record, not just the wallet. When verification fails after funding, a `FAILED` airdrop record is created so recovery scripts know who actually funded the wallet.

**Infrastructure:** PostgreSQL 16, Redis 7 (BullMQ queues + pub/sub + activity tracking), Docker Compose for production.

## Code Patterns

- **Services pattern**: Business logic in service classes (`AirdropService`, `WalletService`, `TransactionService`, `AirdropPoolService`), NOT in command handlers
- **Financial values**: Always use `Decimal` from Prisma, never floating-point
- **Multi-step DB ops**: Use `prisma.$transaction([...])` for atomicity
- **Solana transactions**: Always include `ComputeBudgetProgram` priority fees; use BullMQ queue for heavy operations
- **Wallet encryption**: AES-256-GCM with unique salt per user, master key from `MASTER_ENCRYPTION_KEY` env var
- **Bot prefix commands**: Handled in `apps/bot/src/handlers/prefixCommands.ts` (large monolithic handler, default prefix `f`)
- **Input validation**: Zod v4
- **Error tracking**: Sentry
- **Logging**: Winston

## Code Style

- TypeScript strict mode, ES2022 target, NodeNext modules
- Prettier: semicolons, single quotes, trailing commas (ES5), 100 char width, 2-space indent
- File names: `kebab-case.ts`
- Import order: external libraries → `@fattips/*` packages → relative imports
- Named exports for utilities, default exports for classes
- Use `unknown` instead of `any`, then narrow

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Run `pnpm lint && pnpm typecheck` before committing
- Update CHANGELOG.md before deploying

## Production Environment

- **Server**: `codestats.gg`, SSH port `1337` (e.g., `ssh -p 1337 codestats.gg`)
- **Project path on server**: `/opt/FatTips`
- **Docker containers**: `fattips-bot`, `fattips-api`, `fattips-db`, `fattips-redis`
- Database and Redis are only accessible inside Docker network (not on localhost)
- To run scripts against production, execute inside the `fattips-bot` container or use the `scripts/run-*-docker.sh` wrappers
- Recovery script deps (`pg`, `@solana/web3.js`, `@solana/spl-token`) are not pre-installed on the host; install in a temp dir inside the container: `mkdir -p /tmp/recovery && cd /tmp/recovery && npm init -y && npm install pg @solana/web3.js @solana/spl-token`, then run with `NODE_PATH=/tmp/recovery/node_modules`

## Solana RPC Commitment Levels

All services that query Solana balances must use `confirmed` commitment to match `TransactionService`. Using the default (`finalized`) causes stale reads because finalization lags ~15-30s behind confirmation. This was the root cause of airdrop verification failures — `BalanceService` now explicitly uses `{ commitment: 'confirmed' }`.

## Important Notes

- `apps/web/` does not exist yet — web dashboard is cancelled (Phase 6)
- `programs/airdrop/` is an empty placeholder for a future Anchor program
- Tests are minimal — only `packages/solana/src/wallet.test.ts` exists; place new tests next to source as `*.test.ts`
- `scripts/` contains operational/recovery scripts, not application code; `scripts/recover-airdrop-funds.js` recovers stranded funds from pool wallets
- Docker uses node:20-alpine with multi-stage builds; `DATABASE_URL` is overridden in docker-compose to point to the `postgres` service
- Airdrop code exists in two parallel paths: slash commands (`apps/bot/src/commands/airdrop.ts`) and prefix commands (`apps/bot/src/handlers/prefixCommands.ts`) — changes to airdrop logic must be applied to both
