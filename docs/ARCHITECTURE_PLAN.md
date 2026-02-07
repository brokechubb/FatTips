# FatTips Architecture Improvement Plan

**Date:** 2026-02-07
**Status:** Planning Phase
**Based on:** Architecture Analysis completed 2026-02-07

---

## Executive Summary

This document outlines the implementation plan for actionable insights and architectural improvements identified during the codebase analysis. The plan prioritizes items by impact and dependencies.

---

## Phase 1: Shared Utilities Consolidation

**Goal:** Eliminate code duplication across commands

### 1.1 Extract Amount Parser Utility

**Files to create/modify:**

- `packages/shared/src/utils/amountParser.ts`
- `packages/shared/src/constants/tokens.ts`

**Tasks:**

- [ ] Create `packages/shared/src/utils/amountParser.ts` with `parseAmountInput()` function
- [ ] Create `packages/shared/src/constants/tokens.ts` with `TOKEN_MINTS` and token metadata
- [ ] Update `apps/bot/src/commands/tip.ts` to import from shared package
- [ ] Update `apps/bot/src/commands/rain.ts` to import from shared package
- [ ] Update `apps/bot/src/commands/airdrop.ts` to import from shared package

**Code to extract:**

```typescript
// From tip.ts lines 430-462
interface ParsedAmount {
  valid: boolean;
  type?: 'usd' | 'token' | 'max';
  value: number;
  token?: string;
  error?: string;
}

function parseAmountInput(input: string): ParsedAmount {
  const trimmed = input.trim().toLowerCase();
  // ... regex parsing logic
}
```

### 1.2 Create Formatters Utility

**Files to create/modify:**

- `packages/shared/src/utils/formatters.ts`

**Tasks:**

- [ ] Extract `formatTokenAmount()` from tip.ts, rain.ts
- [ ] Extract `formatBalance()` from balance.ts in solana package
- [ ] Add `formatUsdAmount()` utility
- [ ] Export all formatters from package

---

## Phase 2: Error Handling Standardization

**Goal:** Consistent error handling across bot commands

### 2.1 Create Custom Error Classes

**Files to create:**

- `packages/shared/src/errors/FatTipsError.ts`

**Tasks:**

- [ ] Create base `FatTipsError` class with user-facing message
- [ ] Create specific error types:
  - `ValidationError` - Invalid input
  - `WalletError` - Wallet operations
  - `TransactionError` - Blockchain transactions
  - `AirdropError` - Airdrop-specific errors

### 2.2 Update Commands to Use Standardized Errors

**Files to modify:**

- `apps/bot/src/commands/tip.ts`
- `apps/bot/src/commands/airdrop.ts`
- `apps/bot/src/commands/rain.ts`
- `apps/bot/src/commands/wallet.ts`

**Tasks:**

- [ ] Wrap business logic in try-catch with FatTipsError
- [ ] Remove inline error handling patterns
- [ ] Ensure all errors sent to Sentry with context
- [ ] Ensure user-facing messages are ephemeral and friendly

---

## Phase 3: Service Layer Refactoring

**Goal:** Consolidate business logic into reusable services

### 3.1 Wallet Service Migration

**Files to create:**

- `apps/bot/src/services/walletService.ts`

**Tasks:**

- [ ] Move wallet creation logic from `wallet.ts` command to service
- [ ] Move wallet validation logic to service
- [ ] Create consistent interface for wallet operations
- [ ] Update `wallet.ts` command to delegate to service

### 3.2 Tip Service Creation

**Files to create:**

- `apps/bot/src/services/tipService.ts`

**Tasks:**

- [ ] Extract tip business logic from `tip.ts` command
- [ ] Handle multi-recipient logic
- [ ] Handle USD conversion
- [ ] Handle balance checking
- [ ] Handle transaction execution
- [ ] Update `tip.ts` command to delegate to service

### 3.3 Rain Service Creation

**Files to create:**

- `apps/bot/src/services/rainService.ts`

**Tasks:**

- [ ] Extract rain business logic from `rain.ts` command
- [ ] Share tip logic via composition or inheritance
- [ ] Handle activity-based user selection
- [ ] Update `rain.ts` command to delegate to service

---

## Phase 4: API Development

**Goal:** Complete REST API implementation

### 4.1 API Foundation

**Files to create/modify:**

- `apps/api/src/routes/users.ts`
- `apps/api/src/routes/transactions.ts`
- `apps/api/src/routes/airdrops.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/middleware/rateLimit.ts`

**Tasks:**

- [ ] Implement user endpoints:
  - `GET /api/users/:discordId` - User profile
  - `GET /api/users/:discordId/balance` - Wallet balance
- [ ] Implement transaction endpoints:
  - `GET /api/transactions` - List with pagination
  - `GET /api/transactions/:id` - Details
  - `GET /api/transactions?userId=xxx` - User history
- [ ] Implement airdrop endpoints:
  - `GET /api/airdrops` - Active airdrops
  - `GET /api/airdrops/:id` - Airdrop details
- [ ] Add authentication middleware (Discord OAuth)
- [ ] Add rate limiting middleware

### 4.2 API Documentation

**Files to create:**

- `docs/API.md`

**Tasks:**

- [ ] Document all endpoints
- [ ] Include request/response examples
- [ ] Document authentication flow
- [ ] Document rate limits

---

## Phase 5: Testing Infrastructure

**Goal:** Establish testing patterns and coverage

