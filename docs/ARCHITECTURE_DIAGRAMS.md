# FatTips Architecture Diagrams

Visual representations of the FatTips system architecture.

---

## 1. System Context Diagram (C4 Level 1)

```
┌─────────────────────────────────────────────────────────────────┐
│                         USERS                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ Discord  │  │ Jakey    │  │ External │  │ Administrators │ │
│  │ Users    │  │ Bot      │  │ Services │  │                │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬────────┘ │
└───────┼─────────────┼─────────────┼─────────────────┼──────────┘
        │             │             │                 │
        │ Discord     │ REST API    │ API Calls       │ Admin
        │ Commands    │ Calls       │                 │ Endpoints
        │             │             │                 │
┌───────▼─────────────▼─────────────▼─────────────────▼──────────┐
│                                                                │
│                    FatTips System                              │
│                                                                │
└────────────────────────┬───────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
│   Solana      │ │ PostgreSQL │ │   Redis      │
│   Blockchain  │ │ Database   │ │   Cache      │
└───────────────┘ └────────────┘ └──────────────┘
```

---

## 2. Container Diagram (C4 Level 2)

```
┌─────────────────────────────────────────────────────────────────┐
│  FatTips Monorepo                                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  apps/bot (Discord Bot)                                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Commands     │  │ Handlers     │  │ Services     │ │   │
│  │  │ /tip,/airdrop│  │ Buttons,     │  │ Airdrop,     │ │   │
│  │  │ /balance     │  │ Modals       │  │ Activity     │ │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
│  │  ┌──────────────┐  ┌──────────────┐                    │   │
│  │  │ Queues       │  │ Workers      │                    │   │
│  │  │ BullMQ       │  │ Transaction  │                    │   │
│  │  └──────────────┘  └──────────────┘                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  apps/api (REST API)                                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Middleware   │  │ Routes       │  │ Services     │ │   │
│  │  │ Auth, Rate   │  │ /api/send,   │  │ Business     │ │   │
│  │  │ Limiting     │  │ /airdrops    │  │ Logic        │ │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  packages/database (Prisma)                             │   │
│  │  ┌──────────────────────────────────────────────────┐   │   │
│  │  │ Schema: User, Transaction, Airdrop,              │   │   │
│  │  │ AirdropParticipant, AirdropPoolWallet, ApiKey   │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  packages/solana (Blockchain)                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Wallet       │  │ Transaction  │  │ Price        │ │   │
│  │  │ Generation,  │  │ Transfers,   │  │ Service      │ │   │
│  │  │ Encryption   │  │ Swaps        │  │ (Jupiter)    │ │   │
│  │  └──────────────┘  ┌──────────────┐  ┌──────────────┐ │   │
│  │                    │ Balance      │  │ Swap         │ │   │
│  │                    │ Queries      │  │ Execution    │ │   │
│  │                    └──────────────┘  └──────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  packages/shared (Utilities)                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Constants    │  │ Redis        │  │ Activity     │ │   │
│  │  │ Token Mints, │  │ Client,      │  │ Tracking,    │ │   │
│  │  │ Thresholds   │  │ Pub/Sub      │  │ Airdrop Pool │ │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Diagram - Bot

```
┌─────────────────────────────────────────────────────────────────┐
│  Discord Bot (discord.js v14)                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Entry Point (index.ts)                                  │  │
│  │  - Client initialization                                 │  │
│  │  - Command registration                                  │  │
│  │  - Event handlers (interactionCreate, messageCreate)    │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                         │
│         ┌─────────────┼─────────────┐                          │
│         │             │             │                          │
│  ┌──────▼──────┐ ┌────▼──────┐ ┌───▼──────────┐               │
│  │ Commands    │ │ Handlers  │ │ Services     │               │
│  │ - /tip      │ │ - Prefix  │ │ - Airdrop    │               │
│  │ - /balance  │ │ - Buttons │ │ - Activity   │               │
│  │ - /airdrop  │ │ - Modals  │ │              │               │
│  │ - /rain     │ │ - Selects │ │              │               │
│  │ - /send     │ │           │ │              │               │
│  │ - /swap     │ │           │ │              │               │
│  └──────┬──────┘ └────┬──────┘ └───┬──────────┘               │
│         │             │             │                          │
│         └─────────────┼─────────────┘                          │
│                       │                                        │
│              ┌────────▼────────┐                              │
│              │ Transaction     │                              │
│              │ Queue (BullMQ)  │                              │
│              └────────┬────────┘                              │
│                       │                                        │
│              ┌────────▼────────┐                              │
│              │ Transaction     │                              │
│              │ Worker          │                              │
│              │ - Submit to     │                              │
│              │   Solana        │                              │
│              │ - Update DB     │                              │
│              │ - Notify User   │                              │
│              └─────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Diagram - API

