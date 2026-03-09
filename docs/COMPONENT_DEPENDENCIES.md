# Component Dependencies

**FatTips Module Dependency Graph**

---

## 1. High-Level Dependency Graph

```
                    FatTips Monorepo
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   ┌────▼────┐       ┌────▼────┐      ┌────▼────┐
   │  apps/  │       │packages/│      │programs/│
   │         │       │         │      │         │
   │  • bot  │──────▶│  • db   │      │ (empty) │
   │  • api  │──────▶│  • solana     │
   │         │       │  • shared │     │
   └─────────┘       └────┬────┘      └─────────┘
                          │
                          ▼
                   External Dependencies
                   (npm packages, RPC)
```

---

## 2. Application Dependencies

### apps/bot

```json
{
  "name": "@fattips/bot",
  "dependencies": {
    "discord.js": "^14.x",
    "@fattips/database": "workspace:*",
    "@fattips/solana": "workspace:*",
    "@fattips/shared": "workspace:*",
    "@sentry/node": "^7.x",
    "@sentry/profiling-node": "^7.x",
    "bullmq": "^4.x",
    "ioredis": "^5.x",
    "winston": "^3.x",
    "dotenv": "^16.x"
  }
}
```

**Key Imports:**

```typescript
// Discord
import { Client, GatewayIntentBits } from 'discord.js';

// Internal packages
import { prisma } from '@fattips/database';
import { TransactionService } from '@fattips/solana';
import { RedisService } from '@fattips/shared';

// Local
import { AirdropService } from './services/airdrop';
import { logger } from './utils/logger';
```

**Dependency Chain:**

```
apps/bot
  ├── @fattips/database
  │     └── @prisma/client
  │
  ├── @fattips/solana
  │     ├── @solana/web3.js
  │     ├── @solana/spl-token
  │     └── jupiter-api
  │
  ├── @fattips/shared
  │     ├── ioredis
  │     └── bullmq
  │
  └── External
        ├── discord.js
        ├── @sentry/node
        └── winston
```

---

### apps/api

```json
{
  "name": "@fattips/api",
  "dependencies": {
    "express": "^4.x",
    "cors": "^2.x",
    "helmet": "^7.x",
    "morgan": "^1.x",
    "express-rate-limit": "^7.x",
    "@fattips/database": "workspace:*",
    "@fattips/solana": "workspace:*",
    "@fattips/shared": "workspace:*",
    "dotenv": "^16.x"
  }
}
```

**Key Imports:**

```typescript
// Express ecosystem
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Internal packages
import { prisma } from '@fattips/database';
import { TransactionService, PriceService } from '@fattips/solana';
import { RedisService } from '@fattips/shared';

// Local
import { requireAuth } from './middleware/auth';
```

**Dependency Chain:**

```
apps/api
  ├── @fattips/database
  │     └── @prisma/client
  │
  ├── @fattips/solana
  │     ├── @solana/web3.js
  │     └── @solana/spl-token
  │
  ├── @fattips/shared
  │     └── ioredis
  │
  └── External
        ├── express
        ├── cors
        ├── helmet
        └── morgan
```

---

## 3. Package Dependencies

### packages/database

```json
{
  "name": "@fattips/database",
  "devDependencies": {
    "prisma": "^5.x",
    "typescript": "^5.x"
  },
  "dependencies": {
    "@prisma/client": "^5.x"
  }
}
```

**Purpose:** Prisma ORM wrapper, database client export

**Key Files:**

- `prisma/schema.prisma` - Database schema
- `src/index.ts` - Prisma client export

**Usage:**

```typescript
import { prisma } from '@fattips/database';

const user = await prisma.user.findUnique({
  where: { discordId: '123' },
});
```

---

### packages/solana

```json
{
  "name": "@fattips/solana",
  "dependencies": {
    "@solana/web3.js": "^1.x",
    "@solana/spl-token": "^0.3.x",
    "bs58": "^5.x",
    "tweetnacl": "^1.x"
  }
}
```

**Purpose:** Blockchain interactions (wallets, transactions, prices)

**Modules:**

- `wallet.ts` - Wallet generation, encryption
- `transaction.ts` - Transfers, withdrawals
- `balance.ts` - Balance queries
- `price.ts` - Jupiter Price API
- `swap.ts` - Jupiter swap execution

**Usage:**

```typescript
import {
  TransactionService,
  WalletService,
  PriceService
} from '@fattips/solana';

const balance = await BalanceService.getBalance(pubkey);
const tx = await TransactionService.transfer(...);
```

---

### packages/shared

```json
{
  "name": "@fattips/shared",
  "dependencies": {
    "ioredis": "^5.x",
    "bullmq": "^4.x"
  }
}
```

**Purpose:** Common utilities, Redis client, constants

**Modules:**

- `redis.ts` - Redis client singleton
- `activity.ts` - Activity tracking (sorted sets)
- `airdrop-pool.ts` - Airdrop pool management
- `constants/` - Token mints, thresholds

**Usage:**

```typescript
import { RedisService, TOKEN_MINTS, MIN_SOL_FOR_GAS } from '@fattips/shared';

const redis = RedisService.getInstance();
```

---

## 4. External Dependencies (Critical)

### Runtime Dependencies

| Package             | Version | Used By          | Purpose              |
| ------------------- | ------- | ---------------- | -------------------- |
| `discord.js`        | ^14.x   | bot              | Discord API wrapper  |
| `@solana/web3.js`   | ^1.x    | solana, bot, api | Solana RPC client    |
| `@solana/spl-token` | ^0.3.x  | solana           | SPL token operations |
| `@prisma/client`    | ^5.x    | database         | Database ORM         |
| `ioredis`           | ^5.x    | shared           | Redis client         |
| `bullmq`            | ^4.x    | bot              | Job queues           |
| `express`           | ^4.x    | api              | REST framework       |
| `@sentry/node`      | ^7.x    | bot              | Error tracking       |

