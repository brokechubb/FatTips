# FatTips - Gemini Project Context

FatTips is a **non-custodial social tipping layer for Solana**, primarily integrated into Discord. It enables users to tip, send, and airdrop SOL, USDC, and USDT directly within chat while maintaining full ownership of their private keys.

## 🏗️ Architecture Overview

The project is a monorepo managed with **pnpm** and **Turborepo**, following a modular structure:

- **`apps/bot`**: The Discord bot interface using `discord.js`.
  - Handles slash commands, prefix commands (`f` by default), and interactive UI (buttons/modals).
  - Uses `bullmq` for transaction queueing and `winston` for logging.
- **`apps/api`**: Express REST API for system management and external integrations.
  - Endpoints for users, wallets, balances, transactions, airdrops, and swaps.
  - Authenticated via API keys.
- **`apps/web`**: Next.js dashboard (Phase 8 - planned/in progress).
- **`packages/database`**: Data persistence layer using **Prisma** and **PostgreSQL**.
  - Models: `User`, `Transaction`, `Airdrop`, `AirdropParticipant`, `GuildSettings`, `ApiKey`.
- **`packages/solana`**: Core blockchain logic.
  - **WalletService**: Handles keypair generation and **AES-256-GCM encryption** for private keys.
  - **PriceService**: Real-time USD-to-token conversion via **Jupiter Price API**.
  - **TransactionService**: Handles on-chain transfers and withdrawals.
- **`packages/shared`**: Common utilities, constants, and shared Redis configuration.

## 🚀 Key Commands

### Development
- `pnpm install`: Install all dependencies.
- `pnpm dev`: Start both the bot and API in development mode (with watch).
- `pnpm db:migrate`: Apply database migrations.
- `pnpm db:generate`: Regenerate Prisma client.
- `pnpm db:studio`: Launch Prisma Studio for database inspection.
- `pnpm db:seed`: Seed database with initial/test data.

### Docker
- `pnpm docker:up`: Start all services using Docker Compose.
- `pnpm docker:down`: Stop all Docker services.

### Build & Maintenance
- `pnpm build`: Build all workspace packages and apps.
- `pnpm test`: Run tests across the monorepo (uses `vitest` in `packages/solana`).
- `pnpm lint`: Run ESLint check.
- `pnpm format`: Format the entire codebase using Prettier.
- `pnpm typecheck`: Run TypeScript type checking.

## 🚢 Production Deployment

The production environment on `codestats.gg` deviates slightly from local development.

- **Deployment**: Use `./scripts/deploy-prod.sh` to build, upload, and deploy automatically.
- **Docker**: Production images use `pnpm deploy` for isolated builds.
- **Database**: `DATABASE_URL` points to the `postgres` service in `docker-compose.yml`.
- **Maintenance**: Scripts in `scripts/` handle cleanup and backups (e.g., `cleanup-airdrops.js`).

## 🛠️ Development Conventions

### 1. Security First (Non-Custodial)
- **Private Keys**: NEVER store private keys in plain text. Use `WalletService` for encryption/decryption.
- **Logs**: NEVER log private keys or seed phrases.
- **User DMs**: Sensitive information must only be sent via Direct Messages or ephemeral responses. Do NOT transmit keys via standard DMs as they are not E2EE.

### 2. Code Style & Structure
- **TypeScript**: Strictly type all functions. Target ES2022, NodeNext. Use explicit types for parameters and returns.
- **Formatting**: Prettier (semicolons, single quotes, 2 spaces, 100 print width).
- **Naming**: `kebab-case.ts` for files, `camelCase` for functions/vars, `PascalCase` for Classes/Types.
- **Services Pattern**: Logic should reside in service classes rather than directly in command handlers.
- **Imports**: Order: external → internal packages → relative. Use absolute imports (e.g., `@fattips/database`).

### 3. Error Handling & Database
- **Try-Catch**: Always use for async operations and database calls.
- **Financials**: Use `Decimal` for financial calculations, NEVER floating-point math.
- **Transactions**: Use `prisma.$transaction` for multi-step operations.

### 4. Solana Integration
- **Validation**: Always validate `PublicKey` before use.
- **Jupiter**: Use `JupiterPriceService` for all USD conversions.
- **Transaction Safety**: Include `ComputeBudgetProgram` priority fees. Use `BullMQ` for heavy transactions.

## 🔑 Key Rules

0. **WORK OFF THE ROADMAP.md** and keep it updated with progress.
1. **Never commit `.env` files** - Use `.env.example`.
2. **Always run `pnpm db:generate`** after schema changes.
3. **Test thoroughly** before deploying.
4. **Early Returns**: Use early returns for guard clauses in Discord handlers.

## 🔄 Git Workflow

- Feature branches from `main`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`.
- Run `pnpm lint && pnpm typecheck` before committing.
- Update `CHANGELOG.md` before deploying.

---
*This file serves as a guide for Gemini CLI to understand the FatTips codebase.*
