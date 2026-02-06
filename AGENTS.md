# FatTips - Agent Guidelines

AI coding agent guidelines for the FatTips monorepo.

## Project Overview

FatTips is a Solana-based Discord tipping bot with airdrop functionality.

- **Monorepo**: Turborepo with pnpm workspaces
- **Apps**: Discord bot (Node.js), REST API (Express), Web dashboard (Next.js)
- **Smart Contract**: Anchor framework (Rust)
- **Database**: PostgreSQL with Prisma ORM

**WORK OFF THE ROADMAP.md AND KEEP IT UPDATED WITH PROGRESS**

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Development (runs all apps in parallel)
pnpm dev

# Build all apps
pnpm build

# Lint all apps
pnpm lint

# Format code
pnpm format

# Type checking
pnpm typecheck

# Database commands
pnpm db:generate    # Generate Prisma client
pnpm db:migrate     # Run migrations
pnpm db:studio      # Open Prisma Studio
pnpm db:seed        # Seed database

# Smart contract (Anchor)
pnpm contract:build
pnpm contract:test
pnpm contract:deploy

# Docker
pnpm docker:up      # Start all services
pnpm docker:down    # Stop all services
```

## Code Style Guidelines

### TypeScript Configuration

- **Target**: ES2022
- **Module**: NodeNext
- **Strict mode**: Enabled
- Always use explicit types for function parameters and return values

### Formatting (Prettier)

- Semicolons: **Required**
- Single quotes: **Yes**
- Trailing commas: **ES5 compatible**
- Print width: **100 characters**
- Tab width: **2 spaces** (no tabs)

### Imports & Exports

```typescript
// Order: external libraries → internal packages → relative imports
import { Client } from 'discord.js';
import { prisma } from '@fattips/database';
import { formatAmount } from './utils';

// Use named exports for utilities
export function helper() {}

// Use default exports for components/classes
export default class MyClass {}
```

### Naming Conventions

- **Files**: `kebab-case.ts` (e.g., `wallet-service.ts`)
- **Functions/Variables**: `camelCase`
- **Classes/Types/Interfaces**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Database Models**: `PascalCase` (matches Prisma schema)
- **Environment Variables**: `UPPER_SNAKE_CASE`

### Error Handling

```typescript
// Always use try-catch for async operations
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  // Log with context
  console.error('Context: failed to process tip', error);

  // Return user-friendly error
  throw new Error('Failed to process tip. Please try again.');
}

// Never use `any` - use `unknown` and narrow
function handleError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}
```

### Database (Prisma)

```typescript
// Use Decimal for financial calculations
import { Decimal } from '@prisma/client/runtime/library';

// Always wrap database calls in try-catch
// Use transactions for multi-step operations
await prisma.$transaction([
  prisma.user.update({...}),
  prisma.transaction.create({...})
]);
```

### Solana Development

```typescript
// Use @solana/web3.js for blockchain interactions
// Always validate addresses before use
import { PublicKey } from '@solana/web3.js';

function validateAddress(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new Error('Invalid Solana address');
  }
}
```

### Discord Bot Patterns

```typescript
// Command handlers in separate files
// Use early returns for guard clauses
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  // Handle command
});
```

## Project Structure

```
apps/
  bot/          # Discord bot
  api/          # REST API
  web/          # Next.js dashboard
packages/
  database/     # Prisma schema & client
  shared/       # Shared utilities
  solana/       # Solana wrappers
programs/
  airdrop/      # Anchor smart contract
docs/           # Documentation
```

## Key Rules

1. **Never commit `.env` files** - Use `.env.example` for templates
2. **Always run `pnpm db:generate` after schema changes**
3. **Use absolute imports** with package names (e.g., `@fattips/database`)
4. **Test thoroughly** before deploying
5. **Financial precision**: Use `Decimal` type, never floating-point math
6. **Security**: Never log private keys or seed phrases

## Testing

Currently minimal testing setup. When adding tests:

- Use Jest or Vitest
- Place test files next to source files: `*.test.ts`
- Mock external APIs (Discord, Solana)

## Git Workflow

- Create feature branches from `main`
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Run `pnpm lint && pnpm typecheck` before committing
