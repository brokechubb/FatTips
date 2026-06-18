# API Documentation

## Base URL

- Development: `http://localhost:3001`
- Production: `https://codestats.gg/api`

## Authentication

There are two types of API keys:

| Type | Owned By | How to Send | Use Case |
|------|----------|-------------|----------|
| **User-bound** | A Discord user | Must include `fromDiscordId` matching the user | External bot acting on behalf of a user |
| **App wallet** | The API key itself (standalone wallet) | Omit `fromDiscordId`, app wallet is used automatically | Bot tipping users from its own funds |

### Getting a User-Bound API Key

User API keys must be created by an admin using the `ADMIN_API_KEY` environment variable:

```bash
# Set in .env on the server
ADMIN_API_KEY=your-admin-master-key
```

Then create a user API key. The Discord user must already have a wallet:

```http
POST /api/keys/create
X-Admin-API-Key: your-admin-master-key
Content-Type: application/json

{
  "discordId": "123456789",
  "name": "Jakey Bot"
}
```

Response:

```json
{
  "success": true,
  "apiKey": "ft_abc123...",
  "discordId": "123456789",
  "name": "Jakey Bot",
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

**Important:** Store user API keys securely - they are only shown once.

### Getting an App Wallet API Key

App wallet keys are not tied to any Discord user. They own their own Solana wallet, funded externally (e.g., from a centralized exchange). Create one with `type: "app"`:

```http
POST /api/keys/create
X-Admin-API-Key: your-admin-master-key
Content-Type: application/json

{
  "type": "app",
  "name": "Stake Code Tips"
}
```

Response:

```json
{
  "success": true,
  "type": "app",
  "apiKey": "ft_def456...",
  "name": "Stake Code Tips",
  "createdAt": "2024-01-15T12:00:00.000Z",
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "privateKey": "4Z7v...",
  "mnemonic": "apple banana cherry date..."
}
```

**Important:** The private key and mnemonic are only shown once. Store them securely. Fund the wallet by sending SOL to `walletPubkey` from an exchange or another wallet.

### Using the API Key

Include in header:

```
X-API-Key: ft_abc123...
```

### Security

- **User-bound keys:** Each key is bound to one Discord user. The key can only access that user's wallet. Attempting to access another user's wallet returns 403 Forbidden.
- **App wallet keys:** The key owns its own standalone wallet. No Discord user is involved. All tips/withdrawals use the app wallet directly.
- Keys can be listed and revoked at any time.

---

### API Keys (Admin)

API keys are managed using the `ADMIN_API_KEY` environment variable on the server. This prevents unauthorized users from creating API keys for other users.

#### Create API Key

**User-bound key** (requires existing Discord user with wallet):

```http
POST /api/keys/create
X-Admin-API-Key: your-admin-master-key
Content-Type: application/json

{
  "discordId": "123456789",
  "name": "Jakey Bot"
}
```

**App wallet key** (creates a new standalone wallet):

```http
POST /api/keys/create
X-Admin-API-Key: your-admin-master-key
Content-Type: application/json

{
  "type": "app",
  "name": "Stake Code Tips"
}
```

Response (user-bound):

```json
{
  "success": true,
  "apiKey": "ft_abc123def456...",
  "discordId": "123456789",
  "name": "Jakey Bot",
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

Response (app wallet):

```json
{
  "success": true,
  "type": "app",
  "apiKey": "ft_def456...",
  "name": "Stake Code Tips",
  "createdAt": "2024-01-15T12:00:00.000Z",
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "privateKey": "4Z7v...",
  "mnemonic": "apple banana cherry date..."
}
```

**Note:** Store the API key and wallet credentials securely - they are only shown once.

#### Add App Wallet to Existing Key

If an API key already exists without a wallet, an admin can attach one:

```http
POST /api/wallet/app/create
X-Admin-API-Key: your-admin-master-key
Content-Type: application/json

{
  "apiKey": "ft_abc123..."
}
```

Response:

```json
{
  "success": true,
  "apiKey": "ft_abc123...",
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "privateKey": "4Z7v...",
  "mnemonic": "apple banana cherry date..."
}
```

#### List API Keys

```http
GET /api/keys?discordId=123456789
X-Admin-API-Key: your-admin-master-key
```

Response:

```json
{
  "keys": [
    {
      "id": "uuid",
      "key": "ft_abc123...",
      "name": "Jakey Bot",
      "lastUsedAt": "2024-01-15T12:00:00.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "isExpired": false
    }
  ]
}
```

#### Revoke API Key

```http
DELETE /api/keys/:key
X-Admin-API-Key: your-admin-master-key
```

Response:

```json
{
  "success": true,
  "message": "API key revoked"
}
```

---

## Endpoints

### Health Check

#### Get Health Status

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

---

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
  "username": "username#1234",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "lastActive": "2024-01-15T12:00:00.000Z",
  "_count": {
    "sentTips": 10,
    "receivedTips": 5,
    "airdropsCreated": 2,
    "participations": 8
  }
}
```

**Note:** Sensitive fields (encryptedPrivkey, encryptedMnemonic, keySalt, mnemonicSalt) are excluded from the response.

---

### Wallet

#### Create User Wallet

```http
POST /api/wallet/create
Content-Type: application/json

