import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { dataDir } from './settingsStore.js';

const AUTH_PATH = join(dataDir(), 'auth.json');
const AUTH_BOOTSTRAP_PATH = join(dataDir(), 'auth-bootstrap.json');
const SESSION_COOKIE = 'grok_register_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_USERNAME = 'admin';
const LOGIN_WINDOW_MS = 1000 * 60 * 10;
const LOGIN_LOCK_MS = 1000 * 60 * 5;
const LOGIN_MAX_FAILURES = 5;

interface AuthRecord {
  username: string;
  passwordHash: string;
  salt: string;
  mustChangePassword: boolean;
}

interface SessionRecord {
  username: string;
  expiresAt: number;
}

interface AuthBootstrapRecord {
  username: string;
  password: string;
  source: 'env' | 'generated';
  createdAt: string;
}

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  mustChangePassword: boolean;
}

export interface AuthBootstrapInfo {
  username: string;
  defaultUsername: string;
  mustChangePassword: boolean;
  bootstrapFile: string | null;
  initialPasswordAvailable: boolean;
  initialPasswordSource: 'env' | 'file' | 'none';
}

export class LoginRateLimitError extends Error {
  retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super('登录失败次数过多，请稍后再试');
    this.name = 'LoginRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

interface LoginAttemptRecord {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

const sessions = new Map<string, SessionRecord>();
const loginAttempts = new Map<string, LoginAttemptRecord>();
let cache: AuthRecord | null = null;

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 32).toString('hex');
}

function makeRecord(username: string, password: string, mustChangePassword: boolean): AuthRecord {
  const salt = randomBytes(16).toString('hex');
  return {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    mustChangePassword
  };
}

function randomInitialPassword(): string {
  return randomBytes(24).toString('base64url');
}

async function atomicWriteJson(path: string, doc: unknown, mode?: number) {
  await fsp.mkdir(dataDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode });
  await fsp.rename(tmp, path);
  if (mode != null) {
    try {
      await fsp.chmod(path, mode);
    } catch {
      /* chmod is best-effort on Windows */
    }
  }
}

