# API

REST API for FatTips integrations.

## Endpoints

### Authentication

All endpoints require authentication via Bearer token or Discord OAuth.

### Users

- `GET /api/users/:discordId` - Get user info
- `GET /api/users/:discordId/balance` - Get user balances
- `GET /api/users/:discordId/history` - Get transaction history

### Transactions

- `GET /api/transactions` - List transactions
- `GET /api/transactions/:id` - Get transaction details

### Airdrops

- `GET /api/airdrops` - List airdrops
- `GET /api/airdrops/:id` - Get airdrop details
- `GET /api/airdrops/:id/participants` - List participants

### Admin

- `GET /api/admin/stats` - Bot statistics
- `GET /api/admin/treasury` - Bot treasury balance

## Development

```bash
# From repo root
pnpm --filter api dev

# Or
cd apps/api
pnpm dev
```

## Rate Limiting

- 100 requests per minute per IP
- 1000 requests per minute per authenticated user