{
  "discordId": "123456789"
}
```

Response:

```json
{
  "success": true,
  "discordId": "123456789",
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "privateKey": "4Z7v...,"
  "mnemonic": "apple banana cherry date..."
}
```

**⚠️ Security Note:** The private key and mnemonic are returned once. Store securely. Never expose in logs or client-side code.

#### Get User Wallet Info

```http
GET /api/wallet/:discordId
```

Response:

```json
{
  "discordId": "123456789",
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "hasMnemonic": true,
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

#### Delete User Wallet

```http
DELETE /api/wallet/:discordId
```

Response:

```json
{
  "success": true,
  "message": "Wallet deleted",
  "discordId": "123456789"
}
```

#### Get App Wallet Info

Returns the app wallet attached to the authenticated API key.

```http
GET /api/wallet/app
X-API-Key: ft_...
```

Response:

```json
{
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm"
}
```

---

### Balance

#### Get User Balance

```http
GET /api/balance/:discordId
X-API-Key: ft_...
```

Response:

```json
{
  "discordId": "123456789",
  "walletPubkey": "abc123...",
  "balances": {
    "sol": 1.5,
    "usdc": 100.0,
    "usdt": 50.0
  }
}
```

#### Get App Wallet Balance

Returns the balance of the app wallet attached to the authenticated API key.

```http
GET /api/balance/app
X-API-Key: ft_...
```

Response:

```json
{
  "walletPubkey": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "balances": {
    "sol": 2.5,
    "usdc": 500.0,
    "usdt": 200.0
  }
}
```

---

### Send & Tips

> **Note on `fromDiscordId`:** This field is **required** for user-bound API keys but **optional** for app wallet keys. When omitted with an app wallet key, the app wallet is used as the sender automatically.

#### Send Tip (Single Recipient)

**User-bound key** (must include `fromDiscordId`):

```http
POST /api/send/tip
X-API-Key: ft_...
Content-Type: application/json

{
  "fromDiscordId": "123456789",
  "toDiscordId": "987654321",
  "amount": 5.0,
  "token": "SOL",
  "amountType": "token" // or "usd"
}
```

**App wallet key** (`fromDiscordId` omitted — app wallet used automatically):

```http
POST /api/send/tip
X-API-Key: ft_...
Content-Type: application/json

{
  "toDiscordId": "987654321",
  "amount": 0.25,
  "token": "SOL",
  "amountType": "usd"
}
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "from": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "to": "987654321",
  "amountToken": 0.00167,
  "amountUsd": 0.25,
  "token": "SOL",
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

#### Send Batch Tip (Multiple Recipients)

```http
POST /api/send/batch-tip
X-API-Key: ft_...
Content-Type: application/json

{
  "recipients": [
    { "discordId": "987654321" },
    { "discordId": "111222333" },
    { "discordId": "444555666" }
  ],
  "totalAmount": 15.0,
  "token": "SOL",
  "amountType": "token"
}
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "from": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "recipients": [
    { "to": "987654321", "signature": "5abc123...:0", "amountToken": 5, "amountUsd": 750 },
    { "to": "111222333", "signature": "5abc123...:1", "amountToken": 5, "amountUsd": 750 },
    { "to": "444555666", "signature": "5abc123...:2", "amountToken": 5, "amountUsd": 750 }
  ],
  "totalAmountToken": 15,
  "totalAmountUsd": 2250,
  "token": "SOL",
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

#### Withdraw Funds

**User-bound key:**

```http
POST /api/send/withdraw
X-API-Key: ft_...
Content-Type: application/json

{
  "discordId": "123456789",
  "destinationAddress": "ExternalWalletAddress...",
  "amount": 1.0,
  "token": "SOL"
}
```

**App wallet key** (`discordId` omitted — withdraws from app wallet):

```http
POST /api/send/withdraw
X-API-Key: ft_...
Content-Type: application/json

{
  "destinationAddress": "ExternalWalletAddress...",
  "amount": 1.0,
  "token": "SOL"
}

// Use amount: null or omit for max withdrawal
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "from": "7nYhPEv6s6DkXwJv7QxQwJ6Qz9H2LZv6rK5hLM8Jz3Tm",
  "to": "ExternalWalletAddress...",
  "amountToken": 1.0,
  "amountUsd": 150.0,
  "token": "SOL",
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

---

### Transactions

#### Get Transaction by ID or Signature

```http
GET /api/transactions/:id
```

Query params:

- `:id`: Transaction UUID or Solana signature

Response:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "5abc123...",
  "txType": "TIP",
  "status": "CONFIRMED",
  "amount": 5.0,
  "amountUsd": 750.0,
  "token": "SOL",
  "fromId": "123456789",
  "toId": "987654321",
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

#### Get User Transactions

```http
GET /api/transactions/user/:discordId
```

Query params:

- `limit`: Number of results (default: 10, max: 50)
- `offset`: Pagination offset (default: 0)

Response:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "signature": "5abc123...",
    "txType": "TIP",
    "status": "CONFIRMED",
    "amount": 5.0,
    "amountUsd": 750.0,
    "token": "SOL",
    "fromId": "123456789",
    "toId": "987654321",
    "createdAt": "2024-01-15T12:00:00.000Z"
  }
]
```

---

### Airdrops

#### Create Airdrop

```http
POST /api/airdrops/create
Content-Type: application/json

{
  "creatorDiscordId": "123456789",
  "amount": 10.0,
  "token": "SOL",
  "duration": "10m",
  "maxWinners": 5,
  "amountType": "token", // or "usd"
  "channelId": "123456789012345678" // Discord channel ID (optional)
}
```

**Discord Integration:**

When `channelId` is provided, the FatTips bot automatically posts an airdrop embed to that Discord channel with a Claim button. The bot must be in the server and have permission to send messages in the channel.

**How it works:**

1. API creates the airdrop record in the database
2. API publishes an `AIRDROP_CREATED` event via Redis pub/sub
3. FatTips bot receives the event and posts the embed to the specified channel
4. Users click "Claim" → their Discord ID is recorded
5. When airdrop ends, tokens are distributed proportionally

**Requirements for Discord posting:**

- FatTips bot must be a member of the server
- Bot needs `Send Messages` and `Embed Links` permissions in the channel
- `channelId` must be a valid text channel ID (enable Developer Mode in Discord to copy IDs)

Response:

```json
{
  "success": true,
  "airdropId": "uuid-uuid-uuid",
  "potSize": 10.0,
  "token": "SOL",
  "totalUsd": 1500.0,
  "expiresAt": "2024-01-15T12:10:00.000Z",
  "maxWinners": 5,
  "ephemeralWallet": "ephemeral123..."
}
```

#### Get Airdrop Details

```http
GET /api/airdrops/:id
```

Response:

```json
{
  "id": "uuid-uuid-uuid",
  "creatorId": "123456789",
  "potSize": 10.0,
  "tokenMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "participantCount": 3,
  "maxParticipants": 5,
  "status": "ACTIVE",
  "expiresAt": "2024-01-15T12:10:00.000Z",
  "createdAt": "2024-01-15T12:00:00.000Z",
  "participants": [{ "discordId": "987654321", "status": "TRANSFERRED", "shareAmount": 3.33 }]
}
```

#### Claim Airdrop

```http
POST /api/airdrops/:id/claim
Content-Type: application/json

{
  "discordId": "987654321"
}
```

Response:

```json
{
  "success": true,
  "airdropId": "uuid-uuid-uuid",
  "claimant": "987654321",
  "amountReceived": 3.33,
  "tokenMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "signature": "5abc123...",
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

#### List Airdrops

```http
GET /api/airdrops?status=ACTIVE&limit=10&offset=0
```

Query params:

- `status`: ACTIVE, EXPIRED, SETTLED, RECLAIMED
- `limit`: Number of results (default: 10)
- `offset`: Pagination offset (default: 0)

Response:

```json
{
  "airdrops": [
    {
      "id": "uuid-uuid-uuid",
      "creatorId": "123456789",
      "potSize": 10.0,
      "tokenMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "participantCount": 3,
      "maxParticipants": 5,
      "status": "ACTIVE",
      "expiresAt": "2024-01-15T12:10:00.000Z"
    }
  ],
  "total": 1
}
```

---

### Rain

#### Create Rain

```http
POST /api/rain/create
Content-Type: application/json

{
  "creatorDiscordId": "123456789",
  "amount": 5.0,
  "token": "SOL",
  "winners": ["987654321", "111222333", "444555666"],
  "amountType": "token"
}
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "creator": "123456789",
  "winners": [
    {
      "discordId": "987654321",
      "signature": "5abc123...:0",
      "amountToken": 1.66,
      "amountUsd": 249
    },
    {
      "discordId": "111222333",
      "signature": "5abc123...:1",
      "amountToken": 1.66,
      "amountUsd": 249
    },
    { "discordId": "444555666", "signature": "5abc123...:2", "amountToken": 1.66, "amountUsd": 249 }
  ],
  "totalAmountToken": 5.0,
  "totalAmountUsd": 750,
  "token": "SOL",
  "amountPerUser": 1.66,
  "winnersCount": 3,
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

**Jakey Trivia Example:**

```javascript
// Jakey rains on trivia winners
const response = await fetch('https://codestats.gg/api/rain/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    creatorDiscordId: process.env.JAKEY_DISCORD_ID,
    amount: 10,
    token: 'SOL',
    winners: ['winner1', 'winner2', 'winner3'],
    amountType: 'token',
  }),
});

const result = await response.json();
console.log(`Rained ${result.amountPerUser} SOL on ${result.winnersCount} winners!`);
```

---

### Token Swaps

#### Get Swap Quote

```http
GET /api/swap/quote?inputToken=SOL&outputToken=USDC&amount=1.0&amountType=token
```

Response:

```json
{
  "inputToken": "SOL",
  "outputToken": "USDC",
  "inputAmount": 1.0,
  "outputAmount": 95.50,
  "priceImpact": 0.05,
  "routePlan": [...],
  "inputUsd": 150.00,
  "outputUsd": 95.50
}
```

#### Execute Swap

```http
POST /api/swap/execute
Content-Type: application/json

{
  "discordId": "123456789",
  "inputToken": "SOL",
  "outputToken": "USDC",
  "amount": 1.0,
  "amountType": "token",
  "slippage": 1.0 // optional, default 1%
}
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "inputToken": "SOL",
  "outputToken": "USDC",
  "inputAmount": 1.0,
  "outputAmount": 95.42,
  "inputUsd": 150.0,
  "outputUsd": 95.42,
  "priceImpact": 0.08,
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

#### Get Supported Tokens

```http
GET /api/swap/supported-tokens
```

Response:

```json
{
  "tokens": [
    { "symbol": "SOL", "mint": "So11111111111111111111111111111111111111112", "decimals": 9 },
    { "symbol": "USDC", "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "decimals": 6 },
    { "symbol": "USDT", "mint": "Es9vMFrzaCERmBfrE5j5K3x4DCD9Xyj1eN3y1X5j1vT8", "decimals": 6 }
  ]
}
```

---

## Activity (Channel)

### Get Active Users

Get list of users who were active in a Discord channel within the specified time window. Use this to select random winners for rain functionality.

```http
GET /api/activity/active-users?channelId=123456789012345678&minutes=15
```

**Query Parameters:**

- `channelId` (required): Discord channel ID (17-19 digit snowflake)
- `minutes` (optional): Time window in minutes (default: 15, max: 60)

**Response:**

```json
{
  "channelId": "123456789012345678",
  "minutes": 15,
  "count": 10,
  "users": ["123456789", "987654321", "111222333"]
}
```

**Example (Jakey selecting rain winners):**

```javascript
// Get active users in a channel
const response = await fetch(
  'https://codestats.gg/api/activity/active-users?channelId=123456789012345678&minutes=15',
  {
    headers: { 'X-API-Key': process.env.FATTIPS_API_KEY },
  }
);

const { users } = await response.json();

// Randomly select winners
const shuffled = users.sort(() => 0.5 - Math.random());
const winners = shuffled.slice(0, 5);

// Create rain with selected winners
const rainResponse = await fetch('https://codestats.gg/api/rain/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    creatorDiscordId: process.env.JAKEY_DISCORD_ID,
    amount: 10,
    token: 'SOL',
    winners,
    amountType: 'token',
  }),
});
```

### Get Active User Count

Get count of active users in a Discord channel.

```http
GET /api/activity/count?channelId=123456789012345678&minutes=15
```

**Response:**

```json
{
  "channelId": "123456789012345678",
  "minutes": 15,
  "count": 10
}
```

---

## Leaderboard & Reports

All endpoints require `X-API-Key` header. Date parameters use ISO 8601 format (e.g. `2026-03-01`).

### Get Top Airdrop Creators

```http
GET /api/leaderboard/top-airdrop-creators?limit=10&guildId=123&status=SETTLED&fromDate=2026-03-01&toDate=2026-04-01
```

| Parameter  | Type   | Default | Description                 |
| ---------- | ------ | ------- | --------------------------- |
| `limit`    | int    | 10      | Max results (max 50)        |
| `guildId`  | string | -       | Filter to a specific server |
| `status`   | string | SETTLED | Airdrop status filter       |
| `fromDate` | string | -       | Created after this date     |
| `toDate`   | string | -       | Created before this date    |

Response:

```json
[
  {
    "rank": 1,
    "discordId": "123456789",
    "wallet": "abc123...",
    "airdropCount": 5,
    "totalAllocated": "50.000000000",
    "totalDistributed": "45.000000000"
  }
]
```

### Get Top Rain/Tips Senders

```http
GET /api/leaderboard/top-rain-senders?limit=10&guildId=123&fromDate=2026-03-01
```

| Parameter  | Type   | Default | Description                 |
| ---------- | ------ | ------- | --------------------------- |
| `limit`    | int    | 10      | Max results (max 50)        |
| `guildId`  | string | -       | Filter to a specific server |
| `fromDate` | string | -       | Created after this date     |
| `toDate`   | string | -       | Created before this date    |

Response:

```json
[
  {
    "rank": 1,
    "discordId": "123456789",
    "wallet": "abc123...",
    "tipCount": 42,
    "totalUsd": "1500.00"
  }
]
```

### Get Guild Stats

```http
GET /api/leaderboard/guild-stats?guildId=123456789&fromDate=2026-03-01
```

| Parameter  | Type   | Required | Description              |
| ---------- | ------ | -------- | ------------------------ |
| `guildId`  | string | Yes      | Discord guild ID         |
| `fromDate` | string | No       | Created after this date  |
| `toDate`   | string | No       | Created before this date |

Response:

```json
{
  "guildId": "123456789",
  "tips": {
    "count": 500,
    "totalVolumeUsd": "15000.00",
    "uniqueSenders": 80,
    "uniqueReceivers": 120
  },
  "airdrops": {
    "count": 30,
    "totalDistributed": "500.000000000"
  }
}
```

### Get User Stats

```http
GET /api/leaderboard/user-stats?discordId=123456789&guildId=987654321&fromDate=2026-03-01
```

| Parameter   | Type   | Required | Description                 |
| ----------- | ------ | -------- | --------------------------- |
| `discordId` | string | Yes      | Discord user ID             |
| `guildId`   | string | No       | Filter to a specific server |
| `fromDate`  | string | No       | Created after this date     |
| `toDate`    | string | No       | Created before this date    |

Response:

```json
{
  "discordId": "123456789",
  "tipsSent": { "count": 25, "totalUsd": "500.00" },
  "tipsReceived": { "count": 10, "totalUsd": "200.00" },
  "airdropsCreated": { "count": 3, "totalDistributed": "150.000000000" },
  "airdropsWon": 7
}
```

### Transaction Report

Fully filterable transaction list with pagination.

```http
GET /api/leaderboard/transactions?guildId=123&txType=TIP&status=CONFIRMED&minAmountUsd=10&fromDate=2026-03-13&limit=50&offset=0&sortBy=createdAt&sortOrder=desc
```

| Parameter      | Type   | Default   | Description                                     |
| -------------- | ------ | --------- | ----------------------------------------------- |
| `limit`        | int    | 50        | Max results (max 200)                           |
| `offset`       | int    | 0         | Pagination offset                               |
| `guildId`      | string | -         | Filter to a specific server                     |
| `fromId`       | string | -         | Sender Discord ID                               |
| `toId`         | string | -         | Receiver Discord ID                             |
| `txType`       | string | -         | `TIP`, `DEPOSIT`, `WITHDRAWAL`, `AIRDROP_CLAIM` |
| `status`       | string | -         | `PENDING`, `CONFIRMED`, `FAILED`                |
| `tokenMint`    | string | -         | Token mint address                              |
| `minAmountUsd` | float  | -         | Minimum USD amount                              |
| `maxAmountUsd` | float  | -         | Maximum USD amount                              |
| `fromDate`     | string | -         | Created after this date                         |
| `toDate`       | string | -         | Created before this date                        |
| `sortBy`       | string | createdAt | `createdAt`, `amountUsd`, `amountToken`         |
| `sortOrder`    | string | desc      | `asc` or `desc`                                 |

Response:

```json
{
  "total": 1500,
  "offset": 0,
  "limit": 50,
  "data": [
    {
      "id": "uuid",
      "signature": "5Kj8...",
      "fromId": "123456789",
      "toId": "987654321",
      "fromAddress": null,
      "toAddress": null,
      "amountUsd": "15.00",
      "amountToken": "0.100000000",
      "tokenMint": "So11111111111111111111111111111111111111112",
      "txType": "TIP",
      "status": "CONFIRMED",
      "guildId": "123456789",
      "createdAt": "2026-03-15T12:00:00.000Z"
    }
  ]
}
```

### Airdrop Report

Fully filterable airdrop list with pagination.

```http
GET /api/leaderboard/airdrops?guildId=123&creatorId=456&status=SETTLED&minAmountTotal=10&fromDate=2026-03-13&limit=50&offset=0
```

| Parameter        | Type   | Default   | Description                                                     |
| ---------------- | ------ | --------- | --------------------------------------------------------------- |
| `limit`          | int    | 50        | Max results (max 200)                                           |
| `offset`         | int    | 0         | Pagination offset                                               |
| `guildId`        | string | -         | Filter to a specific server                                     |
| `creatorId`      | string | -         | Creator Discord ID                                              |
| `status`         | string | -         | `ACTIVE`, `SETTLING`, `SETTLED`, `FAILED`, `RECLAIMED`          |
| `tokenMint`      | string | -         | Token mint address                                              |
| `minAmountTotal` | float  | -         | Minimum total amount                                            |
| `maxAmountTotal` | float  | -         | Maximum total amount                                            |
| `fromDate`       | string | -         | Created after this date                                         |
| `toDate`         | string | -         | Created before this date                                        |
| `sortBy`         | string | createdAt | `createdAt`, `amountTotal`, `amountClaimed`, `participantCount` |
| `sortOrder`      | string | desc      | `asc` or `desc`                                                 |

Response:

```json
{
  "total": 200,
  "offset": 0,
  "limit": 50,
  "data": [
    {
      "id": "uuid",
      "creatorId": "123456789",
      "amountTotal": "10.000000000",
      "amountClaimed": "9.500000000",
      "tokenMint": "So11111111111111111111111111111111111111112",
      "maxParticipants": 10,
      "participantCount": 8,
      "status": "SETTLED",
      "guildId": "987654321",
      "channelId": "111222333",
      "createdAt": "2026-03-15T12:00:00.000Z",
      "expiresAt": "2026-03-15T13:00:00.000Z",
      "settledAt": "2026-03-15T13:00:05.000Z"
    }
  ]
}
```

---

## Discord Integration

### How API-Created Airdrops Work with Discord

When Jakey creates an airdrop via the API with a `channelId`, the FatTips bot automatically posts an embed to that Discord channel:

```
┌─────────────────────────────────────────────────────────────┐
│  🎉 Crypto Airdrop!                                          │
│                                                             │
│  A pot of 10.00 SOL (~$$1,500) has been dropped!           │
│                                                             │
│  Click **Claim** to enter.                                   │
│  ⏳ Ends: in 1 hour                                         │
│                                                             │
│  Pot Size: 10.00 SOL  │  Max Winners: Unlimited            │
└─────────────────────────────────────────────────────────────┘
                    [💰 Claim]
