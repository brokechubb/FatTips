# FatTips Architecture Analysis

**Generated:** 2026-03-09  
**Version:** 0.2.1  
**Status:** Production-ready with active development

---

## Executive Summary

FatTips is a **non-custodial social tipping layer for Solana** integrated into Discord. The system enables users to tip, send, and airdrop SOL, USDC, and USDT directly within chat while maintaining full ownership of their private keys.

### Key Metrics

- **Architecture:** Monorepo (Turborepo + pnpm workspaces)
- **Runtime:** Node.js 18+ with TypeScript (strict mode)
- **Database:** PostgreSQL 16 with Prisma ORM
- **Caching:** Redis 7 (BullMQ queues + pub/sub + activity tracking)
- **Blockchain:** Solana mainnet via Helius RPC
- **Deployment:** Docker Compose on VPS (codestats.gg)

---

## 1. System Architecture

### High-Level Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      DISCORD CLIENTS                         │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ /tip       │  │ /airdrop   │  │ Prefix Commands (f)  │  │
│  │ /balance   │  │ /rain      │  │ ftip, fbalance, etc. │  │
│  │ /send      │  │ /swap      │  │                      │  │
│  └─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘  │
└────────┼───────────────┼────────────────────┼──────────────┘
         │               │                      │
         └───────────────┴──────────────────────┘
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                 DISCORD BOT (discord.js v14)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Command Handlers → Services → Transaction Queue      │   │
│  │ Prefix Handler (prefixCommands.ts)                   │   │
│  │ Interaction Handlers (buttons/modals/selects)        │   │
│  └────────────────────┬─────────────────────────────────┘   │
└─────────────────────────┼────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
┌───────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐
│  REST API     │ │   Database   │ │   Solana     │
│  (Express)    │ │  (PostgreSQL)│ │  (Web3.js)   │
│  Port 3001    │ │  + Prisma    │ │  + Jupiter   │
└───────────────┘ └──────────────┘ └──────────────┘
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
┌─────────────────────────┴─────────────────────────────────────┐
│                    SHARED INFRASTRUCTURE                       │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Redis       │ │  BullMQ      │  │ Sentry (Monitoring)  │ │
│  │ Pub/Sub     │ │  Queues      │  │ Winston (Logging)    │ │
│  └─────────────┘  └──────────────┘  └──────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### Data Flow Patterns

#### 1. Tip Flow (Synchronous)

```
User: /tip @friend $5
  ↓
Command Handler (tip.ts)
  ↓
Validate Balance → Check SOL for gas
  ↓
TransactionService.transfer()
  ├─→ Solana: Create transfer transaction
  ├─→ Add priority fees (ComputeBudgetProgram)
  └─→ Sign with encrypted wallet
  ↓
BullMQ Queue (transaction-queue)
  ↓
Transaction Worker (transaction.worker.ts)
  ├─→ Submit to Solana
  ├─→ Wait for confirmation (confirmed commitment)
  ├─→ prisma.$transaction([
  │    prisma.transaction.create(...),
  │    prisma.user.update(...)
  │  ])
  └─→ Discord: Reply with confirmation
```

#### 2. Airdrop Flow (Asynchronous with Settlement)

```
User: /airdrop amount:$10 duration:1h
  ↓
Airdrop Command (airdrop.ts)
  ↓
AirdropPoolService.getWallet() → Reuse pooled wallet
  ↓
Creator funds pool wallet (0.00089 rent + gas)
  ↓
Database: Airdrop { status: ACTIVE, expiresAt: ... }
  ↓
Discord: Embed with Claim button
  ↓
Users click "Claim" → AirdropParticipant created
  ↓
[Timer expires OR max participants reached]
  ↓
settleAirdrop() → Distribute funds to participants
  ↓
AirdropPoolService.releaseWallet() → Return to pool
```

#### 3. API Integration Flow (Jakey Bot)

