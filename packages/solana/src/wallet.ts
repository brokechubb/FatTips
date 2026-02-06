import { Keypair, PublicKey } from '@solana/web3.js';
import * as bip39 from 'bip39';
import * as crypto from 'crypto';
import bs58 from 'bs58';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

export interface WalletData {
  publicKey: string;
  encryptedPrivateKey: string;
  keySalt: string;
  encryptedMnemonic?: string;
  mnemonicSalt?: string;
  mnemonic?: string;
}

export class WalletService {
  private masterKey: Buffer;

  constructor(masterEncryptionKey: string) {
    this.masterKey = Buffer.from(masterEncryptionKey, 'base64');
    if (this.masterKey.length !== 32) {
      throw new Error('Master encryption key must be 32 bytes (base64 encoded)');
    }
  }

  /**
   * Generate a new Solana wallet with mnemonic
   */
  generateWallet(): { keypair: Keypair; mnemonic: string } {
    const mnemonic = bip39.generateMnemonic();
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const keypair = Keypair.fromSeed(seed.subarray(0, 32));

    return { keypair, mnemonic };
  }

  /**
   * Restore a wallet from mnemonic
   */
  restoreWalletFromMnemonic(mnemonic: string): Keypair {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    return Keypair.fromSeed(seed.subarray(0, 32));
  }

  /**
   * Encrypt a private key using AES-256-GCM
   */
  encryptPrivateKey(privateKey: Buffer): { encrypted: string; salt: string } {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    // Derive key using PBKDF2
    const derivedKey = crypto.pbkdf2Sync(this.masterKey, salt, 100000, 32, 'sha256');

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Combine salt + iv + tag + encrypted
    const result = Buffer.concat([salt, iv, tag, encrypted]);

    return {
      encrypted: result.toString('base64'),
      salt: salt.toString('base64'),
    };
  }

  /**
   * Decrypt a private key
   */
  decryptPrivateKey(encryptedData: string, salt: string): Buffer {
    const data = Buffer.from(encryptedData, 'base64');
    const saltBuffer = Buffer.from(salt, 'base64');

    // Extract components
    const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    // Derive key
    const derivedKey = crypto.pbkdf2Sync(this.masterKey, saltBuffer, 100000, 32, 'sha256');

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return decrypted;
  }

  /**
   * Create a new wallet with full encryption
   */
  createEncryptedWallet(): WalletData & { mnemonic: string } {
    const { keypair, mnemonic } = this.generateWallet();
    const privateKey = keypair.secretKey;

    const { encrypted, salt } = this.encryptPrivateKey(Buffer.from(privateKey));

    // Encrypt mnemonic separately
    const mnemonicBuffer = Buffer.from(mnemonic, 'utf8');
    const { encrypted: encryptedMnemonic, salt: mnemonicSalt } =
      this.encryptPrivateKey(mnemonicBuffer);

    return {
      publicKey: keypair.publicKey.toBase58(),
      encryptedPrivateKey: encrypted,
      keySalt: salt,
      encryptedMnemonic: encryptedMnemonic,
      mnemonicSalt: mnemonicSalt,
      mnemonic,
    };
  }

  /**
   * Decrypt the mnemonic
   */
  decryptMnemonic(encryptedMnemonic: string, salt: string): string {
    const decrypted = this.decryptPrivateKey(encryptedMnemonic, salt);
    return decrypted.toString('utf8');
  }

  /**
   * Get keypair from encrypted data
   */
  getKeypair(encryptedPrivateKey: string, salt: string): Keypair {
    const decrypted = this.decryptPrivateKey(encryptedPrivateKey, salt);
    return Keypair.fromSecretKey(decrypted);
  }

  /**
   * Export private key as Base58 string (Phantom style)
   */
  exportPrivateKey(encryptedPrivateKey: string, salt: string): string {
    const decrypted = this.decryptPrivateKey(encryptedPrivateKey, salt);
    return bs58.encode(decrypted);
  }

  /**
   * Validate a Solana public key
   */
  static isValidPublicKey(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
}

export { Keypair, PublicKey };
