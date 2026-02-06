# API Documentation

## Base URL

- Development: `http://localhost:3001`
- Production: `https://codestats.gg/api`

## Authentication

### Discord OAuth

1. Redirect user to Discord OAuth
2. Receive authorization code
3. Exchange for access token
4. Include token in `Authorization: Bearer <token>` header

### API Key (for integrations)

Include in header:
```
X-API-Key: your_api_key_here
```

## Endpoints

### Users

#### Get User
```http
GET /api/users/:discordId
```

Response:
```json
{
  "discordId": "123456789",
  "walletPubkey": "abc123...",
  "createdAt": "2024-01-01T00:00:00Z",
  "lastActive": "2024-01-15T12:00:00Z"
}
```

#### Get User Balance
```http
GET /api/users/:discordId/balance
```

Response:
```json
{
  "sol": 1.5,
  "usdc": 100.00,
  "usdt": 50.00
}
```

#### Get User History
```http
GET /api/users/:discordId/history?page=1&limit=20
```

Response:
```json
{
  "transactions": [
    {
      "id": "uuid",
      "type": "TIP",
      "amount": 5.0,
      "token": "SOL",
      "from": "user1",
      "to": "user2",
      "timestamp": "2024-01-15T12:00:00Z"
    }
  ],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

### Transactions

#### List Transactions
```http
GET /api/transactions?type=TIP&limit=50
```

Query params:
- `type`: Filter by type (TIP, DEPOSIT, WITHDRAWAL, AIRDROP_CLAIM)
- `limit`: Number of results (default: 20, max: 100)
- `page`: Page number (default: 1)

#### Get Transaction
```http
GET /api/transactions/:id
```

### Airdrops

#### List Airdrops
```http
GET /api/airdrops?status=ACTIVE
```

Query params:
- `status`: ACTIVE, EXPIRED, SETTLED, RECLAIMED
- `limit`: Number of results
- `page`: Page number

#### Get Airdrop
```http
GET /api/airdrops/:id
```

Response:
```json
{
  "id": "uuid",
  "amount": 100.0,
  "token": "USDC",
  "maxParticipants": 20,
  "participantCount": 5,
  "status": "ACTIVE",
  "expiresAt": "2024-01-15T13:00:00Z",
  "createdAt": "2024-01-15T12:00:00Z"
}
```

#### Get Airdrop Participants
```http
GET /api/airdrops/:id/participants
```

### Admin (requires admin key)

#### Get Stats
```http
GET /api/admin/stats
```

Response:
```json
{
  "totalUsers": 1000,
  "totalTransactions": 5000,
  "totalVolume": {
    "sol": 100.5,
    "usdc": 5000.00,
    "usdt": 2500.00
  },
  "activeAirdrops": 5
}
```

#### Get Treasury
```http
GET /api/admin/treasury
```

## Error Responses

### 400 Bad Request
```json
{
  "error": "Bad Request",
  "message": "Invalid parameters"
}
```

### 401 Unauthorized
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication"
}
```

### 404 Not Found
```json
{
  "error": "Not Found",
  "message": "Resource not found"
}
```

### 429 Rate Limited
```json
{
  "error": "Rate Limited",
  "message": "Too many requests",
  "retryAfter": 60
}
```

## Rate Limits

- 100 requests per minute per IP
- 1000 requests per minute per authenticated user
- 10000 requests per minute per admin API key