async function readBootstrapRecord(): Promise<AuthBootstrapRecord | null> {
  if (!existsSync(AUTH_BOOTSTRAP_PATH)) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(AUTH_BOOTSTRAP_PATH, 'utf-8')) as Partial<AuthBootstrapRecord>;
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    if (!username || !password) return null;
    return {
      username,
      password,
      source: parsed.source === 'env' ? 'env' : 'generated',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function writeBootstrapRecord(record: AuthBootstrapRecord) {
  await atomicWriteJson(AUTH_BOOTSTRAP_PATH, record, 0o600);
}

async function removeBootstrapRecord() {
  try {
    await fsp.unlink(AUTH_BOOTSTRAP_PATH);
  } catch {
    /* missing is fine */
  }
}

async function initialCredentials(): Promise<{ username: string; password: string }> {
  const username = DEFAULT_USERNAME;
  const fromEnv = String(process.env.GRA_INITIAL_PASSWORD || '').trim();
  if (fromEnv) {
    await writeBootstrapRecord({
      username,
      password: fromEnv,
      source: 'env',
      createdAt: new Date().toISOString()
    });
    return { username, password: fromEnv };
  }

  const existing = await readBootstrapRecord();
  if (existing?.password) {
    return { username: existing.username || username, password: existing.password };
  }

  const password = randomInitialPassword();
  await writeBootstrapRecord({
    username,
    password,
    source: 'generated',
    createdAt: new Date().toISOString()
  });
  return { username, password };
}

async function defaultRecord(): Promise<AuthRecord> {
  const initial = await initialCredentials();
  return makeRecord(initial.username, initial.password, true);
}

async function loadAuthRecord(): Promise<AuthRecord> {
  if (cache) return cache;
  if (!existsSync(AUTH_PATH)) {
    cache = await defaultRecord();
    await saveAuthRecord(cache);
    return cache;
  }
  try {
    const raw = await fsp.readFile(AUTH_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthRecord>;
    if (!parsed.username || !parsed.passwordHash || !parsed.salt) {
      cache = await defaultRecord();
      await saveAuthRecord(cache);
      return cache;
    }
    cache = {
      username: parsed.username,
      passwordHash: parsed.passwordHash,
      salt: parsed.salt,
      mustChangePassword: parsed.mustChangePassword ?? false
    };
    return cache;
  } catch {
    cache = await defaultRecord();
    await saveAuthRecord(cache);
    return cache;
  }
}

async function saveAuthRecord(next: AuthRecord) {
  cache = next;
  await atomicWriteJson(AUTH_PATH, next, 0o600);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      acc[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
      return acc;
    }, {});
}

function safeCompare(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyPassword(record: AuthRecord, password: string) {
  return safeCompare(hashPassword(password, record.salt), record.passwordHash);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

setInterval(pruneSessions, 1000 * 60 * 10).unref();

function pruneLoginAttempts() {
  const now = Date.now();
  for (const [key, item] of loginAttempts) {
    if (item.lockedUntil > now) continue;
    if (now - item.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}

setInterval(pruneLoginAttempts, 1000 * 60 * 10).unref();

function readSessionFromCookie(cookie: string | undefined): SessionRecord | null {
  pruneSessions();
  const token = parseCookies(cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
}

function buildCookie(token: string, expiresAt: number) {
  const secure = process.env.COOKIE_SECURE === '1';
  const pieces = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
  ];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}

function clearCookie() {
  const secure = process.env.COOKIE_SECURE === '1';
  const pieces = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}

function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function loginAttemptKey(req: Request, username: string): string {
  return `${clientIp(req)}|${String(username || '').trim().toLowerCase() || '<empty>'}`;
}

function assertLoginAllowed(key: string): void {
  pruneLoginAttempts();
  const rec = loginAttempts.get(key);
  if (!rec || rec.lockedUntil <= Date.now()) return;
  throw new LoginRateLimitError(Math.ceil((rec.lockedUntil - Date.now()) / 1000));
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const prev = loginAttempts.get(key);
  const rec =
    !prev || now - prev.firstAt > LOGIN_WINDOW_MS
      ? { failures: 0, firstAt: now, lockedUntil: 0 }
      : { ...prev };
  rec.failures += 1;
  if (rec.failures >= LOGIN_MAX_FAILURES) {
    rec.lockedUntil = now + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, rec);
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

function issueSession(record: AuthRecord, res: Response): AuthState {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username: record.username, expiresAt });
  res.append('Set-Cookie', buildCookie(token, expiresAt));
  return {
    authenticated: true,
    username: record.username,
    mustChangePassword: record.mustChangePassword
  };
}

export async function getAuthStateFromCookie(cookie: string | undefined): Promise<AuthState> {
  const session = readSessionFromCookie(cookie);
  if (!session) {
    return { authenticated: false, username: null, mustChangePassword: false };
  }
  const record = await loadAuthRecord();
  if (session.username !== record.username) {
    return { authenticated: false, username: null, mustChangePassword: false };
  }
  return {
    authenticated: true,
    username: record.username,
    mustChangePassword: record.mustChangePassword
  };
}

export async function getAuthState(req: Request): Promise<AuthState> {
  return getAuthStateFromCookie(req.header('cookie'));
}

export async function login(req: Request, res: Response): Promise<AuthState | null> {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = loginAttemptKey(req, username);
  assertLoginAllowed(key);
  const record = await loadAuthRecord();
  if (username !== record.username || !verifyPassword(record, password)) {
    recordLoginFailure(key);
    return null;
  }
  clearLoginFailures(key);
  return issueSession(record, res);
}

export async function logout(req: Request, res: Response) {
  const token = parseCookies(req.header('cookie'))[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.append('Set-Cookie', clearCookie());
}

export async function changeCredentials(
  req: Request,
  res: Response,
  input: unknown
): Promise<AuthState> {
  const state = await getAuthState(req);
  if (!state.authenticated) {
    throw new Error('unauthorized');
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const currentPassword = String(body.currentPassword || '');
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  const record = await loadAuthRecord();

  if (!verifyPassword(record, currentPassword)) {
    throw new Error('当前密码不正确');
  }
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('用户名只能包含字母、数字、下划线、点和短横线，长度 3-32');
  }
  if (password.length < 6 || password.length > 72) {
    throw new Error('新密码长度必须在 6 到 72 位之间');
  }
  if (password !== confirmPassword) {
    throw new Error('两次输入的新密码不一致');
  }

  const next = makeRecord(username, password, false);
  await saveAuthRecord(next);
  await removeBootstrapRecord();
  sessions.clear();
  loginAttempts.clear();
  return issueSession(next, res);
}

export async function authBootstrapInfo(): Promise<AuthBootstrapInfo> {
  const record = await loadAuthRecord();
  const bootstrap = await readBootstrapRecord();
  return {
    username: record.username,
    defaultUsername: DEFAULT_USERNAME,
    mustChangePassword: record.mustChangePassword,
    bootstrapFile: record.mustChangePassword ? AUTH_BOOTSTRAP_PATH : null,
    initialPasswordAvailable: Boolean(record.mustChangePassword && bootstrap?.password),
    initialPasswordSource: record.mustChangePassword
      ? bootstrap?.source === 'env'
        ? 'env'
        : bootstrap?.password
          ? 'file'
          : 'none'
      : 'none'
  };
}
