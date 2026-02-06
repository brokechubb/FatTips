# FatTips

A Solana-based Discord tipping bot with airdrop functionality supporting SOL, USDC, and USDT.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Instant Tipping**: Tip users with automatic USD-to-crypto conversion
- **Airdrops**: Create time-limited airdrops with button-based claims
- **Multi-Token Support**: SOL, USDC, USDT
- **Wallet Recovery**: Users receive seed phrases for full custody
- **Web Dashboard**: View leaderboards, stats, and transaction history

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- PostgreSQL 14+
- Docker (optional, for local database)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/fattips.git
cd fattips

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Start development server
pnpm dev
```

## Documentation

- [Development Roadmap](./ROADMAP.md) - Complete project plan and phases
- [API Documentation](./docs/API.md) - REST API reference
- [Contributing Guidelines](./docs/CONTRIBUTING.md) - How to contribute
- [Deployment Guide](./docs/DEPLOYMENT.md) - Production deployment

## Architecture

FatTips is a monorepo containing:

- **Bot** (`apps/bot/`) - Discord bot for user interactions
- **API** (`apps/api/`) - REST API for integrations
- **Web** (`apps/web/`) - Next.js dashboard
- **Smart Contract** (`programs/airdrop/`) - Solana escrow program

## Development

See the [Roadmap](./ROADMAP.md) for detailed development phases and tasks.

## License

MIT License - see [LICENSE](./LICENSE) file

## Support

- Open an [issue](https://github.com/yourusername/fattips/issues) for bugs
- Join our [Discord](https://discord.gg/yourserver) for discussion

## Acknowledgments

- [Discord.js](https://discord.js.org/) - Discord API library
- [Anchor Framework](https://www.anchor-lang.com/) - Solana smart contract framework
- [Jupiter](https://jup.ag/) - Price oracle and DEX
- [Helius](https://www.helius.xyz/) - Solana RPC provider