### Development Dependencies

| Package      | Version | Purpose             |
| ------------ | ------- | ------------------- |
| `typescript` | ^5.x    | Type checking       |
| `prisma`     | ^5.x    | Database migrations |
| `turbo`      | ^1.x    | Monorepo build tool |
| `prettier`   | ^3.x    | Code formatting     |
| `eslint`     | ^8.x    | Linting             |

---

## 5. Dependency Flow Diagrams

### Bot Dependency Flow

```
User Command (Discord)
        │
        ▼
┌───────────────────┐
│  discord.js       │◀── External
│  (Event Listener) │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Command Handler  │
│  (apps/bot/src/   │
│   commands/tip.ts)│
└─────────┬─────────┘
          │
          ├──────────────────┬──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ @fattips/   │   │ @fattips/   │   │ @fattips/   │
   │ database    │   │ solana      │   │ shared      │
   │             │   │             │   │             │
   │ - prisma    │   │ - web3.js   │   │ - redis     │
   │             │   │ - spl-token │   │ - bullmq    │
   └─────────────┘   └─────────────┘   └─────────────┘
```

### API Dependency Flow

```
HTTP Request
    │
    ▼
┌───────────────────┐
│  Express.js       │◀── External
│  (Middleware)     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Auth Middleware  │
│  (requireAuth)    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│  Route Handler    │
│  (apps/api/src/   │
│   routes/send.ts) │
└─────────┬─────────┘
          │
          ├──────────────────┬──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ @fattips/   │   │ @fattips/   │   │ @fattips/   │
   │ database    │   │ solana      │   │ shared      │
   │             │   │             │   │             │
   │ - prisma    │   │ - web3.js   │   │ - redis     │
   │             │   │ - jupiter   │   │             │
   └─────────────┘   └─────────────┘   └─────────────┘
```

---

## 6. Import Path Mapping

### Absolute Imports (Workspace)

```typescript
// Database package
import { prisma } from '@fattips/database';

// Solana package
import { TransactionService } from '@fattips/solana';

// Shared package
import { RedisService } from '@fattips/shared';
import { TOKEN_MINTS } from '@fattips/shared/constants';
```

### Relative Imports (Within Package)

```typescript
// Within bot
import { AirdropService } from './services/airdrop';
import { logger } from './utils/logger';

// Within api
import { requireAuth } from './middleware/auth';
import { requireOwnership } from './middleware/ownership';
```

---

## 7. Build Order (Turborepo)

```
1. packages/database
       ↓ (generates Prisma client)
   packages/solana
   packages/shared
       ↓ (depend on database)
   apps/bot
   apps/api
       ↓ (depend on all packages)
   (Final build artifacts in dist/)
```

**turbo.json Configuration:**

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```

---

## 8. Version Constraints

### Node.js

- **Minimum:** 18.0.0
- **Recommended:** 20.x LTS
- **Package Manager:** pnpm 8.x

### TypeScript

- **Version:** ^5.3.0
- **Target:** ES2022
- **Module:** NodeNext
- **Strict:** Enabled

### Prisma

- **CLI:** ^5.x
- **Client:** ^5.x
- **Generator:** prisma-client-js

---

## 9. External Services

### Critical Services

| Service     | Purpose           | Rate Limits      | Fallback               |
| ----------- | ----------------- | ---------------- | ---------------------- |
| Discord API | Bot communication | 50/s (global)    | Retry with backoff     |
| Helius RPC  | Solana blockchain | 100 req/s (free) | Multiple RPC endpoints |
| Jupiter API | Token prices      | 10 req/s         | Cache (60s TTL)        |
| Sentry      | Error tracking    | 5k errors/day    | Local logging          |

### Environment Variables Required

```bash
# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Database
DATABASE_URL=

# Solana
SOLANA_RPC_URL=
MASTER_ENCRYPTION_KEY=

# Redis
REDIS_HOST=
REDIS_PORT=

# API
PORT=
X_API_KEY=

# Monitoring
SENTRY_DSN=
```

---

## 10. Circular Dependencies

**None detected** - The architecture is intentionally acyclic:

```
apps/*  →  packages/*  →  external deps
   ↑           ↑
   │           │
   └───────────┘
   (no reverse deps)
```

**Best Practice:** Packages (`@fattips/*`) never import from apps. Apps import packages, not each other.

---

## 11. Tree Shaking Opportunities

### Current State

- All packages are fully imported
- No tree shaking implemented

### Potential Optimizations

1. **Modular imports from `@solana/web3.js`**

   ```typescript
   // Instead of:
   import * as web3 from '@solana/web3.js';

   // Use:
   import { PublicKey, Transaction } from '@solana/web3.js';
   ```

2. **Split `@fattips/solana` into submodules**
   - `@fattips/solana/wallet`
   - `@fattips/solana/transaction`
   - `@fattips/solana/price`

---

## 12. Dependency Health

### ✅ Good Practices

- Workspace protocol (`workspace:*`) for internal deps
- Pin major versions (^x.y.z)
- No peer dependencies
- Clear separation of concerns

### ⚠️ Watch List

- `discord.js` v14 is latest (stay updated)
- `@prisma/client` requires regeneration after schema changes
- `bullmq` requires Redis 6+ (currently on Redis 7)
- Node.js 18 LTS end-of-life: April 2025

---

**End of Component Dependencies**