```

**Flow:**

1. Jakey calls `POST /api/airdrops/create` with `channelId`
2. API creates airdrop record → publishes Redis event
3. FatTips bot receives event → posts embed with Claim button
4. Users click Claim → their Discord ID is recorded
5. At expiry, tokens are distributed to all claimants

**Requirements:**

- FatTips bot must be in the server
- Bot needs `Send Messages` and `Embed Links` permissions
- `channelId` must be a valid Discord text channel ID

---

## Error Responses

### 400 Bad Request

```json
{
  "error": "Error message describing the issue"
}
```

### 401 Unauthorized

```json
{
  "error": "Invalid API key"
}
```

### 403 Forbidden

Returned when trying to access another user's wallet, or when a user-bound key specifies a `fromDiscordId` it doesn't own:

```json
{
  "error": "This API key can only access its own wallet",
  "yourDiscordId": "123456789"
}
```

App wallet keys never get this error — they can tip any Discord user.

### 400 Bad Request (App Wallet)

```json
{
  "error": "Either fromDiscordId or an app wallet is required"
}
```

Returned when a key has neither a Discord user nor an app wallet and no `fromDiscordId` is specified.

### 404 Not Found

```json
{
  "error": "Resource not found"
}
```

### 500 Internal Server Error

```json
{
  "error": "Internal Server Error"
}
```

---

## Rate Limits

- **Global:** 60 requests per minute per API key
- **Financial endpoints** (`/send`, `/airdrops`, `/swap`, `/rain`): 10 requests per minute per API key

---

## Integration Examples

### App Wallet: Bot Tips Users from Its Own Funds

The most common pattern for bots — the bot has its own funded wallet and tips users directly. No `fromDiscordId` needed:

```javascript
// Bot tips a user $0.25 USD in SOL from its app wallet
const response = await fetch('https://codestats.gg/api/send/tip', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    toDiscordId: 'user123',
    amount: 0.25,
    token: 'SOL',
    amountType: 'usd',
  }),
});

