# FatTips Architecture Summary

**Quick Reference Guide**  
**Generated:** 2026-03-09

---

## TL;DR - Key Takeaways

1. **What:** Non-custodial Solana tipping bot for Discord
2. **Stack:** TypeScript, Discord.js, Prisma, PostgreSQL, Redis, BullMQ
3. **Architecture:** Monorepo (Turborepo) with 2 apps + 3 packages
4. **Deployment:** Docker Compose on VPS (codestats.gg)
5. **Status:** Production-ready, actively maintained

---

## System at a Glance

### Core Components

| Component      | Technology               | Purpose                             |
| -------------- | ------------------------ | ----------------------------------- |
| **Bot**        | discord.js v14           | Discord interface, command handling |
| **API**        | Express.js               | REST API for external integrations  |
| **Database**   | PostgreSQL + Prisma      | Data persistence                    |
| **Cache**      | Redis 7                  | Queues, pub/sub, activity tracking  |
| **Blockchain** | Solana (@solana/web3.js) | On-chain transactions               |
| **Pricing**    | Jupiter API              | Real-time token prices              |

### Monorepo Structure

```
FatTips/
├── apps/
│   ├── bot/          # Discord bot (main entry point)
│   └── api/          # REST API (Jakey integration)
├── packages/
│   ├── database/     # Prisma schema & client
│   ├── solana/       # Blockchain logic
│   └── shared/       # Common utilities
├── programs/         # Future Anchor programs (empty)
└── scripts/          # Operational scripts
```

---

## Critical Architectural Decisions

### ✅ Good Decisions

1. **Non-custodial design** - Users own keys, aligns with crypto ethos
2. **Airdrop pool wallets** - Reuse wallets, save rent (0.00089 SOL each)
3. **BullMQ queue** - Async processing prevents bot timeouts
4. **Confirmed commitment** - Faster balance checks (vs finalized)
5. **Per-user API keys** - Isolation, revocable access
6. **Monorepo with Turborepo** - Shared deps, consistent tooling

### ⚠️ Technical Debt

1. **Prefix commands** - Monolithic 2000+ line file, needs refactoring
2. **No tests** - Only `wallet.test.ts` exists
3. **Web dashboard cancelled** - Phase 6 scrapped
4. **API docs missing** - No OpenAPI/Swagger spec
5. **Manual backups** - Script exists but not automated

---

## Data Model Overview

### Core Entities

**User**

- `discordId` (PK) - Discord user ID
- `walletPubkey` - Solana public key
- `encryptedPrivkey` + `keySalt` - Encrypted private key

**Transaction**

- `signature` - Solana transaction signature
- `fromId`, `toId` - Foreign keys to User
- `amountUsd`, `amountToken` - Amounts
- `txType` - TIP, DEPOSIT, WITHDRAWAL, AIRDROP_CLAIM

**Airdrop**

- `walletPubkey` - Ephemeral wallet for escrow
- `creatorId` - Creator's Discord ID
- `amountTotal`, `tokenMint` - Pot size
- `status` - ACTIVE, SETTLING, SETTLED, FAILED, RECLAIMED
- `expiresAt` - Settlement trigger

**AirdropPoolWallet**

- `address` - Wallet public key
- `isBusy` - In-use flag
- `lastUsedAt` - For LRU selection

---

## Key Patterns

### 1. Transaction Flow

```
Command → Validate → Queue (BullMQ) → Worker → Solana → DB → Notify
```

### 2. Airdrop Lifecycle

```
Create → Fund Pool → Claim → Settle → Release Wallet
```

### 3. Wallet Encryption

```
Generate Keypair → Encrypt (AES-256-GCM) → Store in DB → DM to User
```

### 4. API Authentication

```
Request → requireAuth → Validate API Key → requireOwnership → Process
```

---

## Production Deployment

### Environment

- **Server:** VPS (codestats.gg)
- **SSH:** Port 1337
- **Path:** `/opt/FatTips`
- **Containers:** 4 (bot, api, postgres, redis)

### Deployment Command

```bash
./scripts/deploy-prod.sh
```

**What it does:**

1. Database backup
2. Build Docker images (multi-stage, `pnpm deploy`)
3. Upload compressed images
4. Run migrations
5. Start services
6. Install npm packages (for cleanup scripts)

### Monitoring

- **Logs:** Winston → `/logs/bot/`, `/logs/api/`
- **Errors:** Sentry (with profiling)
- **Health:** Docker healthchecks (postgres, redis)

---

## Security Posture

### ✅ Strong Points

- AES-256-GCM encryption for keys
- Master key from environment (not in code)
- Per-user API keys with expiration
- Docker network isolation
- No secrets in logs
- Ephemeral Discord responses

### ⚠️ Watch Outs

- Private keys transmitted via DM (not E2EE)
- Master key rotation not automated
- No rate limiting on Discord commands
- API bound to localhost only (good!)

---

## Performance Characteristics

### Bottlenecks

1. **Database:** Single PostgreSQL instance
2. **RPC:** Helius free tier rate limits
3. **Queue:** Sequential processing (concurrency: 1)
4. **Bot:** Single instance (no sharding)

