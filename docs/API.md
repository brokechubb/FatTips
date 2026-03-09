# API Documentation

## Base URL

- Development: `http://localhost:3001`
- Production: `https://codestats.gg/api`

## Authentication

Each user API key is tied to a specific Discord user and can only access that user's wallet.

### Getting a User API Key

User API keys must be created by an admin using the `ADMIN_API_KEY` environment variable:

```bash
# Set in .env on the server
ADMIN_API_KEY=your-admin-master-key
```

Then create a user API key:

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

### Using a User API Key

Include in header:

```
X-API-Key: ft_abc123...
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

**Important:** The API key is only shown once. Store it securely.

### Using the API Key

Include in header:

```
X-API-Key: ft_abc123...
```

### Security

- Each API key is bound to one Discord user
- The key can only access its own wallet
- Attempting to access another user's wallet returns 403 Forbidden
- Keys can be listed and revoked at any time

---

### API Keys (Admin)

API keys are managed using the `ADMIN_API_KEY` environment variable on the server. This prevents unauthorized users from creating API keys for other users.

#### Create API Key

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
  "apiKey": "ft_abc123def456...",
  "discordId": "123456789",
  "name": "Jakey Bot",
  "createdAt": "2024-01-15T12:00:00.000Z"
}
```

**Note:** Store the API key securely - it is only shown once.

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

#### Create Wallet

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

#### Get Wallet Info

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

#### Delete Wallet

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

---

### Balance

#### Get User Balance

```http
GET /api/balance/:discordId
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

---

### Send & Tips

#### Send Tip (Single Recipient)

```http
POST /api/send/tip
Content-Type: application/json

{
  "fromDiscordId": "123456789",
  "toDiscordId": "987654321",
  "amount": 5.0,
  "token": "SOL",
  "amountType": "token" // or "usd"
}
```

Response:

```json
{
  "success": true,
  "signature": "5abc123...",
  "from": "123456789",
  "to": "987654321",
  "amountToken": 5.0,
  "amountUsd": 750.0,
  "token": "SOL",
  "solscanUrl": "https://solscan.io/tx/5abc123..."
}
```

#### Send Batch Tip (Multiple Recipients)

```http
POST /api/send/batch-tip
Content-Type: application/json

{
  "fromDiscordId": "123456789",
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
  "from": "123456789",
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

```http
POST /api/send/withdraw
Content-Type: application/json

{
  "discordId": "123456789",
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
  "from": "abc123...",
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
  "users": [
    "123456789",
    "987654321",
    "111222333"
  ]
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

## Leaderboard

### Get Top Tippers

```http
GET /api/leaderboard/top-tippers?limit=10
```

Response:

```json
[
  {
    "discordId": "123456789",
    "wallet": "abc123...",
    "totalTippedUsd": 5000.0
  }
]
```

### Get Top Receivers

```http
GET /api/leaderboard/top-receivers?limit=10
```

Response:

```json
[
  {
    "discordId": "123456789",
    "wallet": "abc123...",
    "totalReceivedUsd": 3500.0
  }
]
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

Returned when trying to access another user's wallet:

```json
{
  "error": "This API key can only access its own wallet",
  "yourDiscordId": "123456789"
}
```

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

- 100 requests per minute per IP
- 1000 requests per minute per authenticated user

---

## Jakey Integration Examples

### Jakey Tips a User

```javascript
// Jakey tipping user123
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

### Jakey Creates an Airdrop

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

### Jakey Checks User Balance

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

### Jakey Executes a Swap

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