```
External Bot (Jakey)
  ↓
POST /api/send/tip
  ├─→ X-API-Key header (user-specific)
  └─→ Body: { to: "@user", amount: "$5" }
  ↓
API: sendRoutes.post('/tip')
  ↓
requireAuth middleware → Validate API key
  ↓
TransactionService.transfer()
  ↓
BullMQ Queue → Transaction Worker
  ↓
Redis Pub/Sub: AIRDROP_CREATED event
  ↓
Bot: AirdropEventHandler → Post to Discord channel
```

---

## 2. Component Analysis

### 2.1 Applications

#### **Bot** (`apps/bot/`)

**Purpose:** Discord interface for all user interactions

**Key Files:**

- `src/index.ts` - Main entry point, event handlers
- `src/commands/*.ts` - Slash command implementations
- `src/handlers/prefixCommands.ts` - Prefix command processor
- `src/services/airdrop.ts` - Airdrop business logic
- `src/queues/transaction.queue.ts` - BullMQ queue setup
- `src/workers/transaction.worker.ts` - Transaction processor

**Patterns:**

- Command files export `data` (SlashCommandBuilder) and `execute` function
- Prefix commands handled in monolithic `prefixCommands.ts`
- Heavy operations (tips/rain) queued via BullMQ
- Error tracking via Sentry with context tags

**Dependencies:**

- `discord.js` v14
- `@fattips/database` (Prisma client)
- `@fattips/solana` (blockchain logic)
- `@fattips/shared` (Redis, constants)

---

#### **API** (`apps/api/`)

**Purpose:** REST API for external integrations (Jakey bot, web dashboard)

**Key Files:**

- `src/index.ts` - Express server setup
- `src/middleware/auth.ts` - API key authentication
- `src/routes/*.ts` - Route handlers

**Endpoints:**
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/wallet/create` | POST | None | Create wallet (open) |
| `/api/balance/:discordId` | GET | API Key | Get balance |
| `/api/send/tip` | POST | API Key | Send tip |
| `/api/send/batch-tip` | POST | API Key | Batch tip |
| `/api/send/withdraw` | POST | API Key | Withdraw to address |
| `/api/airdrops/create` | POST | API Key | Create airdrop |
| `/api/airdrops/:id/claim` | POST | API Key | Claim airdrop |
| `/api/swap/quote` | GET | API Key | Get swap quote |
| `/api/swap/execute` | POST | API Key | Execute swap |
| `/api/rain/create` | POST | API Key | Create rain |
| `/api/leaderboard` | GET | API Key | Get leaderboard |
| `/api/activity/active-users` | GET | API Key | Get active users |
| `/api/keys` | POST | Admin Key | Create API key |

**Security:**

- Per-user API keys (64-char hex, prefixed `ft_`)
- Keys stored in `ApiKey` table with expiration
- Middleware enforces ownership (users can only access their own wallet)

---

### 2.2 Packages

#### **Database** (`packages/database/`)

**Purpose:** Data persistence layer

**Schema:**

```prisma
User {
  discordId          String  @id
  walletPubkey       String  @unique
  encryptedPrivkey   String
  keySalt            String
  encryptedMnemonic  String?
  mnemonicSalt       String?
  seedDelivered      Boolean @default(false)
  sentTips           Transaction[]
  receivedTips       Transaction[]
  airdropsCreated    Airdrop[]
  participations     AirdropParticipant[]
}

Transaction {
  id           String   @id @uuid
  signature    String   @unique
  fromId       String?
  toId         String?
  amountUsd    Decimal  @db.Decimal(10, 2)
  amountToken  Decimal  @db.Decimal(20, 9)
  tokenMint    String
  txType       TxType
  status       TxStatus
  createdAt    DateTime
}

Airdrop {
  id               String   @id @uuid
  walletPubkey     String   @unique
  encryptedPrivkey String
  keySalt          String
  creatorId        String
  amountTotal      Decimal
  tokenMint        String
  maxParticipants  Int?
  participantCount Int
  status           AirdropStatus
  expiresAt        DateTime
  channelId        String
  participants     AirdropParticipant[]
}

