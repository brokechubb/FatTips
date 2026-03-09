import { describe, it, expect } from 'vitest';
import { WalletService } from './wallet';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

describe('WalletService', () => {
  // 32-byte base64 string for testing
  const MOCK_MASTER_KEY = Buffer.alloc(32, 'test-key-123').toString('base64');
  const walletService = new WalletService(MOCK_MASTER_KEY);

  it('should generate a valid wallet with mnemonic', async () => {
    const start = Date.now();
    const result = await walletService.generateWallet();
    const duration = Date.now() - start;

    expect(result).toHaveProperty('keypair');
    expect(result).toHaveProperty('mnemonic');
    expect(result.mnemonic.split(' ').length).toBe(12); // BIP39 default
    expect(result.keypair).toBeInstanceOf(Keypair);

    console.log(`Wallet generation took ${duration}ms`);
  });

  it('should encrypt and decrypt a private key correctly', async () => {
    const { keypair } = await walletService.generateWallet();
    const originalPrivateKey = keypair.secretKey;

    // Encrypt
    const { encrypted, salt } = await walletService.encryptPrivateKey(
      Buffer.from(originalPrivateKey)
    );

    expect(encrypted).toBeDefined();
    expect(salt).toBeDefined();
    expect(typeof encrypted).toBe('string');
    expect(typeof salt).toBe('string');

    // Decrypt
    const decryptedPrivateKey = await walletService.decryptPrivateKey(encrypted, salt);

    expect(decryptedPrivateKey).toBeInstanceOf(Buffer);
    expect(decryptedPrivateKey.equals(Buffer.from(originalPrivateKey))).toBe(true);
  });

  it('should create an encrypted wallet with all fields', async () => {
    const result = await walletService.createEncryptedWallet();

    expect(result.publicKey).toBeDefined();
    expect(result.encryptedPrivateKey).toBeDefined();
    expect(result.keySalt).toBeDefined();
    expect(result.encryptedMnemonic).toBeDefined();
    expect(result.mnemonicSalt).toBeDefined();
    expect(result.mnemonic).toBeDefined();
    expect(result.privateKeyBase58).toBeDefined();

    // Verify recovery
    const recoveredKeypair = await walletService.getKeypair(
      result.encryptedPrivateKey,
      result.keySalt
    );
    expect(recoveredKeypair.publicKey.toBase58()).toBe(result.publicKey);
  });

  it('should recover private key from export format', async () => {
    const wallet = await walletService.createEncryptedWallet();

    // Export
    const exportedKey = await walletService.exportPrivateKey(
      wallet.encryptedPrivateKey,
      wallet.keySalt
    );

    // It should be a base58 string
    expect(typeof exportedKey).toBe('string');

    // Verify it matches the original private key
    const decodedKey = bs58.decode(exportedKey);
    const kp = Keypair.fromSecretKey(decodedKey);
    expect(kp.publicKey.toBase58()).toBe(wallet.publicKey);
  });

  it('should decrypt mnemonic correctly', async () => {
    const wallet = await walletService.createEncryptedWallet();

    // Decrypt
    const decryptedMnemonic = await walletService.decryptMnemonic(
      wallet.encryptedMnemonic!,
      wallet.mnemonicSalt!
    );

    expect(decryptedMnemonic).toBe(wallet.mnemonic);
  });
});
