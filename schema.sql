-- seo-agent D1 schema. Apply with:
--   npx wrangler d1 execute seo-agent-db --remote --file seo-agent/schema.sql -c seo-agent/wrangler.jsonc

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  url_count INTEGER,
  ok INTEGER DEFAULT 0
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
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | approved | rejected
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