```
┌─────────────────────────────────────────────────────────────────┐
│  REST API (Express)                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Middleware Stack                                        │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │  │
│  │  │ Helmet       │ │ CORS         │ │ Body Parser  │    │  │
│  │  │ (Security)   │ │ (Cross-      │ │ (JSON)       │    │  │
│  │  │              │ │  origin)     │ │              │    │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘    │  │
│  │  ┌──────────────┐ ┌──────────────┐                     │  │
│  │  │ Rate Limit   │ │ Auth         │                     │  │
│  │  │ (60/min)     │ │ (API Key)    │                     │  │
│  │  └──────────────┘ └──────────────┘                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Routes                                                  │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │  │
│  │  │ /api/wallet │ │ /api/send   │ │ /api/swap   │        │  │
│  │  │ - /create   │ │ - /tip      │ │ - /quote    │        │  │
│  │  │             │ │ - /withdraw │ │ - /execute  │        │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘        │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │  │
│  │  │ /airdrops   │ │ /rain       │ │ /activity   │        │  │
│  │  │ - /create   │ │ - /create   │ │ - /active   │        │  │
│  │  │ - /:id/claim│ │             │ │ - /count    │        │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Shared Services                                         │  │
│  │  - TransactionService                                    │  │
│  │  - AirdropService                                        │  │
│  │  - PriceService                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Flow - Tip Command

```
User: /tip @friend $5
         │
         ▼
┌────────────────────────┐
│ 1. Command Handler     │
│    (tip.ts:execute)    │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 2. Validate Balance    │
│    - Check SOL for gas │
│    - Check token       │
│      balance           │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 3. Create Transaction  │
│    - Decrypt wallet    │
│    - Build transfer    │
│    - Add priority fee  │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 4. Queue Transaction   │
│    (BullMQ)            │
│    - Add to queue      │
│    - Return job ID     │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 5. Transaction Worker  │
│    (Background)        │
│    - Pop from queue    │
│    - Submit to Solana  │
│    - Wait for confirm  │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 6. Update Database     │
│    (prisma.$transaction)│
│    - Create Transaction│
│    - Update balances   │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ 7. Notify User         │
│    - Channel reply     │
│    - Or DM (withdraw)  │
└────────────────────────┘
```

---

## 6. Data Flow - Airdrop Creation

```
User: /airdrop amount:$10 duration:1h
           │
           ▼