### 5.1 Test Setup

**Files to create/modify:**

- `jest.config.js` (or `vitest.config.ts`)
- `apps/bot/src/**/*.test.ts`
- `packages/solana/src/**/*.test.ts`

**Tasks:**

- [ ] Set up Jest or Vitest for testing
- [ ] Create mock utilities for Prisma
- [ ] Create mock utilities for Solana RPC
- [ ] Create mock utilities for Discord interactions

### 5.2 Unit Tests

**Priority areas:**

- [ ] `amountParser.ts` - Input parsing tests
- [ ] `walletService.ts` - Encryption/decryption tests
- [ ] `formatters.ts` - Formatting tests
- [ ] `priceService.ts` - Price conversion tests

### 5.3 Integration Tests

**Priority areas:**

- [ ] Tip flow (mocked blockchain)
- [ ] Airdrop creation and settlement (mocked blockchain)
- [ ] Wallet creation and retrieval
- [ ] Balance fetching

---

## Phase 6: Caching Implementation

**Goal:** Reduce RPC calls and API latency

### 6.1 Redis Integration

**Files to create/modify:**

- `apps/bot/src/services/cacheService.ts`
- Update `docker-compose.yml` to enable Redis

**Tasks:**

- [ ] Implement Redis client connection
- [ ] Create cache service for:
  - Token prices (5-minute TTL)
  - User balances (10-second TTL)
  - Activity tracking (session-based)

### 6.2 Update Services to Use Cache

**Files to modify:**

- `packages/solana/src/price.ts`
- `packages/solana/src/balance.ts`
- `apps/bot/src/services/activity.ts`

**Tasks:**

- [ ] Update `PriceService` to use cache
- [ ] Update `BalanceService` to use cache
- [ ] Migrate `ActivityService` to Redis-backed storage

---

## Phase 7: Security Hardening

**Goal:** Enhance security posture

### 7.1 Encryption Improvements

**Tasks:**

- [ ] Implement key rotation mechanism for master key
- [ ] Add key versioning to encrypted data
- [ ] Create secure key backup procedure documentation

### 7.2 Audit Logging

**Files to create/modify:**

- `apps/bot/src/services/auditService.ts`
- Update `utils/logger.ts`

**Tasks:**

- [ ] Create audit log service for security events
- [ ] Log all wallet access
- [ ] Log all private key exports
- [ ] Log all admin operations
- [ ] Create audit log export feature

### 7.3 Input Validation

**Tasks:**

- [ ] Add Discord mention parsing validation
- [ ] Add Solana address validation at service layer
- [ ] Add amount sanitization
- [ ] Add length limits on all inputs

---

## Phase 8: Documentation

**Goal:** Comprehensive and up-to-date documentation

### 8.1 Architecture Documentation

**Files to create:**

- `docs/ARCHITECTURE.md` (completed in analysis)
- `docs/SECURITY.md`
- `docs/DEPLOYMENT.md`

### 8.2 API Documentation

**Files to create:**

- `docs/API.md` (referenced in Phase 4)
- OpenAPI/Swagger specification

### 8.3 Contributing Guide

**Files to update:**

- `docs/CONTRIBUTING.md`

**Tasks:**

- [ ] Add coding standards
- [ ] Add testing requirements
- [ ] Add documentation requirements
- [ ] Add git workflow

---

## Implementation Order & Dependencies

```
Phase 1: Shared Utilities
    │
    ▼
Phase 2: Error Handling
    │   (depends on: Phase 1)
    ▼
Phase 3: Service Layer
    │   (depends on: Phase 1, Phase 2)
    ▼
Phase 5: Testing
    │   (depends on: Phase 3)
    ▼
Phase 4: API Development (can run in parallel with Phase 5)
    │
    ▼
Phase 6: Caching
    │
    ▼
Phase 7: Security
    │
    ▼
Phase 8: Documentation
```

---

## Effort Estimates

| Phase                     | Estimated Effort | Priority |
| ------------------------- | ---------------- | -------- |
| Phase 1: Shared Utilities | 2-4 hours        | High     |
| Phase 2: Error Handling   | 4-6 hours        | High     |
| Phase 3: Service Layer    | 8-12 hours       | High     |
| Phase 4: API Development  | 16-24 hours      | Medium   |
| Phase 5: Testing          | 16-24 hours      | High     |
| Phase 6: Caching          | 8-12 hours       | Medium   |
| Phase 7: Security         | 12-16 hours      | High     |
| Phase 8: Documentation    | 4-8 hours        | Low      |

**Total Estimated Effort:** 70-106 hours

---

## Success Metrics

### Code Quality

- [ ] Less than 5% duplicate code (measured by CPD or similar)
- [ ] Unit test coverage > 70%
- [ ] Zero `any` types in shared packages
- [ ] Consistent error handling across all commands

### Performance

- [ ] API response time < 200ms (p95)
- [ ] Price API calls reduced by 50% via caching
- [ ] Bot command response time < 3 seconds

### Security

- [ ] All private key exports logged
- [ ] Audit logs retention > 90 days
- [ ] Zero security vulnerabilities in dependencies

---

## Tracking & Review

- Create GitHub issues for each task
- Weekly code review sessions
- Monthly architecture review meetings
- Track progress in project board

---

## References

- Architecture Analysis: `docs/ARCHITECTURE.md`
- Database Schema: `packages/database/prisma/schema.prisma`
- Code Style: `AGENTS.md`
