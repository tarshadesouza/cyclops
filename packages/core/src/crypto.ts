import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits — NIST recommended for GCM
const TAG_LENGTH = 16;  // 128 bits auth tag (default)

function getEncryptionKey(): Buffer {
  const keyHex = process.env['CYCLOPS_ENCRYPTION_KEY'];
  if (!keyHex) throw new Error('CYCLOPS_ENCRYPTION_KEY env var not set');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('CYCLOPS_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return key;
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as: base64(iv[12] + authTag[16] + ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptApiKey(encoded: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
