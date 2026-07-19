-- seo-agent D1 schema. Apply with: npm run db:init

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,                -- set when the crawl phase completes
  url_count INTEGER,
  ok INTEGER DEFAULT 0,            -- 1 when the crawl succeeded (baseline-eligible)
  pipeline_done INTEGER DEFAULT 0  -- 1 when the WHOLE run (rules+proposals+gsc) finished; drives the in-progress guard
);

CREATE TABLE IF NOT EXISTS page_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  canonical TEXT,
  og_image TEXT,
  og_type TEXT,
  jsonld_types TEXT,          -- comma-separated @type values seen on the page
  noindex INTEGER DEFAULT 0,
  lastmod TEXT,               -- from the sitemap entry, when present
  error TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON page_snapshots (run_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_path ON page_snapshots (path);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,     -- info | low | medium | high | critical
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_open ON findings (status, path, rule);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  finding_id INTEGER,
  path TEXT NOT NULL,
  field TEXT NOT NULL,        -- description | title
  current_value TEXT,
  proposed_value TEXT NOT NULL,
  rationale TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | approved | rejected | reverted
  decided_at TEXT,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);

-- Journal of every override applied to the live site (and reverts).
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at TEXT NOT NULL,
  path TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  source TEXT NOT NULL,       -- proposal | auto | manual
  proposal_id INTEGER,
  reverted_at TEXT
);

-- Search Console daily metrics (page+query grain). Dormant until the
-- GSC_SERVICE_ACCOUNT_JSON secret is configured.
CREATE TABLE IF NOT EXISTS gsc_daily (
  date TEXT NOT NULL,
  page TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (date, page, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_page ON gsc_daily (page, date);

-- AEO telemetry — AI-relevant hits written directly by the SITE's injector /
-- edge Worker (optional TELEMETRY / AEO_TELEMETRY D1 binding, fire-and-forget
-- via waitUntil, fail-open). The agent reads, aggregates, and prunes (90 days).
-- kind: 'crawler' = known AI-bot UA; 'referral' = human arriving from an AI
-- engine (Referer); 'agent' = unknown client that negotiated markdown.
CREATE TABLE IF NOT EXISTS aeo_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  bot TEXT,
  referrer TEXT,
  path TEXT NOT NULL,
  status INTEGER,
  served TEXT,                     -- 'html' | 'md' (markdown twin) | 'file'; 'lane' (AI content lane) is written by a site-custom tap, not this repo's injector
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_aeo_hits_ts ON aeo_hits (ts);
CREATE INDEX IF NOT EXISTS idx_aeo_hits_bot ON aeo_hits (bot, ts);

-- Citation probes — periodic checks of whether AI answer engines cite the
-- site for configured queries (CITATION_QUERIES). One row per engine × query
-- per probe batch (checked_at identifies the batch).
CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL,
  engine TEXT NOT NULL,            -- gemini | perplexity | openai | anthropic
  query TEXT NOT NULL,
  cited INTEGER NOT NULL,          -- 1 = the site appeared in the answer's sources
  rank INTEGER,                    -- 1-based position of the first matching source
  cited_url TEXT,
  total_sources INTEGER,
  sources TEXT,                    -- JSON array of {url, domain, title}, truncated
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_citations_key ON citations (engine, query, checked_at);
