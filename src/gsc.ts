/**
 * Google Search Console ingestion — dormant until the GSC_SERVICE_ACCOUNT_JSON
 * secret is configured (a service account added to the Search Console property
 * with read access). Pulls page+query daily metrics into gsc_daily; GSC data
 * lags ~2 days, so each run re-pulls a trailing window and upserts.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const ROW_LIMIT = 5000;
const LAG_DAYS = 2;
const WINDOW_DAYS = 3;

type ServiceAccount = { client_email: string; private_key: string };

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export async function ingestGsc(env: Env): Promise<{ skipped?: string; upserted?: number; window?: string }> {
  if (!env.GSC_SERVICE_ACCOUNT_JSON) return { skipped: 'GSC_SERVICE_ACCOUNT_JSON not configured' };

  const sa = JSON.parse(env.GSC_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  const token = await accessToken(sa);
  const startDate = isoDaysAgo(LAG_DAYS + WINDOW_DAYS - 1);
  const endDate = isoDaysAgo(LAG_DAYS);
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(env.GSC_PROPERTY)}/searchAnalytics/query`;

  type Row = { keys: [string, string, string]; clicks: number; impressions: number; ctr: number; position: number };
  const rows: Row[] = [];
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['date', 'page', 'query'], rowLimit: ROW_LIMIT, startRow }),
    });
    if (!res.ok) throw new Error(`searchanalytics query failed: ${res.status} ${await res.text()}`);
    const batch = ((await res.json()) as { rows?: Row[] }).rows ?? [];
    rows.push(...batch);
    if (batch.length < ROW_LIMIT) break;
  }

  if (rows.length > 0) {
    const upsert = env.DB.prepare(
      `INSERT OR REPLACE INTO gsc_daily (date, page, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    // D1 batches are capped well above this chunk size; chunk to stay safe.
    for (let i = 0; i < rows.length; i += 500) {
      await env.DB.batch(
        rows.slice(i, i + 500).map((r) => upsert.bind(r.keys[0], r.keys[1], r.keys[2], r.clicks, r.impressions, r.ctr, r.position))
      );
    }
  }

  console.log(JSON.stringify({ evt: 'gsc_ingest_complete', window: `${startDate}..${endDate}`, rows: rows.length }));
  return { upserted: rows.length, window: `${startDate}..${endDate}` };
}
