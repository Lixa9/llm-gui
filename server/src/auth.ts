import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Context, Next } from 'hono';
import { getConfig } from './config.ts';
import { getDb, generateId } from './db/index.ts';
import { logger } from './logger.ts';
import type { Role, SessionPayload } from './types.ts';

const sessionRowSchema = z.object({
  id: z.string(),
  sub: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'user']),
  method: z.enum(['oidc', 'local']),
  expires_at: z.coerce.number(),
});

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _discoveredEndpoints: {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
} | null = null;
let _discoveredAt = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

export function invalidateAuthDiscoveryCache(): void {
  _jwks = null;
  _discoveredEndpoints = null;
  _discoveredAt = 0;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isSecureCookieRequired(): boolean {
  return getConfig().app.base_url.startsWith('https://');
}

function sessionCookieName(): string {
  return isSecureCookieRequired() ? '__Host-session' : 'session';
}

export function isLocalAuthEnabled(): boolean {
  const value = process.env.LOCAL_AUTH?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

async function isLoginLocked(username: string): Promise<boolean> {
  const row = await getDb().prepare('SELECT locked_until FROM login_lockouts WHERE username=?').get<{ locked_until: number }>(username);
  if (!row || row.locked_until === 0) return false;
  if (row.locked_until > Date.now()) return true;
  await getDb().prepare('DELETE FROM login_lockouts WHERE username=?').run(username);
  return false;
}

async function recordLoginFailure(username: string): Promise<void> {
  const db = getDb();
  const row = await db.prepare('SELECT attempts FROM login_lockouts WHERE username=?').get<{ attempts: number }>(username);
  const attempts = (row?.attempts ?? 0) + 1;
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    const lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    await db.prepare(`
      INSERT INTO login_lockouts (username, attempts, locked_until) VALUES (?, 0, ?)
      ON CONFLICT(username) DO UPDATE SET attempts=0, locked_until=excluded.locked_until
    `).run(username, lockedUntil);
    logger.warn('Local test login locked out');
  } else {
    await db.prepare(`
      INSERT INTO login_lockouts (username, attempts, locked_until) VALUES (?, ?, 0)
      ON CONFLICT(username) DO UPDATE SET attempts=excluded.attempts
    `).run(username, attempts);
  }
}

async function clearLoginFailures(username: string): Promise<void> {
  await getDb().prepare('DELETE FROM login_lockouts WHERE username=?').run(username);
}

async function discover() {
  if (_discoveredEndpoints && Date.now() - _discoveredAt < DISCOVERY_TTL_MS) return _discoveredEndpoints;
  const cfg = getConfig().oidc;
  if (!cfg) throw new Error('OIDC is not configured');
  const response = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
  const data = await response.json() as {
    jwks_uri: string;
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
    end_session_endpoint?: string;
  };
  _jwks = createRemoteJWKSet(new URL(data.jwks_uri));
  _discoveredEndpoints = {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    userinfo_endpoint: data.userinfo_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
  _discoveredAt = Date.now();
  return _discoveredEndpoints;
}

function normalizeGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function resolveRole(groups: string[]): Role {
  const cfg = getConfig();
  for (const mapping of cfg.rbac.mappings) {
    if (groups.includes(mapping.oidc_group)) return mapping.role;
  }
  return cfg.rbac.default_role;
}

async function createSession(payload: Omit<SessionPayload, 'sessionId' | 'expiresAt'>): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const sessionId = generateId();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await getDb().prepare(`
    INSERT INTO sessions (id, token_hash, sub, email, name, role, method, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, hashToken(token), payload.sub, payload.email, payload.name, payload.role, payload.method, expiresAt);
  return token;
}

async function verifySession(token: string): Promise<SessionPayload | null> {
  if (!token || token.length < 40) return null;
  const row = await getDb().prepare(`
    SELECT id, sub, email, name, role, method, expires_at
    FROM sessions WHERE token_hash=? AND expires_at>?
  `).get(hashToken(token), Date.now());
  const parsed = sessionRowSchema.safeParse(row);
  if (!parsed.success) return null;
  return {
    sub: parsed.data.sub,
    email: parsed.data.email,
    name: parsed.data.name,
    role: parsed.data.role,
    method: parsed.data.method,
    sessionId: parsed.data.id,
    expiresAt: parsed.data.expires_at,
  };
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, sessionCookieName(), token, {
    httpOnly: true,
    secure: isSecureCookieRequired(),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export const authRouter = new Hono();

authRouter.get('/login', async (c) => {
  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch (error) {
    logger.warn('OIDC discovery failed', { error: String(error) });
    return c.html('<!DOCTYPE html><html><body><h2>SSO unavailable</h2><p>The identity provider is unreachable or not configured.</p><a href="/">Back</a></body></html>', 503);
  }
  const cfg = getConfig();
  const oidc = cfg.oidc;
  if (!oidc) return c.text('OIDC is not configured', 503);

  const verifier = randomBytes(64).toString('base64url');
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString('base64url');
  const state = randomBytes(16).toString('hex');
  setCookie(c, 'oidc_pkce', JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure: isSecureCookieRequired(),
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });

  const redirectUri = `${cfg.app.base_url.replace(/\/$/, '')}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: oidc.client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: oidc.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return c.redirect(`${endpoints.authorization_endpoint}?${params}`);
});

authRouter.get('/callback', async (c) => {
  const cfg = getConfig();
  const code = c.req.query('code');
  const returnedState = c.req.query('state');
  if (c.req.query('error') || !code) return c.redirect('/#/chat?auth_error=1');

  const pkceRaw = getCookie(c, 'oidc_pkce');
  if (!pkceRaw) return c.text('Missing PKCE cookie', 400);
  let verifier = '';
  let state = '';
  try {
    const parsed = JSON.parse(pkceRaw) as { verifier?: string; state?: string };
    verifier = parsed.verifier ?? '';
    state = parsed.state ?? '';
  } catch {
    logger.warn('Invalid PKCE cookie');
    return c.text('Invalid PKCE cookie', 400);
  }
  if (!verifier || !state || !returnedState || !timingSafeStringEqual(state, returnedState)) return c.text('State mismatch', 400);
  deleteCookie(c, 'oidc_pkce', { path: '/' });

  const oidc = cfg.oidc;
  if (!oidc) return c.redirect('/#/chat?auth_error=1');
  let endpoints: Awaited<ReturnType<typeof discover>>;
  try { endpoints = await discover(); } catch { return c.redirect('/#/chat?auth_error=1'); }
  const redirectUri = `${cfg.app.base_url.replace(/\/$/, '')}/api/auth/callback`;

  let tokens: { id_token: string; access_token: string };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const bodyParams: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
    if (oidc.client_secret) {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(oidc.client_id)}:${encodeURIComponent(oidc.client_secret)}`).toString('base64')}`;
    } else {
      bodyParams.client_id = oidc.client_id;
    }
    const response = await fetch(endpoints.token_endpoint, { method: 'POST', headers, body: new URLSearchParams(bodyParams), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return c.redirect('/#/chat?auth_error=1');
    tokens = await response.json() as { id_token: string; access_token: string };
  } catch (error) {
    logger.error('OIDC token exchange failed', { error: String(error) });
    return c.redirect('/#/chat?auth_error=1');
  }

  if (!_jwks) return c.text('OIDC verification unavailable', 503);
  let idPayload;
  try {
    idPayload = (await jwtVerify(tokens.id_token, _jwks, { issuer: oidc.issuer, audience: oidc.client_id, clockTolerance: 30 })).payload;
  } catch (error) {
    logger.error('ID token verification failed', { error: String(error) });
    return c.redirect('/#/chat?auth_error=1');
  }
  const sub = idPayload.sub;
  if (!sub) return c.redirect('/#/chat?auth_error=1');

  let userinfo: Record<string, unknown> = {};
  if (endpoints.userinfo_endpoint) {
    try {
      const response = await fetch(endpoints.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) userinfo = await response.json() as Record<string, unknown>;
    } catch (error) { logger.warn('Failed to fetch userinfo', { error: String(error) }); }
  }
  if (userinfo.sub && userinfo.sub !== sub) return c.redirect('/#/chat?auth_error=1');
  const email = (idPayload.email as string) ?? (userinfo.email as string) ?? '';
  const name = (idPayload.name as string) ?? (idPayload.preferred_username as string) ?? (userinfo.name as string) ?? email;
  const groups = normalizeGroups(userinfo[cfg.rbac.group_claim] ?? idPayload[cfg.rbac.group_claim]);
  const role = resolveRole(groups);

  const db = getDb();
  await db.prepare(`
    INSERT INTO users (sub, email, name, last_known_role, role_updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sub) DO UPDATE SET
      email=excluded.email,
      name=excluded.name,
      last_known_role=excluded.last_known_role,
      role_updated_at=excluded.role_updated_at
  `).run(sub, email, name, role, Date.now());
  const session = await createSession({ sub, email, name, role, method: 'oidc' });
  setSessionCookie(c, session);
  logger.info('OIDC login success', { sub, role });
  return c.redirect('/');
});

export async function purgeExpiredSessions(): Promise<void> {
  const result = await getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  if (result.changes > 0) logger.info('Purged expired sessions', { count: result.changes });
}

authRouter.post('/logout', async (c) => {
  const token = getCookie(c, sessionCookieName());
  const payload = token ? await verifySession(token) : null;
  deleteCookie(c, sessionCookieName(), { path: '/' });
  if (payload) await getDb().prepare('DELETE FROM sessions WHERE id=?').run(payload.sessionId);
  if (payload?.method === 'oidc') {
    const endpoints = await discover().catch(() => null);
    if (endpoints?.end_session_endpoint) return c.redirect(endpoints.end_session_endpoint);
  }
  return c.redirect('/');
});

authRouter.get('/local-enabled', (c) => c.json({ enabled: isLocalAuthEnabled() }));

authRouter.post('/local', async (c) => {
  if (!isLocalAuthEnabled()) return c.json({ error: 'Local test auth disabled' }, 403);
  const body = await c.req.json() as { username?: string; password?: string };
  if (!body.username || !body.password) return c.json({ error: 'Missing credentials' }, 400);
  if (await isLoginLocked(body.username)) return c.json({ error: 'Too many failed attempts. Try again later.' }, 429);

  const valid = timingSafeStringEqual(body.username, 'admin') && timingSafeStringEqual(body.password, 'admin');
  if (!valid) {
    await recordLoginFailure(body.username);
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  await clearLoginFailures(body.username);
  const db = getDb();
  const sub = 'local:test-admin';
  await db.prepare(`
    INSERT INTO users (sub, email, name, last_known_role, role_updated_at) VALUES (?, '', 'admin', 'admin', ?)
    ON CONFLICT(sub) DO UPDATE SET
      name=excluded.name,
      last_known_role=excluded.last_known_role,
      role_updated_at=excluded.role_updated_at
  `).run(sub, Date.now());
  const session = await createSession({ sub, email: '', name: 'admin', role: 'admin', method: 'local' });
  setSessionCookie(c, session);
  return c.json({ ok: true });
});

authRouter.get('/me', async (c) => {
  const token = getCookie(c, sessionCookieName());
  const payload = token ? await verifySession(token) : null;
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ sub: payload.sub, email: payload.email, name: payload.name, role: payload.role });
});

async function authenticate(c: Context): Promise<SessionPayload | null> {
  const token = getCookie(c, sessionCookieName());
  if (!token) return null;
  const payload = await verifySession(token);
  if (payload) c.set('user', payload);
  return payload;
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!(await authenticate(c))) return c.json({ error: 'Unauthorized' }, 401);
  return next();
}

export function requireRole(role: Role) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const payload = await authenticate(c);
    if (!payload) return c.json({ error: 'Unauthorized' }, 401);
    if (payload.role !== role) return c.json({ error: 'Forbidden' }, 403);
    return next();
  };
}