┌──────────────────────────┐
│ 1. Airdrop Command       │
│    (airdrop.ts:execute)  │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 2. Get Pool Wallet       │
│    AirdropPoolService    │
│    .getWallet()          │
│                          │
│    - Fetch available     │
│    - Mark as busy        │
│    - Return encrypted    │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 3. Fund Pool Wallet      │
│    - Creator transfers   │
│      (rent + gas)        │
│    - 0.00089 SOL rent    │
│    - ~0.001 SOL gas      │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 4. Create DB Record      │
│    Airdrop {             │
│      status: ACTIVE,     │
│      expiresAt: ...,     │
│      walletPubkey: ...   │
│    }                     │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 5. Post to Discord       │
│    - Embed with Claim    │
│      button              │
│    - channelId stored    │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 6. Users Click Claim     │
│    - Add participant     │
│    - Update count        │
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│ 7. Settlement            │
│    [Timer expires OR     │
│     max reached]         │
│                          │
│    - Distribute funds    │
│    - Update status       │
│    - Release wallet      │
└──────────────────────────┘
```

---

## 7. Airdrop Pool Wallet Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                   AirdropPoolWallet Table                    │
│  ┌─────────────┬──────────────┬──────────┬──────────────┐  │
│  │ address     │ encryptedKey │ isBusy   │ lastUsedAt   │  │
│  ├─────────────┼──────────────┼──────────┼──────────────┤  │
│  │ 9HMqa...    │ (encrypted)  │ false    │ 2026-03-09   │  │
│  │ ABC12...    │ (encrypted)  │ true     │ 2026-03-09   │  │
│  │ XYZ99...    │ (encrypted)  │ false    │ 2026-03-08   │  │
│  └─────────────┴──────────────┴──────────┴──────────────┘  │
└─────────────────────────────────────────────────────────────┘
           │
           │ getWallet()
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Acquire Wallet                                            │
│    - Find: isBusy = false                                    │
│    - Update: isBusy = true                                   │
│    - Return encrypted key                                    │
└─────────────────────────────────────────────────────────────┘
           │
           │ Creator funds wallet
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Airdrop Active                                            │
│    - Wallet holds funds                                      │
│    - Users claim                                             │
│    - Participants tracked in DB                              │
└─────────────────────────────────────────────────────────────┘
           │
           │ Settlement (expiry/max reached)
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Distribute Funds                                          │
│    - Transfer to winners                                     │
│    - Update Airdrop.status = SETTLED                         │
│    - Sweep residual funds (optional)                         │
└─────────────────────────────────────────────────────────────┘
           │
           │ releaseWallet()
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Release to Pool                                           │
│    - Update: isBusy = false                                  │
│    - Update: lastUsedAt = now()                              │
│    - Wallet available for next airdrop                       │
└─────────────────────────────────────────────────────────────┘
           │
           │ Weekly cleanup (Sunday 3 AM)
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Cleanup (if residual)                                     │
│    - Drain dust to treasury                                  │
│    - Keep 0.00089 SOL (rent)                                 │
│    - Mark as cleaned                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Database Entity Relationship

```
┌──────────────────────────────────────────────────────────────────┐
│                         User                                      │
│  ┌─────────────┬──────────────┬──────────────┬───────────────┐ │
│  │ discordId   │ walletPubkey │ encrypted... │ keySalt       │ │
│  │ (PK)        │ (UNIQUE)     │ Privkey      │               │ │
│  └─────────────┴──────────────┴──────────────┴───────────────┘ │
│           │                    │                               │
│           │ sentTips           │ receivedTips                  │
│           ▼                    ▼                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Transaction                           │   │
│  │  ┌─────────┬─────────┬─────────┬──────────┬──────────┐ │   │
│  │  │ id (PK) │ fromId  │ toId    │ amount   │ txType   │ │   │
│  │  │         │ (FK)    │ (FK)    │          │          │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│           │ airdropsCreated                                     │
│           ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                     Airdrop                             │   │
│  │  ┌─────────┬──────────┬─────────┬──────────┬─────────┐ │   │
│  │  │ id (PK) │ creatorId│ amount  │ status   │ expires │ │   │
│  │  │         │ (FK)     │         │          │         │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                      │                                          │
│                      │ participants                              │
│                      ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              AirdropParticipant                          │   │
│  │  ┌─────────┬──────────┬─────────┬──────────┬─────────┐ │   │
│  │  │ id (PK) │ airdropId│ userId  │ shareAmt │ status  │ │   │
│  │  │         │ (FK)     │ (FK)    │          │         │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              AirdropPoolWallet                           │   │
│  │  ┌──────────────┬──────────────┬──────────┬──────────┐ │   │
│  │  │ address (PK) │ encryptedKey │ isBusy   │ lastUsed │ │   │
│  │  └──────────────┴──────────────┴──────────┴──────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Production Server (VPS)                       │
│                   codestats.gg (SSH: 1337)                      │
│                   Path: /opt/FatTips                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Docker Network (isolated)                               │  │
│  │                                                          │  │
│  │  ┌──────────────────┐    ┌──────────────────┐           │  │
│  │  │ fattips-bot      │    │ fattips-api      │           │  │
│  │  │                  │    │                  │           │  │
│  │  │ Image: fattips-  │    │ Image: fattips-  │           │  │
│  │  │ bot:latest       │    │ api:latest       │           │  │
│  │  │                  │    │ Port: 3001       │           │  │
│  │  │ Depends:         │    │ Depends:         │           │  │
│  │  │ - postgres       │    │ - postgres       │           │  │
│  │  │ - redis          │    │ - redis          │           │  │
│  │  └──────────────────┘    └──────────────────┘           │  │
│  │                                                          │  │
│  │  ┌──────────────────┐    ┌──────────────────┐           │  │
│  │  │ fattips-db       │    │ fattips-redis    │           │  │
│  │  │                  │    │                  │           │  │
│  │  │ Image: postgres: │    │ Image: redis:7-  │           │  │
│  │  │ 16-alpine        │    │ alpine           │           │  │
│  │  │                  │    │                  │           │  │
│  │  │ Volume:          │    │ Volume:          │           │  │
│  │  │ postgres_data    │    │ redis_data       │           │  │
│  │  └──────────────────┘    └──────────────────┘           │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  External Access:                                               │
│  - Discord API (bot ↔ Discord)                                 │
│  - Solana RPC (bot ↔ Helius)                                   │
│  - API port 3001 (localhost only)                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Communication Patterns

