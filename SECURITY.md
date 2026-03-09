# Security Policy

**Last Updated:** 2026-03-09

FatTips takes security seriously. This document outlines our security practices and how to report vulnerabilities.

---

## 🔒 Security Architecture

### Encryption

- **Algorithm:** AES-256-GCM
- **Key Management:** Master encryption key stored in environment variables only
- **User Wallets:** Each wallet encrypted with unique salt

### Authentication

- **Discord Bot:** Token-based authentication
- **API:** Per-user API keys with ownership validation
- **Database:** Limited-privilege database user

### Infrastructure

- **Docker:** Container isolation with resource limits
- **Network:** Internal Docker network, API bound to localhost
- **Firewall:** nftables with fail2ban integration

---

## 🛡️ Supported Versions

We provide security updates for the latest version only.

| Version | Supported        |
| ------- | ---------------- |
| 0.2.x   | ✅ Supported     |
| < 0.2   | ❌ Not supported |

---

## 🚨 Reporting a Vulnerability

**Please do NOT create a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email:** security@codestats.gg
2. **Discord:** @brokechubb
3. **GitHub Security Advisories:** Use the "Report a vulnerability" button

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information

### Response Timeline

- **Initial Response:** Within 48 hours
- **Status Update:** Within 1 week
- **Resolution:** Depends on severity (see below)

### Severity Levels

| Severity | Response Time | Resolution Time |
| -------- | ------------- | --------------- |
| Critical | 24 hours      | 1 week          |
| High     | 48 hours      | 2 weeks         |
| Medium   | 1 week        | 1 month         |
| Low      | 2 weeks       | 3 months        |

---

## 🔐 Security Best Practices

### For Users

1. **Never share your private key** - FatTips will never ask for it
2. **Use secure passwords** - For your Discord account
3. **Enable 2FA** - On your Discord account
4. **Verify bot permissions** - Only grant necessary permissions
5. **Report suspicious activity** - Contact us immediately

### For Developers

1. **Never commit `.env` files** - Use `.env.example` as template
2. **Rotate credentials regularly** - Especially after team changes
3. **Use separate keys** - Development vs Production
4. **Monitor logs** - Watch for unusual activity
5. **Keep dependencies updated** - Run `pnpm update` regularly

### For Self-Hosters

1. **Generate unique encryption keys** - Never use examples
2. **Secure your database** - Use strong passwords, limit access
3. **Enable firewall** - Only expose necessary ports
4. **Regular backups** - Encrypt and store securely
5. **Monitor resources** - Watch for unusual CPU/memory usage

---

## 🏗️ Security Features

### Data Protection

- ✅ AES-256-GCM encryption for private keys
- ✅ Unique salt per user
- ✅ No plaintext keys in database
- ✅ Ephemeral Discord responses for sensitive data

### Network Security

- ✅ Docker network isolation
- ✅ API rate limiting (60/min global, 10/min financial)
- ✅ CORS configuration
- ✅ Helmet.js security headers

### Application Security

- ✅ Input validation (Zod)
- ✅ SQL injection prevention (Prisma ORM)
- ✅ Error handling without information leakage
- ✅ Logging without sensitive data

---

## 📋 Security Checklist

### Before Deploying to Production

- [ ] Generate unique `MASTER_ENCRYPTION_KEY`
- [ ] Use strong database password
- [ ] Enable firewall
- [ ] Set up monitoring
- [ ] Configure backups
- [ ] Test disaster recovery

### Regular Maintenance

- [ ] Update dependencies monthly
- [ ] Review logs weekly
- [ ] Check for security advisories
- [ ] Rotate API keys quarterly
- [ ] Test backups monthly

---

## 🚨 Known Security Limitations

1. **Discord DMs are not E2EE** - Private keys sent via DM are encrypted in transit but not end-to-end encrypted
2. **Custodial by design** - While non-custodial (users own keys), the bot has access to encrypted keys
3. **Single point of failure** - Master encryption key compromise affects all users

### Mitigations

- Users can export keys and use external wallets
- Master key stored only in environment, never in code
- Regular security audits recommended

---

## 📚 Additional Resources

- [Discord Security](https://discord.com/security)
- [Solana Security](https://solana.com/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Docker Security Best Practices](https://docs.docker.com/engine/security/)

---

## 🏆 Security Hall of Fame

We appreciate responsible disclosure. Contributors who report valid security issues will be acknowledged here (with permission).

**No reports yet** - Be the first!

---

## 📞 Contact

**Security Team:** security@codestats.gg  
**PGP Key:** [Available upon request]  
**Response Time:** Within 48 hours

---

**License:** MIT  
**Repository:** https://github.com/brokechubb/FatTips