AirdropPoolWallet {
  address       String  @id
  encryptedPrivkey String
  keySalt       String
  isBusy        Boolean @default(false)
  lastUsedAt    DateTime
}
```

**Key Patterns:**

- `Decimal` type for all financial values (never floating-point)
- Indexes on foreign keys and query filters
- Soft deletes via status enums

---

#### **Solana** (`packages/solana/`)

**Purpose:** Blockchain interaction layer

**Modules:**

- `wallet.ts` - Wallet generation, encryption/decryption
- `transaction.ts` - Transfers, withdrawals, priority fees
- `balance.ts` - Balance queries (uses `confirmed` commitment)
- `price.ts` - Jupiter Price API integration
- `swap.ts` - Jupiter swap quotes and execution

**Critical Pattern:**

```typescript
// Always use 'confirmed' commitment for balance checks
// 'finalized' causes stale reads (15-30s lag)
const balance = await connection.getBalance(publicKey, {
  commitment: 'confirmed',
});
```

---

#### **Shared** (`packages/shared/`)

**Purpose:** Common utilities and cross-cutting concerns

**Modules:**

- `constants/` - Token mints, thresholds
- `redis.ts` - Redis client configuration
- `activity.ts` - Redis-based activity tracking (sorted sets)
- `airdrop-pool.ts` - Airdrop pool wallet management

**Redis Usage:**

1. **BullMQ Queues** - Transaction processing
2. **Pub/Sub** - Bot/API communication (`airdrop-events` channel)
3. **Activity Tracking** - Sorted sets with timestamps
4. **Caching** - Price data, user balances

---

## 3. Key Architectural Decisions

### 3.1 Non-Custodial Design

**Decision:** Users receive private keys immediately via DM  
**Rationale:** Aligns with "not your keys, not your coins" philosophy  
**Implementation:**

- AES-256-GCM encryption at rest
- Master key from `MASTER_ENCRYPTION_KEY` env var
- Unique salt per user

### 3.2 Airdrop Pool Wallets

**Decision:** Reuse ephemeral wallets across airdrops  
**Rationale:** Reduces rent waste (0.00089 SOL per wallet)  
**Implementation:**

- `AirdropPoolWallet` table tracks available wallets
- `AirdropPoolService.getWallet()` acquires wallet
- `releaseWallet()` returns to pool after settlement
- Cleanup scripts drain residual funds weekly

### 3.3 Transaction Queue (BullMQ)

**Decision:** Queue heavy transactions instead of blocking  
**Rationale:** Prevents bot timeouts, improves UX  
**Implementation:**

- Tips/rain queued immediately
- Worker processes sequentially
- Retry logic for failed transactions
- Priority fees included to prevent drops

### 3.4 Commitment Level: Confirmed

**Decision:** Use `confirmed` instead of `finalized` for balance checks  
**Rationale:** `finalized` lags 15-30s, causes false negatives  
**Impact:** Fixed airdrop verification failures

### 3.5 API Key Per-User Isolation

**Decision:** API keys tied to specific Discord user  
**Rationale:** Prevents privilege escalation, limits blast radius  
**Implementation:**

- `requireAuth` middleware validates key
- `requireOwnership` middleware enforces wallet ownership
- Keys can be revoked/expire

---

## 4. Security Architecture

### 4.1 Encryption

- **Algorithm:** AES-256-GCM
- **Key Derivation:** Master key from env var
- **Storage:** `encryptedPrivkey` + `keySalt` in database
- **Never Logged:** Private keys, seed phrases

### 4.2 Authentication

| Layer    | Mechanism                       |
| -------- | ------------------------------- |
| Discord  | Bot token (env var)             |
| API      | Per-user API keys (64-char hex) |
| Admin    | Separate admin API key          |
| Database | Limited-privilege DB user       |

### 4.3 Transaction Safety

- Priority fees via `ComputeBudgetProgram`
- Balance validation before transfers
- Rent exemption protection (0.00089 SOL minimum)
- Retry logic with exponential backoff

### 4.4 Discord Security

- Ephemeral responses for sensitive data
- Button interaction validation
- Permission checks on commands
- DM failures handled gracefully

---

## 5. Deployment Architecture

### 5.1 Production Environment

**Server:** `codestats.gg` (VPS)  
**SSH Port:** 1337  
**Path:** `/opt/FatTips`

### 5.2 Docker Services

```yaml
services:
  postgres: # PostgreSQL 16
    container: fattips-db
    volume: postgres_data

  redis: # Redis 7
    container: fattips-redis
    volume: redis_data

  bot: # Discord bot
    container: fattips-bot
    image: fattips-bot:latest

  api: # REST API
    container: fattips-api
    image: fattips-api:latest
    port: 127.0.0.1:3001:3001
