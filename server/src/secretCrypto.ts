import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';

const SECRET_PREFIX = 'gra1:';
const KEY_SALT = 'grok-register-agent:secret-store:v1';

let derivedKey: Buffer | null | undefined;
let warnedNoKey = false;
const decryptWarnings = new Set<string>();

function normalizedMasterKey(): string {
  return String(process.env.GRA_MASTER_KEY || '').trim();
}

function key(): Buffer | null {
  if (derivedKey !== undefined) return derivedKey;
  const master = normalizedMasterKey();
  if (!master) {
    derivedKey = null;
    return derivedKey;
  }
  derivedKey = scryptSync(master, KEY_SALT, 32);
  return derivedKey;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function isSecretEncryptionAvailable(): boolean {
  return key() !== null;
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

export function warnIfSecretEncryptionUnavailable(context: string): void {
  if (isSecretEncryptionAvailable() || warnedNoKey) return;
  warnedNoKey = true;
  console.warn(
    `[security] GRA_MASTER_KEY is not set; ${context} will be stored as plaintext. ` +
      'Set GRA_MASTER_KEY to enable AES-256-GCM storage encryption.'
  );
}

export function encryptSecretString(value: string): string {
  const text = String(value ?? '');
  if (!text || isEncryptedSecret(text)) return text;
  const k = key();
  if (!k) return text;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

export function decryptSecretString(value: string, label = 'secret'): string {
  const text = String(value ?? '');
  if (!isEncryptedSecret(text)) return text;
  const k = key();
  if (!k) {
    if (!decryptWarnings.has(label)) {
      decryptWarnings.add(label);
      console.warn(
        `[security] ${label} is encrypted but GRA_MASTER_KEY is not set; keeping ciphertext.`
      );
    }
    return text;
  }

  try {
    const packed = text.slice(SECRET_PREFIX.length);
    const parts = packed.split('.');
    if (parts.length !== 3) throw new Error('invalid encrypted secret envelope');
    const [ivRaw, tagRaw, ciphertextRaw] = parts;
    const iv = fromB64url(ivRaw);
    const tag = fromB64url(tagRaw);
    const ciphertext = fromB64url(ciphertextRaw);
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('invalid encrypted secret parameters');
    }
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
  } catch (err) {
    if (!decryptWarnings.has(label)) {
      decryptWarnings.add(label);
      console.error(
        `[security] failed to decrypt ${label}; keeping ciphertext. ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
    return text;
  }
}

export function maybeDecryptSecret(value: unknown, label: string): string {
  return decryptSecretString(typeof value === 'string' ? value : '', label);
}

export function maybeEncryptSecret(value: unknown): string {
  return encryptSecretString(typeof value === 'string' ? value : String(value ?? ''));
}

export function secureCompareString(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
