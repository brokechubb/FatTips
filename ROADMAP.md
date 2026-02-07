# FatTips Development Roadmap

**A Solana tipping bot for Discord with airdrop functionality**

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Database Schema](#database-schema)
6. [Development Phases](#development-phases)
7. [Environment Setup](#environment-setup)
8. [Testing Strategy](#testing-strategy)
9. [Security Considerations](#security-considerations)
10. [Open Issues & Decisions](#open-issues--decisions)

---

## Project Overview

FatTips is a Discord bot that enables Solana-based tipping with support for SOL, USDC, and USDT. Users can create time-limited airdrops that other users can claim via button interactions. The bot manages user wallets (custodial with private key recovery) with bot-managed ephemeral wallets for airdrop escrow.

### Key Features

- **Instant Tipping**: `/tip @user $5` converts USD to SOL automatically
- **Airdrops**: Button-based claims with instant settlement on expiry
- **Multi-token Support**: SOL, USDC, USDT hardcoded
- **Wallet Recovery**: Users receive their Private Key for full custody
- **Web Dashboard**: Leaderboards, user stats, transaction history

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        DISCORD                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Tipping      │  │ Airdrops     │  │ Wallet Commands  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
└─────────┼─────────────────┼──────────────────┼─────────────┘
          │                 │                  │
          └─────────────────┴──────────────────┘
                            │
          ┌─────────────────┴──────────────────┐
          │         DISCORD BOT                │
          │  (Node.js + discord.js v14)        │
          └─────────────────┬──────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼───────┐  ┌────────▼──────┐  ┌────────▼──────┐
│  REST API     │  │   Database    │  │   Solana      │
│  (Express)    │  │  (PostgreSQL) │  │  (Web3.js)    │
└───────────────┘  └───────────────┘  └───────────────┘
        │                   │                   │
        │                   │                   │
┌───────▼───────────────────▼───────────────────▼──────────┐
│                     WEB DASHBOARD                        │
│              (Next.js + Tailwind CSS)                    │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │ Leaderboard │  │ User Stats   │  │ Transaction    │   │
│  │             │  │              │  │ History        │   │
│  └─────────────┘  └──────────────┘  └────────────────┘   │
└──────────────────────────────────────────────────────────┘
                            │

```

---

## Tech Stack

### Core Technologies

| Component       | Technology | Version |
| --------------- | ---------- | ------- |
| Language        | TypeScript | 5.x     |
| Runtime         | Node.js    | 18+ LTS |
| Package Manager | pnpm       | 8+      |

### Applications

| App | Framework      | Purpose              |
| --- | -------------- | -------------------- |
| Bot | discord.js v14 | Discord interactions |
| API | Express + tRPC | REST API             |
| Web | Next.js 14     | Dashboard            |

### Infrastructure

| Service      | Provider/Type          | Notes           |
| ------------ | ---------------------- | --------------- |
| Database     | Self-hosted PostgreSQL | 14+             |
| RPC          | Helius                 | Free tier       |
| Price Oracle | Jupiter Price API      | v4              |
| Hosting      | VPS                    | 4GB RAM, 4 vCPU |
| Domain       | codestats.gg           | Main deployment |

---

## Project Structure

```
fattips/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── apps/
│   ├── bot/
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   ├── handlers/
│   │   │   ├── services/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── components/
│       │   └── lib/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── database/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── src/
│   ├── shared/
│   │   └── src/
│   └── solana/
│       └── src/
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile.bot
│   ├── Dockerfile.api
│   └── Dockerfile.web
├── docs/
│   ├── API.md
│   ├── CONTRIBUTING.md
│   └── DEPLOYMENT.md
├── scripts/
│   ├── setup.sh
│   └── deploy.sh
├── .env.example
├── .gitignore
├── LICENSE (MIT)
├── README.md
├── ROADMAP.md (this file)
└── package.json
```

---

## Database Schema

### User Model

```prisma
model User {
  discordId         String   @id
  walletPubkey      String   @unique
  encryptedPrivkey  String
  keySalt           String
  keyDelivered      Boolean  @default(false)
  createdAt         DateTime @default(now())
  lastActive        DateTime @updatedAt

  sentTips          Transaction[] @relation("SentTips")
  receivedTips      Transaction[] @relation("ReceivedTips")
  airdropsCreated   Airdrop[]     @relation("Creator")
  participations    AirdropParticipant[]
}
```

### Transaction Model

```prisma
model Transaction {
  id                String   @id @default(uuid())
  signature         String   @unique
  fromId            String
  toId              String
  from              User     @relation("SentTips", fields: [fromId], references: [discordId])
  to                User     @relation("ReceivedTips", fields: [toId], references: [discordId])
  amountUsd         Decimal  @db.Decimal(10, 2)
  amountToken       Decimal  @db.Decimal(20, 9)
  tokenMint         String
  usdRate           Decimal  @db.Decimal(20, 9)
  txType            TxType
  status            TxStatus
  createdAt         DateTime @default(now())

  @@index([fromId, createdAt])
  @@index([toId, createdAt])
}
```

### Airdrop Model

```prisma
model Airdrop {
  id                String   @id @default(uuid())
  onChainPda        String   @unique
  creatorId         String
  creator           User     @relation("Creator", fields: [creatorId], references: [discordId])
  amountTotal       Decimal  @db.Decimal(20, 9)
  amountClaimed     Decimal  @default(0) @db.Decimal(20, 9)
  tokenMint         String
  maxParticipants   Int
  participantCount  Int      @default(0)
  status            AirdropStatus @default(ACTIVE)
  expiresAt         DateTime
  settledAt         DateTime?
  createdAt         DateTime @default(now())

  participants      AirdropParticipant[]

  @@index([status, expiresAt])
  @@index([creatorId])
}
```

### AirdropParticipant Model

```prisma
model AirdropParticipant {
  id                String   @id @default(uuid())
  airdropId         String
  airdrop           Airdrop  @relation(fields: [airdropId], references: [id])
  userId            String
  user              User     @relation(fields: [userId], references: [discordId])
  shareAmount       Decimal  @db.Decimal(20, 9)
  claimedAt         DateTime @default(now())
  status            ParticipantStatus @default(PENDING)
  txSignature       String?

  @@unique([airdropId, userId])
}
```

### Enums

```prisma
enum TxType {
  TIP
  DEPOSIT
  WITHDRAWAL
  AIRDROP_CLAIM
}

enum TxStatus {
  PENDING
  CONFIRMED
  FAILED
}

enum AirdropStatus {
  ACTIVE
  EXPIRED
  SETTLED
  RECLAIMED
}

enum ParticipantStatus {
  PENDING
  TRANSFERRED
}
```

---

## Development Phases

### Phase 1: Foundation (Week 1-2) ✅ COMPLETED

**Goal:** Project setup, tooling, CI/CD

- [x] Initialize monorepo with pnpm workspaces
- [x] Set up TypeScript configurations
- [x] Configure ESLint + Prettier
- [x] Create GitHub Actions CI pipeline
- [x] Set up Docker compose for local development
- [x] Initialize database with Prisma
- [x] Create initial database migrations

**Deliverables:**

- Working development environment
- CI pipeline passing
- Database running locally

### Phase 2: Discord Bot Core (Week 2-3) ✅ COMPLETED

**Goal:** Basic bot functionality, wallet management

- [x] Set up discord.js bot
- [x] Implement `/wallet create` command
- [x] Implement wallet encryption/decryption (AES-256-GCM)
- [x] DM private key delivery
- [x] Implement `/wallet balance` command (fetches real SOL, USDC, USDT balances + USD values)
- [x] Implement `/wallet export-key` command (primary method)
- [x] Implement `/wallet export` command (recovery phrase backup)
- [x] Implement `/wallet address` command
- [x] Database integration for wallets
- [x] Integrate Solana balance fetching (requires RPC connection)
- [x] Test all commands in Discord

**Deliverables:**

- Bot can generate and store wallets
- Private Keys delivered via DM
- Basic wallet commands working
- Real-time balance fetching from mainnet

### Phase 4: Airdrops (Week 4-5) ✅ COMPLETED

**Goal:** Complete airdrop system with button claims

- [x] Implement `/airdrop` command (simplified structure)
- [x] Create embed with Claim button
- [x] Handle button interactions (with tracking)
- [x] Track participants in database
- [x] Integrate with ephemeral wallets (Bot-Managed Escrow)
- [x] Implement settlement at expiry
- [x] Handle max participants limit (Instant Settlement)
- [x] Precise timing for short drops
- [x] Auto-refund logic for empty/expired drops

**Deliverables:**

- Airdrops can be created and claimed
- Button-based claims working
- Settlement automatic at expiry
- Zero-risk funds management (Refunds)

### Phase 5: REST API (Week 6) 🚧 NEXT UP

**Goal:** Public API for integrations

- [ ] Set up Express server
- [ ] Implement authentication middleware
- [ ] Create user endpoints
- [ ] Create transaction endpoints
- [ ] Create airdrop endpoints
- [ ] Add rate limiting
- [ ] API documentation

**Deliverables:**

- REST API running
- All endpoints documented
- Authentication working

### Phase 6: Web Dashboard (Week 7)

**Goal:** User-facing web interface

- [ ] Set up Next.js project
- [ ] Configure Discord OAuth
- [ ] Create leaderboard page
- [ ] Create user dashboard
- [ ] Implement transaction history view
- [ ] Add real-time updates
- [ ] Mobile responsiveness

**Deliverables:**

- Dashboard live at codestats.gg
- All pages functional
- Discord OAuth working

### Phase 7: Testing & Polish (Week 8)

**Goal:** Production readiness

- [ ] End-to-end testing
- [ ] Load testing
- [ ] Security review
- [ ] Documentation complete
- [ ] Mainnet testing complete
- [ ] Launch checklist

**Deliverables:**

- All tests passing
- Documentation complete
- Ready for mainnet

---

## Environment Setup

### Required Environment Variables

```bash
# Discord (Required)
DISCORD_BOT_TOKEN=              # From Discord Developer Portal
DISCORD_CLIENT_ID=              # Application ID
DISCORD_CLIENT_SECRET=          # OAuth2 Secret

# Database (Required)
DATABASE_URL=                   # postgresql://user:pass@host:5432/fattips

# Solana (Required)
SOLANA_RPC_URL=                 # https://mainnet.helius-rpc.com/?api-key=...
MASTER_ENCRYPTION_KEY=          # 32-byte base64 encoded key

# Jupiter (Required)
JUPITER_API_URL=                # https://price.jup.ag/v4

# Web (Phase 6)
NEXTAUTH_SECRET=                # Random string for JWT
NEXTAUTH_URL=                   # http://localhost:3000 (dev) / https://codestats.gg (prod)

# Optional
LOG_LEVEL=                      # debug | info | warn | error (default: info)
PORT=                           # API port (default: 3001)
```

### Token Mints (Hardcoded)

```typescript
const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112', // Wrapped SOL
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};
```

---

## Testing Strategy

### Testing Strategy

**Test Scenarios:**

1. **Wallet Creation**
   - Create wallet
   - Verify private key delivery
   - Test encryption/decryption

2. **Tipping**
   - Tip linked user (direct transfer)
   - Tip unlinked user (balance credit)
   - Verify USD conversion accuracy
   - Test edge cases (insufficient funds, etc.)

3. **Airdrops**
   - Create airdrop with different durations
   - Claim via button
   - Test max participants limit
   - Verify settlement math

### Test Checklist

- [ ] Unit tests for encryption
- [ ] Unit tests for USD conversion
- [ ] Integration tests for tipping
- [ ] Integration tests for airdrops
- [ ] End-to-end flow tests
- [ ] Load tests (concurrent airdrops)
- [ ] Error handling tests

---

## Security Considerations

### Critical

1. **Private Key Encryption**
   - AES-256-GCM encryption
   - Unique salt per user
   - Master key in environment only

2. **Database Security**
   - Connection string with limited permissions
   - Regular backups
   - Encrypted backups

3. **API Security**
   - Rate limiting on all endpoints
   - Input validation
   - Authentication required for sensitive operations

4. **Discord Security**
   - DM failures handled gracefully
   - Button interaction validation
   - Permission checks

### Checklist

- [ ] Master encryption key generated and secured
- [ ] Database access restricted
- [ ] Rate limiting implemented
- [ ] Input sanitization in place
- [ ] Error messages don't leak sensitive info
- [ ] Logging doesn't include private keys
- [ ] HTTPS only for web dashboard
- [ ] CORS properly configured

---

## Open Issues & Decisions

### Technical Decisions (Resolved)

| Issue          | Options             | Status      | Decision                       |
| -------------- | ------------------- | ----------- | ------------------------------ |
| Monorepo tool  | Turborepo vs Nx     | ✅ RESOLVED | Turborepo implemented          |
| API protocol   | REST vs tRPC        | ✅ RESOLVED | REST API (Phase 5 in progress) |
| WebSocket      | Socket.io vs native | ✅ RESOLVED | SSE for MVP, upgrade later     |
| Caching        | In-memory vs Redis  | ✅ RESOLVED | Redis for production (Phase 6) |
| Error Handling | Custom vs standard  | ✅ RESOLVED | FatTipsError classes (Phase 2) |
| Logging        | Winston + Sentry    | ✅ RESOLVED | Implemented in bot             |

### Feature Decisions

| Feature                | Priority | Status  | Notes              |
| ---------------------- | -------- | ------- | ------------------ |
| Leaderboard            | High     | Phase 6 | Web dashboard page |
| Transaction export     | Medium   | Future  | CSV/JSON download  |
| Mobile app             | Low      | Future  | Phase 10+          |
| Multi-server support   | Medium   | Future  | Phase 9+           |
| Shared utilities       | High     | Phase 1 | Code consolidation |
| Testing infrastructure | High     | Phase 5 | Jest/Vitest setup  |

### Questions (Answered)

1. **Error Handling**: Standardized via FatTipsError classes with ephemeral user messages
2. **Logging**: Winston for app logs, Sentry for errors, transaction logs separate
3. **Monitoring**: Sentry implemented for error tracking
4. **Backups**: Recommend daily automated backups (not yet implemented)

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+
- PostgreSQL 14+
- Git

### Quick Start

```bash
# 1. Clone repository
git clone https://github.com/yourusername/fattips.git
cd fattips

# 2. Install dependencies
pnpm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your values

# 4. Start database
docker-compose up -d postgres

# 5. Run migrations
pnpm db:migrate

# 6. Start development
pnpm dev
```

### Next Steps

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
2. Check [Phase 1 tasks](#phase-1-foundation-week-1-2)
3. Join Discord dev channel (if applicable)
4. Set up development environment

---

## References

- [Architecture Analysis](./docs/ARCHITECTURE.md) - Comprehensive codebase analysis
- [Architecture Improvement Plan](./docs/ARCHITECTURE_PLAN.md) - Implementation roadmap for code quality improvements
- [Discord.js Guide](https://discordjs.guide/)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Jupiter API](https://station.jup.ag/docs/apis/price-api)
- [Prisma ORM](https://www.prisma.io/docs)

### Tools

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Solana Explorer](https://explorer.solana.com/)
- [Helius Dashboard](https://www.helius.xyz/)

---

## Changelog

| Date       | Version | Changes                                          |
| ---------- | ------- | ------------------------------------------------ |
| 2026-02-07 | 0.2.0   | Added architecture analysis and improvement plan |
| 2024-XX-XX | 0.1.0   | Initial roadmap                                  |

---

## License

MIT License - See [LICENSE](./LICENSE)

---

**Last Updated:** 2024

**Maintainer:** @yourusername

**Contributors:** See [CONTRIBUTORS.md](./CONTRIBUTORS.md)