const result = await response.json();
if (result.success) {
  console.log(`Tipped! TX: ${result.solscanUrl}`);
}
```

### App Wallet: Check Bot's Balance

```javascript
const response = await fetch('https://codestats.gg/api/balance/app', {
  headers: { 'X-API-Key': process.env.FATTIPS_API_KEY },
});

const data = await response.json();
console.log(`Bot balance: ${data.balances.sol} SOL`);
```

### User-Bound: Tips on Behalf of a User

```javascript
// Jakey tipping user123 from Jakey's own wallet
const response = await fetch('https://codestats.gg/api/send/tip', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    fromDiscordId: process.env.JAKEY_DISCORD_ID,
    toDiscordId: 'user123',
    amount: 5,
    token: 'SOL',
    amountType: 'token',
  }),
});

const result = await response.json();
if (result.success) {
  console.log('Tipped! Transaction: ' + result.solscanUrl);
}
```

### User-Bound: Creates an Airdrop

```javascript
// Jakey creating a community airdrop
const response = await fetch('https://codestats.gg/api/airdrops/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    creatorDiscordId: process.env.JAKEY_DISCORD_ID,
    amount: 100,
    token: 'USDC',
    duration: '1h',
    maxWinners: 10,
    amountType: 'usd',
  }),
});

const result = await response.json();
console.log('Airdrop created! ID: ' + result.airdropId);
```

### User-Bound: Checks User Balance

```javascript
// Jakey checking if user can afford something
const response = await fetch('https://codestats.gg/api/balance/user123', {
  headers: {
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
});

const data = await response.json();
if (data.balances.sol >= 1) {
  // User has at least 1 SOL
}
```

### User-Bound: Executes a Swap

```javascript
// Jakey swapping SOL for USDC for a user
const quote = await fetch(
  'https://codestats.gg/api/swap/quote?inputToken=SOL&outputToken=USDC&amount=2&amountType=token',
  {
    headers: { 'X-API-Key': process.env.FATTIPS_API_KEY },
  }
);

const swap = await fetch('https://codestats.gg/api/swap/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.FATTIPS_API_KEY,
  },
  body: JSON.stringify({
    discordId: 'user123',
    inputToken: 'SOL',
    outputToken: 'USDC',
    amount: 2,
    amountType: 'token',
  }),
});
```