```

### 5.3 Deployment Process

```bash
./scripts/deploy-prod.sh
```

**Steps:**

1. Database backup
2. Build Docker images (multi-stage, `pnpm deploy`)
3. Upload compressed images to server
4. Run migrations (`prisma migrate deploy`)
5. Start services (`docker compose up -d`)
6. Install npm packages for cleanup scripts

---

## 6. Code Quality & Conventions

### 6.1 TypeScript Configuration

- **Target:** ES2022
- **Module:** NodeNext
- **Strict Mode:** Enabled
- **Types:** Explicit on all function signatures

### 6.2 File Naming

| Type      | Convention         | Example             |
| --------- | ------------------ | ------------------- |
| Files     | `kebab-case.ts`    | `wallet-service.ts` |
| Functions | `camelCase`        | `transferTokens`    |
| Classes   | `PascalCase`       | `AirdropService`    |
| Constants | `UPPER_SNAKE_CASE` | `TOKEN_MINTS`       |

### 6.3 Import Order

```typescript
// 1. External libraries
import { Client } from 'discord.js';

// 2. Internal packages
import { prisma } from '@fattips/database';

// 3. Relative imports
import { formatAmount } from './utils';
```

### 6.4 Error Handling Pattern

```typescript
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  console.error('Context: failed to operation', error);
  Sentry.captureException(error, { tags: { ... } });
  throw new Error('User-friendly message');
}
```

---

## 7. Performance Considerations

### 7.1 Database Indexing

```prisma
@@index([fromId, createdAt])
@@index([toId, createdAt])
@@index([status])
@@index([walletPubkey])
```

### 7.2 Caching Strategy

- **Redis Sorted Sets:** Activity tracking (time-based queries)
- **In-Memory:** Price cache (TTL: 60s)
- **Database:** Transaction history (indexed queries)

### 7.3 Queue Processing

- **Queue:** `transaction-queue` (BullMQ)
- **Concurrency:** 1 (sequential processing)
- **Retry:** 3 attempts with backoff
- **Timeout:** 30s per transaction

---

## 8. Monitoring & Observability

### 8.1 Logging

- **Tool:** Winston
- **Format:** JSON (production), Dev (development)
- **Levels:** error, warn, info, debug
- **Location:** `/logs/bot/`, `/logs/api/`

### 8.2 Error Tracking

- **Tool:** Sentry
- **Integration:** `@sentry/node` + `@sentry/profiling-node`
- **Context:** Command name, user ID, guild ID
- **Profiling:** Enabled (tracesSampleRate: 1.0)

### 8.3 Health Checks

```yaml
postgres:
  test: pg_isready -U fattips_user -d fattips
  interval: 10s

redis:
  test: redis-cli ping
  interval: 5s
```

---

## 9. Maintenance & Operations

### 9.1 Database Maintenance

```bash
# Backup
./scripts/backup-database.sh

# Migrate
pnpm db:migrate

