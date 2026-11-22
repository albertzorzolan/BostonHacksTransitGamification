// Passwords (scrypt) and device sessions (random bearer tokens, stored hashed).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

export const SESSION_DAYS = 30;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, n, r, p, salt, key] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the username doesn't exist, so a failed login takes the same time
// whether or not the account is real.
export const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
