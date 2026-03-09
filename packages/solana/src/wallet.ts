import { Keypair, PublicKey } from '@solana/web3.js';
import * as bip39 from 'bip39';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { promisify } from 'util';

const pbkdf2Async = promisify(crypto.pbkdf2);

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
  async generateWallet(): Promise<{ keypair: Keypair; mnemonic: string }> {
    const mnemonic = bip39.generateMnemonic();
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const keypair = Keypair.fromSeed(seed.subarray(0, 32));

    return { keypair, mnemonic };
  }

  /**
   * Restore a wallet from mnemonic
   */
  async restoreWalletFromMnemonic(mnemonic: string): Promise<Keypair> {
    const seed = await bip39.mnemonicToSeed(mnemonic);
    return Keypair.fromSeed(seed.subarray(0, 32));
  }

  /**
   * Encrypt a private key using AES-256-GCM
   */
  async encryptPrivateKey(privateKey: Buffer): Promise<{ encrypted: string; salt: string }> {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    // Derive key using PBKDF2
    const derivedKey = (await pbkdf2Async(this.masterKey, salt, 100000, 32, 'sha256')) as Buffer;

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
  async decryptPrivateKey(encryptedData: string, salt: string): Promise<Buffer> {
    const data = Buffer.from(encryptedData, 'base64');
    const saltBuffer = Buffer.from(salt, 'base64');

    // Extract components
    const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    // Derive key
    const derivedKey = (await pbkdf2Async(
      this.masterKey,
      saltBuffer,
      100000,
      32,
      'sha256'
    )) as Buffer;

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return decrypted;
  }

  /**
   * Create a new wallet with full encryption
   */
  async createEncryptedWallet(): Promise<
    WalletData & { mnemonic: string; privateKeyBase58: string }
  > {
    const { keypair, mnemonic } = await this.generateWallet();
    const privateKey = keypair.secretKey;
    const privateKeyBase58 = bs58.encode(privateKey);

    const { encrypted, salt } = await this.encryptPrivateKey(Buffer.from(privateKey));

    // Encrypt mnemonic separately
    const mnemonicBuffer = Buffer.from(mnemonic, 'utf8');
    const { encrypted: encryptedMnemonic, salt: mnemonicSalt } =
      await this.encryptPrivateKey(mnemonicBuffer);

    return {
      publicKey: keypair.publicKey.toBase58(),
      encryptedPrivateKey: encrypted,
      keySalt: salt,
      encryptedMnemonic: encryptedMnemonic,
      mnemonicSalt: mnemonicSalt,
      mnemonic,
      privateKeyBase58,
    };
  }

  /**
   * Decrypt the mnemonic
   */
  async decryptMnemonic(encryptedMnemonic: string, salt: string): Promise<string> {
    const decrypted = await this.decryptPrivateKey(encryptedMnemonic, salt);
    return decrypted.toString('utf8');
  }

  /**
   * Get keypair from encrypted data
   */
  async getKeypair(encryptedPrivateKey: string, salt: string): Promise<Keypair> {
    const decrypted = await this.decryptPrivateKey(encryptedPrivateKey, salt);
    return Keypair.fromSecretKey(decrypted);
  }

  /**
   * Export private key as Base58 string (Phantom style)
   */
  async exportPrivateKey(encryptedPrivateKey: string, salt: string): Promise<string> {
    const decrypted = await this.decryptPrivateKey(encryptedPrivateKey, salt);
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
