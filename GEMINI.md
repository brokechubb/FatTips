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

### Build & Maintenance
- `pnpm build`: Build all workspace packages and apps.
- `pnpm test`: Run tests across the monorepo (uses `vitest` in `packages/solana`).
- `pnpm lint`: Run ESLint check.
- `pnpm format`: Format the entire codebase using Prettier.
- `pnpm typecheck`: Run TypeScript type checking.

## 🛠️ Development Conventions

### 1. Security First (Non-Custodial)
- **Private Keys**: Never store private keys in plain text. Use `WalletService` for encryption/decryption using a master key and PBKDF2-derived salts.
- **User DMs**: Sensitive information (mnemonics, private keys) must only be sent via Direct Messages or ephemeral responses.

### 2. Code Style & Structure
- **TypeScript**: Strictly type all functions, especially those involving financial amounts and addresses.
- **Services Pattern**: Logic should reside in service classes (e.g., `AirdropService`, `WalletService`) rather than directly in command handlers.
- **Shared Constants**: Use `packages/shared` for constants used across multiple apps (like token mints or Redis keys).

### 3. Database Operations
- Always use the Prisma client from `fattips-database` workspace.
- Index frequently queried fields like `walletPubkey`, `discordId`, and `status`.

### 4. Solana Integration
- Use the `JupiterPriceService` for all USD-related calculations to ensure consistency with the user experience.
- Prefer `fattips-solana` wrappers over raw `@solana/web3.js` calls for consistency in error handling and logging.

## 📦 Project Dependencies
- **Runtime**: Node.js (>=18.0.0), PostgreSQL, Redis.
- **Key Libraries**: `discord.js`, `express`, `prisma`, `@solana/web3.js`, `bullmq`, `zod`, `sentry`.

---
*This file serves as a guide for Gemini CLI to understand the FatTips codebase.*