# Studio (GUI)
pnpm db:studio
```

### 9.2 Airdrop Cleanup

**Weekly Cron:** Sundays at 3 AM  
**Script:** `scripts/cleanup-airdrops.js`  
**Purpose:** Drain residual funds from settled airdrops  
**Destination:** `9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY`

### 9.3 Recovery Procedures

**Scenario:** Failed airdrop with funds in pool wallet  
**Script:** `scripts/recover-airdrop-funds.js`  
**Wrapper:** `./scripts/run-recovery-docker.sh`

---

## 10. Known Issues & Technical Debt

### 10.1 Active Issues

1. **Jakey Rain/Tip Mismatch** - Using `/rain` for individual tips causes silent failures
2. **Web Dashboard** - Phase 6 cancelled, no user-facing dashboard
3. **Testing Coverage** - Minimal tests (only `wallet.test.ts`)

### 10.2 Refactoring Candidates

1. **Prefix Commands** - Monolithic `prefixCommands.ts` (2000+ lines)
2. **Transaction Worker** - Could be extracted to separate service
3. **Airdrop Logic** - Split between slash/prefix commands

### 10.3 Missing Features

- Rate limiting on API (partially implemented)
- Comprehensive test suite
- API documentation (OpenAPI/Swagger)
- Load testing results
- Automated backups (manual script exists)

---

## 11. Component Relationships

### Dependency Graph

```
apps/bot
  ├── @fattips/database
  ├── @fattips/solana
  └── @fattips/shared

apps/api
  ├── @fattips/database
  ├── @fattips/solana
  └── @fattips/shared

packages/solana
  └── @solana/web3.js
  └── @solana/spl-token
  └── jupiter-api

packages/database
  └── @prisma/client
  └── postgresql

packages/shared
  └── redis (ioredis)
  └── bullmq
```

### Communication Patterns

1. **Bot ↔ Database:** Prisma Client (direct)
2. **Bot ↔ Solana:** Web3.js (RPC via Helius)
3. **Bot ↔ API:** Redis Pub/Sub (`airdrop-events`)
4. **API ↔ External:** REST with API key auth
5. **Bot ↔ Discord:** discord.js WebSocket

---

## 12. Onboarding Guide

### For New Developers

#### Prerequisites

- Node.js 18+
- PostgreSQL 16
- Docker & Docker Compose
- pnpm 8+
- Discord Developer account
- Solana wallet (Phantom/Solflare)

#### Quick Start

```bash
# 1. Clone
git clone https://github.com/brokechubb/FatTips.git
cd FatTips

# 2. Install
pnpm install

# 3. Environment
cp .env.example .env
# Edit .env with your values

# 4. Database
docker compose up -d postgres
pnpm db:migrate
pnpm db:generate

# 5. Run
pnpm dev
```

#### Key Files to Read

1. `apps/bot/src/commands/tip.ts` - Example command
2. `packages/solana/src/transaction.ts` - Blockchain logic
3. `packages/database/prisma/schema.prisma` - Data model
4. `apps/api/src/middleware/auth.ts` - Authentication

#### Testing Checklist

- [ ] Create wallet
- [ ] Tip another user
- [ ] Create airdrop
- [ ] Claim airdrop
- [ ] Withdraw to external address
- [ ] Check balance

---

## 13. Future Architecture Considerations

### 13.1 Scalability

- **Current:** Single bot instance
- **Future:** Shard bot for larger scale
- **Bottleneck:** Database connections, RPC rate limits

### 13.2 Multi-Chain Support

- **Current:** Solana-only
- **Future:** Ethereum, Polygon via similar pattern
- **Challenge:** Cross-chain token standards

### 13.3 Web Dashboard (Cancelled)

- **Status:** Phase 6 cancelled
- **Reason:** Focus on core bot functionality
- **Alternative:** API for third-party dashboards

### 13.4 Anchor Program (Future)

- **Current:** Bot-managed ephemeral wallets
- **Future:** On-chain airdrop program
- **Benefit:** True decentralization, verifiable settlement

---

## 14. References

### Documentation

- [Discord.js Guide](https://discordjs.guide/)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Jupiter API](https://station.jup.ag/docs/apis/price-api)
- [Prisma ORM](https://www.prisma.io/docs)
- [BullMQ](https://docs.bullmq.io/)

### Internal Docs

- [ROADMAP.md](../ROADMAP.md) - Development phases
- [AGENTS.md](../AGENTS.md) - Agent guidelines
- [CLAUDE.md](../CLAUDE.md) - Claude-specific context
- [GEMINI.md](../GEMINI.md) - Gemini-specific context

---

**Last Updated:** 2026-03-09  
**Maintainer:** @brokechubb  
**License:** MIT