```
┌─────────────────────────────────────────────────────────────────┐
│                    Communication Matrix                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Bot ↔ Database                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Protocol: Prisma Client (PostgreSQL)                     │   │
│  │ Usage: User data, transactions, airdrops                 │   │
│  │ Pattern: Direct connection, connection pooling           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Bot ↔ Solana                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Protocol: JSON-RPC (via @solana/web3.js)                │   │
│  │ Provider: Helius (mainnet)                               │   │
│  │ Commitment: confirmed (for balance checks)               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Bot ↔ API                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Protocol: Redis Pub/Sub                                  │   │
│  │ Channel: airdrop-events                                  │   │
│  │ Event: AIRDROP_CREATED                                   │   │
│  │ Payload: { airdropId, channelId, creatorDiscordId }     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Bot ↔ Discord                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Protocol: WebSocket (discord.js)                         │   │
│  │ Events: interactionCreate, messageCreate                 │   │
│  │ Intents: Guilds, Messages, MessageContent                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  API ↔ External Services                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Protocol: REST (HTTPS)                                   │   │
│  │ Auth: X-API-Key header                                   │   │
│  │ Rate Limit: 60/min (global), 10/min (financial)          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Services ↔ Redis                                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Usage:                                                   │   │
│  │ - BullMQ queues (transaction-queue)                      │   │
│  │ - Pub/Sub (airdrop-events)                               │   │
│  │ - Activity tracking (sorted sets)                        │   │
│  │ - Caching (prices, balances)                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Error Handling Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                 Error Handling Strategy                          │
└─────────────────────────────────────────────────────────────────┘

User Action
     │
     ▼
┌────────────────────────┐
│ Try Block              │
│ - Command execution    │
│ - Database operation   │
│ - Solana transaction   │
└───────────┬────────────┘
            │
            │ Error thrown
            ▼
┌────────────────────────┐
│ Catch Block            │
│                        │
│ 1. Log with context    │
│    (Winston)           │
│                        │
│ 2. Capture in Sentry   │
│    - Tags: command,    │
│      userId, guildId   │
│    - Context: params   │
│                        │
│ 3. User-friendly msg   │
│    - Ephemeral reply   │
│    - Or DM             │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Specific Handling      │
│                        │
│ Discord Error 50001:   │
│ - User blocked bot     │
│ - Log warning          │
│                        │
│ Discord Error 10008:   │
│ - Unknown message      │
│ - User deleted it      │
│ - Log warning          │
│                        │
│ Solana: Insufficient   │
│ - Show balance needed  │
│ - Suggest deposit      │
└────────────────────────┘
```

---

## 12. Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Security Layers                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: Authentication                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ - Discord: Bot token (env var)                          │   │
│  │ - API: Per-user API keys (64-char hex)                  │   │
│  │ - Admin: Separate admin API key                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 2: Authorization                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ - requireAuth middleware                                │   │
│  │ - requireOwnership middleware (enforce wallet ownership) │   │
│  │ - Command permissions (guild-only, DM-allowed)          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 3: Encryption                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Algorithm: AES-256-GCM                                  │   │
│  │ Key: Master key from MASTER_ENCRYPTION_KEY env var      │   │
│  │ Salt: Unique per user (stored in DB)                    │   │
│  │ Storage: encryptedPrivkey + keySalt in User table       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 4: Network                                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ - Docker network isolation                                │   │
│  │ - API port 3001 bound to localhost                        │   │
│  │ - Database not exposed externally                         │   │
│  │ - CORS configured for web dashboard                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 5: Application                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ - Helmet.js (security headers)                          │   │
│  │ - Rate limiting (60/min global, 10/min financial)       │   │
│  │ - Input validation (Zod)                                │   │
│  │ - No secrets in logs                                    │   │
│  │ - Ephemeral responses for sensitive data                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

**End of Architecture Diagrams**