### Optimizations

- Redis caching for prices (60s TTL)
- Indexed queries on foreign keys
- Priority fees prevent dropped transactions
- Confirmed commitment for faster reads

---

## Development Workflow

### Getting Started

```bash
# 1. Clone & install
git clone https://github.com/brokechubb/FatTips.git
cd FatTips
pnpm install

# 2. Setup environment
cp .env.example .env
# Edit .env with tokens

# 3. Start database
docker compose up -d postgres
pnpm db:migrate
pnpm db:generate

# 4. Run
pnpm dev
```

### Key Commands

```bash
pnpm dev              # Start all apps (watch mode)
pnpm build            # Build all packages
pnpm lint             # ESLint check
pnpm typecheck        # TypeScript check
pnpm db:studio        # Open Prisma Studio
pnpm docker:up        # Start all containers
./scripts/deploy-prod.sh  # Deploy to production
```

---

## Known Issues

### Active Bugs

1. **Jakey Rain/Tip Mismatch** - Using `/rain` for individual tips fails silently
2. **Balance verification** - Occasional false negatives due to RPC latency (mitigated with retries)

### Missing Features

- Web dashboard (Phase 6 cancelled)
- Comprehensive test suite
- API documentation
- Automated backups
- Load testing

### Refactoring Candidates

1. **Prefix commands** (`apps/bot/src/handlers/prefixCommands.ts`) - 2000+ lines
2. **Transaction worker** - Could be standalone service
3. **Airdrop logic** - Duplicated between slash/prefix commands

---

## Integration Points

### External Dependencies

| Service     | Purpose             | Criticality |
| ----------- | ------------------- | ----------- |
| Discord API | Bot communication   | Critical    |
| Helius RPC  | Solana blockchain   | Critical    |
| Jupiter API | Token prices, swaps | High        |
| Sentry      | Error tracking      | Medium      |
| Redis       | Caching, queues     | High        |

### API Endpoints (for Jakey)

- `POST /api/wallet/create` - Create wallet
- `GET /api/balance/:discordId` - Get balance
- `POST /api/send/tip` - Send tip
- `POST /api/send/withdraw` - Withdraw to address
- `POST /api/airdrops/create` - Create airdrop
- `POST /api/swap/execute` - Swap tokens

---

## Maintenance Tasks

### Daily

- Monitor Sentry errors
- Check bot uptime
- Review transaction logs

### Weekly (Sunday 3 AM)

- Airdrop cleanup script (drains residual funds)
- Database backup (manual script available)

### Monthly

- Rotate `MASTER_ENCRYPTION_KEY` (manual)
- Review API key usage
- Check Docker resource usage

### As Needed

- Airdrop fund recovery (`scripts/recover-airdrop-funds.js`)
- Database migrations (`pnpm db:migrate`)
- Dependency updates (`pnpm update`)

---

## Future Considerations

### Scalability

- **Current limit:** ~100 users/sec (RPC bottlenecks)
- **Solution:** Shard bot, multiple RPC endpoints
- **Database:** Connection pooling sufficient for now

### Multi-Chain

- **Current:** Solana-only
- **Future:** Ethereum, Polygon possible
- **Challenge:** Different token standards, gas models

### Anchor Program

- **Current:** Bot-managed ephemeral wallets
- **Future:** On-chain airdrop program
- **Benefit:** Verifiable settlement, true decentralization

---

## Onboarding Checklist

### Day 1

- [ ] Read this summary
- [ ] Setup local development environment
- [ ] Run bot in test Discord server
- [ ] Create test wallet, send tip

### Week 1

- [ ] Read `ARCHITECTURE_ANALYSIS.md`
- [ ] Understand Prisma schema
- [ ] Trace tip command flow
- [ ] Review Sentry error logs

### Month 1

- [ ] Implement small feature (e.g., new command)
- [ ] Fix a bug
- [ ] Add tests for existing functionality
- [ ] Deploy to production

---

## Getting Help

### Documentation

- `README.md` - User-facing features
- `ROADMAP.md` - Development phases
- `ARCHITECTURE_ANALYSIS.md` - Deep dive
- `CLAUDE.md`, `GEMINI.md` - AI assistant context

### Key People

- **Maintainer:** @brokechubb
- **Repository:** https://github.com/brokechubb/FatTips

### Common Issues

1. **"Command not found"** - Run `pnpm db:generate`
2. **"Cannot connect to database"** - Check `DATABASE_URL` in `.env`
3. **"Discord token invalid"** - Verify `DISCORD_BOT_TOKEN`
4. **RPC errors** - Check Helius API key quota

---

## Quick Reference

### Token Mints (Hardcoded)

```typescript
const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};
```

### Thresholds

- **MIN_SOL_FOR_GAS:** 0.001 SOL (~$0.15)
- **Rent exemption:** 0.00089 SOL
- **Priority fee buffer:** 0.000005 SOL per TX

### Ports

- **API:** 3001 (localhost only)
- **PostgreSQL:** 5432 (internal)
- **Redis:** 6379 (internal)
- **SSH:** 1337

---

**Last Updated:** 2026-03-09  
**Version:** 0.2.1  
**Status:** Production
