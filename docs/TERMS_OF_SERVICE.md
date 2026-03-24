# Terms of Service

**FatTips by CodeStats**
**Effective Date:** March 24, 2026
**Last Updated:** March 24, 2026

By using FatTips (the "Service"), you agree to these Terms. If you don't agree, don't use the Service.

---

## 1. What FatTips Is

FatTips is a Solana-based tipping and airdrop bot for Discord. It lets you send SOL, USDC, and USDT to other users, create airdrops, and manage a Solana wallet — all through Discord commands and a REST API.

The Service is operated by CodeStats ("we", "us", "our"), based in the United States, and accessible at https://codestats.gg.

## 2. Eligibility

- You must be at least 18 years old.
- You must comply with all applicable laws in your jurisdiction, including laws related to cryptocurrency.
- You are responsible for determining whether using this Service is legal where you live. We make no representations that the Service is appropriate or available in any particular jurisdiction.

## 3. Accounts and Wallets

- A Solana wallet is automatically created for you when you first interact with the bot.
- Your private key is encrypted (AES-256-GCM) and stored on our servers. You can export your private key at any time using the `/wallet export-key` command.
- **You are solely responsible for safeguarding your private key once exported.** We cannot recover lost or stolen keys.
- We do not have access to your unencrypted private key. The master encryption key is managed as critical infrastructure.

## 4. Supported Tokens

The Service supports SOL, USDC, and USDT only. We do not support arbitrary tokens and are not responsible for any tokens sent to your wallet outside of the Service.

## 5. Tips, Sends, and Airdrops

- Tips and sends are on-chain Solana transactions. Once confirmed, they are **irreversible**.
- Airdrops use pooled escrow wallets. Funds are held until the airdrop expires or reaches max participants, at which point settlement occurs automatically.
- Unclaimed airdrop funds are returned to the creator after expiry.
- All financial values use precise decimal arithmetic. USD amounts are converted to token amounts at the time of the transaction using real-time pricing from Jupiter.

## 6. Fees

- FatTips does not charge service fees for tips or airdrops.
- Standard Solana network fees (transaction fees, rent exemption, priority fees) apply to all on-chain transactions and are deducted from your wallet balance.
- You are responsible for maintaining sufficient SOL in your wallet to cover network fees.

## 7. No Financial Advice

Nothing in this Service constitutes financial, investment, tax, or legal advice. Cryptocurrency is volatile. You could lose everything you put in. We are not a bank, broker, exchange, or financial institution.

## 8. Prohibited Uses

You agree not to:

- Use the Service for money laundering, terrorism financing, or any illegal activity.
- Attempt to exploit, reverse-engineer, or attack the Service or its infrastructure.
- Abuse the airdrop system (e.g., creating fraudulent airdrops, using bots to claim).
- Harass other users through tips, messages, or airdrops.
- Circumvent any security measures or rate limits.

We reserve the right to suspend or terminate your access for any violation.

## 9. API Access

- API access is authenticated via per-user API keys.
- API keys are tied to your Discord identity and can only operate on your own wallet.
- You are responsible for keeping your API key secret. Compromised keys should be revoked immediately.
- We may rate-limit or revoke API access at any time.

## 10. Privacy

Your use of the Service is also governed by our [Privacy Policy](./PRIVACY_POLICY.md), which describes what data we collect, how we store it, and your rights regarding that data.

## 11. Disclaimers

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DO NOT GUARANTEE:

- Uninterrupted or error-free operation.
- That transactions will confirm on the Solana network.
- The accuracy of price data from third-party oracles (Jupiter).
- The security of the Solana blockchain itself.

## 12. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, CODESTATS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF FUNDS, LOSS OF PROFITS, OR LOSS OF DATA, ARISING FROM YOUR USE OF THE SERVICE.

OUR TOTAL LIABILITY FOR ANY CLAIM ARISING FROM THE SERVICE SHALL NOT EXCEED THE AMOUNT OF NETWORK FEES YOU HAVE PAID THROUGH THE SERVICE IN THE 12 MONTHS PRECEDING THE CLAIM, OR $100 USD, WHICHEVER IS GREATER.

## 13. Indemnification

You agree to indemnify and hold harmless CodeStats, its contributors, and operators from any claims, damages, or expenses arising from your use of the Service or violation of these Terms.

## 14. Modifications

We may update these Terms at any time. Continued use of the Service after changes constitutes acceptance. Material changes will be announced via Discord.

## 15. Termination

We may suspend or terminate your access at any time, for any reason. You may stop using the Service at any time. **Upon termination, you retain the ability to export your private key and withdraw your funds directly on-chain.**

## 16. Governing Law

These Terms are governed by the laws of the United States. Any disputes shall be resolved in the courts of the United States.

## 17. Open Source

The FatTips software is released under the MIT License. These Terms govern your use of the **hosted Service**, not the underlying source code.

## 18. Contact

For questions about these Terms:

- **Email:** info@codestats.gg
- **Website:** https://codestats.gg
