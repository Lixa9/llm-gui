import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { Context, Next } from 'hono';
import { getConfig } from './config';
import { getDb, generateId } from './db/index';
import { logger } from './logger';
import type { Role, SessionPayload } from './types';

// JWKS cache — createRemoteJWKSet handles caching internally
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _discoveredEndpoints: { token_endpoint: string; end_session_endpoint?: string } | null = null;

// Brute-force protection for local login
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function getClientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? 'unknown';
}

function isLoginLocked(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  // Entry exists but lockout hasn't been triggered yet — don't delete, just not locked
  if (entry.lockedUntil === 0) return false;
  // Active lockout
  if (entry.lockedUntil > Date.now()) return true;
  // Lockout expired — clear it
  loginAttempts.delete(ip);
  return false;
}

function recordLoginFailure(ip: string): void {
  const entry = loginAttempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.count = 0;
    logger.warn('Local login locked out', { ip });
  }
  loginAttempts.set(ip, entry);
}

function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

async function discover() {
  if (_discoveredEndpoints) return _discoveredEndpoints;
  const cfg = getConfig().oidc;
  if (!cfg) throw new Error('OIDC is not configured');
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  const data = await res.json() as { jwks_uri: string; token_endpoint: string; end_session_endpoint?: string };
  _jwks = createRemoteJWKSet(new URL(data.jwks_uri));
  _discoveredEndpoints = {
    token_endpoint: data.token_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
  return _discoveredEndpoints;
}

function resolveRole(groups: string[]): Role {
  const cfg = getConfig();
  for (const mapping of cfg.rbac.mappings) {
    if (groups.includes(mapping.oidc_group)) return mapping.role;
  }
  return cfg.rbac.default_role;
}

async function signSession(payload: Omit<SessionPayload, 'exp' | 'iat'>): Promise<string> {
  const secret = new TextEncoder().encode(getConfig().app.secret_key);
  return new SignJWT({ ...payload } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
}

function localAuthCredentials(): { username: string; password: string } | null {
  const username = process.env.LOCAL_ADMIN_USERNAME;
  const password = process.env.LOCAL_ADMIN_PASSWORD;
  if (username && password) return { username, password };
  return null;
}

async function checkLocalPassword(input: string, stored: string): Promise<boolean> {
  // Detect bcrypt / argon2 hashes by their prefix
  if (stored.startsWith('$2b$') || stored.startsWith('$2a$') || stored.startsWith('$argon2')) {
    return Bun.password.verify(input, stored);
  }
  // Plain text — timing-safe comparison
  const a = Buffer.from(input);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const secret = new TextEncoder().encode(getConfig().app.secret_key);
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export const authRouter = new Hono();

authRouter.get('/login', async (c) => {
  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch (e) {
    logger.warn('OIDC discovery failed', { error: String(e) });
    return c.html(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">' +
      '<h2>SSO unavailable</h2><p>OIDC is not configured or the provider is unreachable.</p>' +
      '<a href="/">← Back</a></body></html>',
      503
    );
  }
  const cfg = getConfig();

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64url');
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString('base64url');
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');

  setCookie(c, 'oidc_pkce', JSON.stringify({ verifier, state }), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  });

  const oidc = cfg.oidc!;
  const params = new URLSearchParams({
    client_id: oidc.client_id,
    response_type: 'code',
    redirect_uri: `${cfg.app.base_url}/api/auth/callback`,
    scope: oidc.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${oidc.issuer}/oauth2/authorize?${params}`);
});

authRouter.get('/callback', async (c) => {
  const cfg = getConfig();
  const code = c.req.query('code');
  const returnedState = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    logger.warn('OIDC callback error', { error });
    return c.redirect('/#/chat?auth_error=1');
  }

  const pkceRaw = getCookie(c, 'oidc_pkce');
  if (!pkceRaw) return c.text('Missing PKCE cookie', 400);

  const { verifier, state } = JSON.parse(pkceRaw) as { verifier: string; state: string };
  if (state !== returnedState) return c.text('State mismatch', 400);

  deleteCookie(c, 'oidc_pkce', { path: '/' });

  let endpoints: Awaited<ReturnType<typeof discover>>;
  try {
    endpoints = await discover();
  } catch {
    return c.redirect('/#/chat?auth_error=1');
  }
  const oidc = cfg.oidc!;

  // Exchange code for tokens
  const tokenRes = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: `${cfg.app.base_url}/api/auth/callback`,
      client_id: oidc.client_id,
      client_secret: oidc.client_secret,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    logger.error('Token exchange failed', { status: tokenRes.status });
    return c.redirect('/#/chat?auth_error=1');
  }

  const tokens = await tokenRes.json() as { id_token: string; access_token: string };

  // Verify ID token
  if (!_jwks) return c.text('JWKS not loaded', 500);
  const { payload: idPayload } = await jwtVerify(tokens.id_token, _jwks, {
    issuer: oidc.issuer,
    audience: oidc.client_id,
  });

  const sub = idPayload.sub!;
  const email = (idPayload['email'] as string) ?? '';
  const name = (idPayload['name'] as string) ?? (idPayload['preferred_username'] as string) ?? email;
  const groups = ((idPayload[cfg.rbac.group_claim] as string[]) ?? []);

  // Resolve role
  const db = getDb();
  const existingOverride = db.query<{ role_override: string | null }, [string]>(
    'SELECT role_override FROM users WHERE sub = ?'
  ).get(sub);

  let role: Role;
  if (groups.some(g => cfg.rbac.mappings.some(m => m.oidc_group === g))) {
    role = resolveRole(groups);
  } else if (existingOverride?.role_override) {
    role = existingOverride.role_override as Role;
  } else {
    role = cfg.rbac.default_role;
  }

  // Upsert user
  db.query(
    `INSERT INTO users (sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name`
  ).run(sub, email, name);

  const sessionToken = await signSession({ sub, email, name, role, method: 'oidc' });

  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  return c.redirect('/');
});

authRouter.get('/logout', async (c) => {
  const token = getCookie(c, 'session');
  const payload = token ? await verifySession(token) : null;
  deleteCookie(c, 'session', { path: '/' });
  if (payload?.method === 'oidc') {
    const endpoints = await discover().catch(() => null);
    if (endpoints?.end_session_endpoint) {
      return c.redirect(endpoints.end_session_endpoint);
    }
  }
  return c.redirect('/');
});

authRouter.get('/local-enabled', (c) => {
  return c.json({ enabled: localAuthCredentials() !== null });
});

authRouter.post('/local', async (c) => {
  const creds = localAuthCredentials();
  if (!creds) return c.json({ error: 'Local auth disabled' }, 403);

  const ip = getClientIp(c);
  if (isLoginLocked(ip)) {
    return c.json({ error: 'Too many failed attempts. Try again later.' }, 429);
  }

  const body = await c.req.json() as { username?: string; password?: string };
  if (!body.username || !body.password) {
    return c.json({ error: 'Missing credentials' }, 400);
  }

  if (body.username !== creds.username) {
    recordLoginFailure(ip);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await checkLocalPassword(body.password, creds.password);
  if (!valid) {
    recordLoginFailure(ip);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  clearLoginFailures(ip);

  const db = getDb();
  const sub = 'local:admin';
  db.query(
    `INSERT INTO users (sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET name=excluded.name`
  ).run(sub, '', creds.username);

  const sessionToken = await signSession({ sub, email: '', name: creds.username, role: 'admin', method: 'local' });
  setCookie(c, 'session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
  });

  logger.info('Local admin login', { username: creds.username });
  return c.json({ ok: true });
});

authRouter.get('/me', async (c) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const payload = await verifySession(token);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ sub: payload.sub, email: payload.email, name: payload.name, role: payload.role });
});

// Middleware
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const payload = await verifySession(token);
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  c.set('user', payload);
  return next();
}

export function requireRole(role: Role) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const token = getCookie(c, 'session');
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const payload = await verifySession(token);
    if (!payload) return c.json({ error: 'Unauthorized' }, 401);
    if (payload.role !== role) return c.json({ error: 'Forbidden' }, 403);
    c.set('user', payload);
    return next();
  };
}
