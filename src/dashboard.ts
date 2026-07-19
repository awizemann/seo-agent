/**
 * Human review dashboard — a single self-contained page served by the agent
 * Worker itself. Zero dependencies, zero build step: inline CSS + vanilla JS.
 *
 * Served UNAUTHENTICATED at GET / and GET /dashboard (it contains no secrets —
 * just a login form and client code). The visitor pastes the AGENT_TOKEN once;
 * it is kept in localStorage and sent as `Authorization: Bearer …` on every API
 * call, which is where the real auth lives. Same token as the REST/MCP surface.
 *
 * Layout is a five-tab UI — Overview / Findings / Proposals / Changes /
 * Analytics — driven entirely by the URL hash (#overview … #analytics), so tabs
 * are deep-linkable and back/forward works. The hash is resolved through a fixed
 * whitelist map only (never interpolated into HTML or a selector). The Overview
 * stat cards are real <a href="#…"> links that route into the matching tab.
 *
 * Perf: the heavy /analytics/summary payload is deferred — fetched only when the
 * Analytics or Changes tab is first opened, then cached for the session (and
 * invalidated after a mutating action). The core four (/status /proposals
 * /findings /changes) load up front; switching tabs never refetches them.
 *
 * The embedded client script deliberately avoids template literals and `${…}`
 * so this outer TS template literal needs no escaping.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>SEO Agent</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #fff; --ink: #16181d; --muted: #6b7280; --line: #e5e7eb;
    --accent: #2563eb; --ok: #15803d; --warn: #b45309; --bad: #b91c1c; --chip: #f1f5f9;
    --shadow: 0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f13; --panel: #16181d; --ink: #e8eaed; --muted: #9aa0aa; --line: #262a31;
      --accent: #5b8cff; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --chip: #1e2229;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  a { color: var(--accent); }
  .wrap { max-width: 920px; margin: 0 auto; padding: 20px 16px 80px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  header h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
  header .site { color: var(--muted); font-size: 13px; }
  header .spacer { flex: 1; }
  .muted { color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); }
  .card .n { font-size: 24px; font-weight: 650; letter-spacing: -.02em; }
  .card .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  section { margin-top: 24px; }
  section > h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 10px; }
  .item { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; box-shadow: var(--shadow); }
  .item .path { font-weight: 600; font-size: 14px; word-break: break-all; }
  .item .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .val { border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-size: 13.5px; }
  .val.cur { background: var(--chip); color: var(--muted); text-decoration: line-through; text-decoration-color: var(--bad); }
  .val.new { background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; font-size: 13px; font-weight: 550; border: 1px solid var(--line); background: var(--panel);
    color: var(--ink); border-radius: 8px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.ok { background: var(--ok); border-color: var(--ok); color: #fff; }
  button.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
  button.small { padding: 5px 10px; font-size: 12px; }
  .chip { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  .nw { white-space: nowrap; }
  .chip.high { color: var(--bad); } .chip.medium { color: var(--warn); } .chip.info { color: var(--accent); }
  details > summary { cursor: pointer; font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 550; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  input, textarea { font: inherit; width: 100%; background: var(--panel); color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; }
  .login { max-width: 400px; margin: 12vh auto; text-align: center; }
  .login .card { padding: 24px; text-align: left; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--ink); color: var(--bg);
    padding: 10px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 9; }
  .toast.show { opacity: 1; }
  .empty { color: var(--muted); font-size: 14px; padding: 8px 2px; }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--muted); border-top-color: transparent;
    border-radius: 50%; animation: s .7s linear infinite; vertical-align: -2px; }
  @keyframes s { to { transform: rotate(360deg); } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 10px; box-shadow: var(--shadow); }
  .panel h3 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
  .svgwrap { width: 100%; overflow-x: auto; }
  .legend { font-size: 11px; color: var(--muted); display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; }
  .cit-cell { height: 16px; border-radius: 2px; background: var(--chip); }
  .chip.helped { color: var(--ok); } .chip.hurt { color: var(--bad); } .chip.neutral { color: var(--muted); }
  .chip.applied { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .chip.insufficient_data, .chip.pending { color: var(--muted); background: transparent; border: 1px solid var(--line); }
  .chip.insufficient_data { border-style: dashed; }
  /* Tab bar — anchor links driven by the URL hash; scrolls horizontally when narrow. */
  .tabs { display: flex; gap: 2px; margin: 18px 0 0; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: thin; }
  .tab { flex: 0 0 auto; text-decoration: none; color: var(--muted); font-size: 13px; font-weight: 550;
    padding: 9px 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 6px; border-radius: 8px 8px 0 0; }
  .tab:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .tab.active { color: var(--ink); border-bottom-color: var(--accent); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px;
    font-size: 11px; font-weight: 650; padding: 0 5px; border-radius: 999px; background: var(--accent); color: #fff; }
  .badge[hidden] { display: none; }
  .panel-tab { margin-top: 16px; }
  .panel-tab[hidden] { display: none; }
  .tablewrap { width: 100%; overflow-x: auto; }
  /* Stat cards double as deep links into their tab. */
  a.card { text-decoration: none; color: inherit; display: block; transition: border-color .12s; }
  a.card:hover { border-color: var(--muted); }
  a.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a.card .n { color: var(--ink); }
</style>
</head>
<body>
<div id="login" class="login" style="display:none">
  <div class="card">
    <h1 style="margin:0 0 4px">SEO Agent</h1>
    <p class="muted" style="margin:0 0 16px">Paste your agent token to continue.</p>
    <input id="tok" type="password" placeholder="AGENT_TOKEN" autocomplete="off"/>
    <div class="row"><button class="primary" data-act="login" style="flex:1;justify-content:center">Continue</button></div>
    <p id="loginerr" class="muted" style="color:var(--bad);font-size:13px;min-height:18px;margin:10px 0 0"></p>
  </div>
</div>

<div id="app" class="wrap" style="display:none">
  <header>
    <h1>SEO Agent</h1>
    <span class="site" id="site"></span>
    <span class="spacer"></span>
    <button id="runbtn" class="small" data-act="run">Run pipeline</button>
    <button class="small" data-act="logout">Sign out</button>
  </header>

  <nav class="tabs" id="tabs" aria-label="Dashboard sections">
    <a class="tab" id="tab-overview" href="#overview">Overview</a>
    <a class="tab" id="tab-findings" href="#findings">Findings <span class="badge" id="badge-findings" hidden></span></a>
    <a class="tab" id="tab-proposals" href="#proposals">Proposals <span class="badge" id="badge-proposals" hidden></span></a>
    <a class="tab" id="tab-changes" href="#changes">Changes</a>
    <a class="tab" id="tab-analytics" href="#analytics">Analytics</a>
  </nav>

  <section class="panel-tab" id="panel-overview" aria-label="Overview">
    <div id="lastrun" class="muted" style="font-size:12px;margin-top:14px"></div>
    <div class="cards" id="cards"></div>
  </section>

  <section class="panel-tab" id="panel-findings" aria-label="Findings" hidden>
    <div id="findings"></div>
  </section>

  <section class="panel-tab" id="panel-proposals" aria-label="Proposals" hidden>
    <div id="proposals"></div>
    <details style="margin-top:16px">
      <summary>Draft a description (dry run)</summary>
      <div class="item" style="margin-top:10px">
        <div class="row">
          <input id="drpath" placeholder="/articles/some-slug" style="flex:1"/>
          <button data-act="dryrun">Draft</button>
        </div>
        <div id="drout"></div>
      </div>
    </details>
  </section>

  <section class="panel-tab" id="panel-changes" aria-label="Changes" hidden>
    <div id="changes"></div>
  </section>

  <section class="panel-tab" id="panel-analytics" aria-label="Analytics" hidden>
    <div id="analytics"></div>
  </section>
</div>

<div id="toast" class="toast"></div>

<script>
(function () {
  var KEY = 'seo_agent_token';
  var token = localStorage.getItem(KEY) || '';

  // In-memory model of the core payloads, so tab switches and post-action badge
  // updates never have to refetch. analyticsData is the deferred /analytics
  // payload, cached for the session (nulled after a mutation that invalidates it).
  var state = { status: null, proposals: [], findings: [], changes: [], dismissed: [] };
  var analyticsData = null;
  var analyticsPending = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = el('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { showLogin('Token rejected.'); throw new Error('unauthorized'); }
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function showLogin(msg) {
    el('app').style.display = 'none';
    el('login').style.display = '';
    el('loginerr').textContent = msg || '';
  }
  function doLogin() {
    token = el('tok').value.trim();
    if (!token) return;
    localStorage.setItem(KEY, token);
    el('login').style.display = 'none';
    el('app').style.display = '';
    boot();
  }
  function logout() { localStorage.removeItem(KEY); token = ''; analyticsData = null; showLogin(''); }

  function num(x) { return x == null ? '0' : String(x); }

  // --- Tab machinery -------------------------------------------------------
  // The URL hash is the single source of truth for which tab is shown. It is
  // resolved ONLY through this fixed whitelist — never interpolated into HTML
  // or a selector — so a crafted #… can't inject anything. Unknown/missing
  // hash falls back to overview.
  var TAB_KEYS = { overview: 1, findings: 1, proposals: 1, changes: 1, analytics: 1 };
  var TAB_ORDER = ['overview', 'findings', 'proposals', 'changes', 'analytics'];
  var currentTab = 'overview';

  function resolveHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    // hasOwnProperty, not TAB_KEYS[raw], so inherited keys (#__proto__,
    // #constructor, …) can't slip through the whitelist as truthy.
    return Object.prototype.hasOwnProperty.call(TAB_KEYS, raw) ? raw : 'overview';
  }
  function activateTab(key) {
    currentTab = key;
    TAB_ORDER.forEach(function (k) {
      var active = k === key;
      var panel = el('panel-' + k), tab = el('tab-' + k);
      if (panel) panel.hidden = !active;
      if (tab) {
        tab.classList.toggle('active', active);
        if (active) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
    });
    // Analytics and Changes both consume the deferred /analytics payload
    // (charts, and the per-change verdict chip respectively); load it on first
    // need and cache it.
    if (key === 'analytics' || key === 'changes') ensureAnalytics();
  }
  function onHashChange() { activateTab(resolveHash()); }

  function setBadge(id, n) {
    var b = el(id);
    if (!b) return;
    if (n > 0) { b.textContent = String(n); b.hidden = false; }
    else { b.textContent = ''; b.hidden = true; }
  }
  function updateBadges() {
    setBadge('badge-findings', (state.findings || []).length);
    setBadge('badge-proposals', (state.proposals || []).length);
  }

  function renderCards(s) {
    var open = 0;
    (s.openFindingsBySeverity || []).forEach(function (r) { open += r.n; });
    var pending = 0, applied = (s.changes && s.changes.applied) || 0;
    (s.proposalsByStatus || []).forEach(function (r) { if (r.status === 'proposed') pending = r.n; });
    var gsc = s.gsc || {};
    var aeo = s.aeo || {}, tel = aeo.telemetry || {}, cit = aeo.citations || {};
    var crawls = 0;
    (tel.crawler7d || []).forEach(function (r) { crawls += r.n; });
    // [label, value, target-tab hash] — every card deep-links into its tab.
    var cards = [
      ['Pending', pending, '#proposals'],
      ['Open findings', open, '#findings'],
      ['Applied', applied, '#changes'],
      ['GSC rows', num(gsc.n) + (gsc.latest ? ' · to ' + gsc.latest : ''), '#analytics'],
      ['AI crawls 7d', tel.active ? crawls : '—', '#analytics'],
      ['AI referrals 7d', tel.active ? num(tel.referral7d) : '—', '#analytics'],
      ['Cited', cit.total ? (num(cit.cited) + '/' + num(cit.total)) : ((cit.queries && (cit.engines || []).length) ? 'pending' : 'off'), '#analytics']
    ];
    el('cards').innerHTML = cards.map(function (c) {
      // c[2] is a hardcoded literal hash, not user input.
      return '<a class="card" href="' + c[2] + '"><div class="n">' + esc(c[1]) + '</div><div class="l">' + esc(c[0]) + '</div></a>';
    }).join('');
    var lr = s.lastRun || {};
    el('lastrun').textContent = lr.started_at
      ? ('Last run #' + lr.id + ' · ' + new Date(lr.started_at).toLocaleString() + ' · ' + num(lr.url_count) + ' URLs')
      : 'No runs yet.';
    el('site').textContent = (s.config && s.config.model) ? ('model ' + s.config.model) : '';
  }

  function proposalCard(p) {
    var cur = p.current_value ? '<div class="val cur">' + esc(p.current_value) + '</div>' : '';
    return '<div class="item" data-id="' + p.id + '">'
      + '<div class="path">' + esc(p.path) + ' <span class="chip">' + esc(p.field) + '</span></div>'
      + '<div class="meta">#' + p.id + ' · ' + esc(p.rationale || '') + ' · ' + esc(p.model || '') + '</div>'
      + cur
      + '<div class="val new">' + esc(p.proposed_value) + '</div>'
      + '<div class="row">'
      + '<button class="ok small" data-act="approve" data-id="' + p.id + '">Approve</button>'
      + '<button class="bad small" data-act="reject" data-id="' + p.id + '">Reject</button>'
      + '<span class="muted" style="font-size:12px">' + esc((p.proposed_value || '').length) + ' chars</span>'
      + '</div></div>';
  }

  function renderProposals(list) {
    el('proposals').innerHTML = list.length
      ? list.map(proposalCard).join('')
      : '<div class="empty">No proposals awaiting review. The daily run drafts up to a few at a time.</div>';
  }

  // Remediation cell: a live queue-state hint per finding. Only the two active
  // states render (a link to the pending proposal, or an "applied" chip);
  // rejected / none show nothing, so the column stays quiet on the common case.
  function remedCell(f) {
    var r = f.remediation;
    if (!r) return '';
    if (r.state === 'proposal_pending') return '<a href="#proposals" class="nw">proposal pending</a>';
    if (r.state === 'applied_awaiting_recrawl') return '<span class="chip applied" title="Fix applied — confirming on the next crawl">applied</span>';
    return '';
  }
  function renderFindings(open, dismissed) {
    open = open || []; dismissed = dismissed || [];
    var html = '';
    if (!open.length) {
      html += '<div class="empty">None — all clear.</div>';
    } else {
      var rows = open.map(function (f) {
        var draft = f.draftable ? '<button class="small" data-act="draft" data-id="' + f.id + '">Draft fix</button> ' : '';
        return '<tr data-fid="' + f.id + '"><td><span class="chip ' + esc(f.severity) + '">' + esc(f.severity) + '</span></td>'
          + '<td>' + esc(f.rule) + '</td><td>' + esc(f.path) + '</td>'
          + '<td class="muted">' + esc((f.detail || '').slice(0, 120)) + '</td>'
          + '<td>' + remedCell(f) + '</td>'
          + '<td style="white-space:nowrap;text-align:right">' + draft
          + '<button class="small bad" data-act="dismiss" data-id="' + f.id + '">Dismiss</button></td></tr>';
      }).join('');
      html += '<div class="tablewrap"><table><thead><tr><th>Sev</th><th>Rule</th><th>Path</th><th>Detail</th><th>Remediation</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    if (dismissed.length) {
      var drows = dismissed.map(function (f) {
        return '<tr data-fid="' + f.id + '"><td><span class="chip ' + esc(f.severity) + '">' + esc(f.severity) + '</span></td>'
          + '<td>' + esc(f.rule) + '</td><td>' + esc(f.path) + '</td>'
          + '<td class="muted">' + esc((f.detail || '').slice(0, 120)) + '</td>'
          + '<td style="text-align:right"><button class="small" data-act="restore" data-id="' + f.id + '">Restore</button></td></tr>';
      }).join('');
      html += '<details style="margin-top:16px"><summary>Dismissed (' + dismissed.length + ')</summary>'
        + '<div class="tablewrap"><table><thead><tr><th>Sev</th><th>Rule</th><th>Path</th><th>Detail</th><th></th></tr></thead><tbody>' + drows + '</tbody></table></div></details>';
    }
    el('findings').innerHTML = html;
  }

  // Verdicts live only in the /analytics payload, so the Changes table sources
  // its rows from /changes (always loaded) and looks the verdict up by change
  // id from the cached analytics — showing "pending" until analytics lands, then
  // re-rendered by backfillVerdicts() once it does.
  function verdictById() {
    var m = {};
    ((analyticsData && analyticsData.changes) || []).forEach(function (c) { m[c.id] = c; });
    return m;
  }
  function renderChanges(list) {
    list = list || [];
    if (!list.length) { el('changes').innerHTML = '<div class="empty">No changes applied yet.</div>'; return; }
    var vm = verdictById();
    var rows = list.map(function (c) {
      var reverted = !!c.reverted_at;
      var vi = vm[c.id] || {};
      var v = vi.latestVerdict || 'pending';
      var label = (vi.latestPhase ? (vi.latestPhase + ' ') : '') + String(v).replace('_', ' ');
      var chip = '<span class="chip ' + esc(v) + '">' + esc(label) + '</span>';
      var action = reverted
        ? '<span class="muted">reverted</span>'
        : '<button class="bad small" data-act="revert" data-id="' + c.id + '">Revert</button>';
      return '<tr style="' + (reverted ? 'opacity:.55' : '') + '"><td>' + c.id + '</td>'
        + '<td>' + esc(c.path) + '</td><td>' + esc(c.field) + '</td>'
        + '<td>' + esc((c.new_value || '').slice(0, 90)) + '</td>'
        + '<td class="muted">' + esc(c.source) + '</td>'
        + '<td class="muted">' + esc((c.applied_at || '').slice(0, 10)) + '</td>'
        + '<td>' + chip + '</td><td>' + action + '</td></tr>';
    }).join('');
    el('changes').innerHTML = '<div class="tablewrap"><table><thead><tr><th>#</th><th>Path</th><th>Field</th><th>New value</th><th>Src</th><th>Applied</th><th>Verdict</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function backfillVerdicts() { renderChanges(state.changes); }

  function decide(id, action) {
    var b = document.querySelector('.item[data-id="' + id + '"]');
    if (b) Array.prototype.forEach.call(b.querySelectorAll('button'), function (x) { x.disabled = true; });
    api('/proposals/' + id + '/' + action, { method: 'POST' }).then(function () {
      toast('Proposal #' + id + ' ' + action + (action === 'approve' ? 'd — live in ~5 min' : 'ed'));
      // Optimistic: drop it from the pending list and refresh the badge now,
      // then reconcile against the server. An approve also mints a change, so
      // the cached analytics (verdict source) is stale — invalidate it.
      state.proposals = (state.proposals || []).filter(function (p) { return p.id !== id; });
      renderProposals(state.proposals); updateBadges();
      analyticsData = null;
      load();
    }).catch(function (e) { toast(e.message); load(); });
  }
  function revert(id) {
    api('/changes/' + id + '/revert', { method: 'POST' }).then(function () {
      toast('Change #' + id + ' reverted');
      state.changes = (state.changes || []).map(function (c) {
        return c.id === id ? Object.assign({}, c, { reverted_at: new Date().toISOString() }) : c;
      });
      renderChanges(state.changes);
      analyticsData = null;
      load();
    }).catch(function (e) { toast(e.message); });
  }
  // Disable a finding row's buttons while its action is in flight.
  function lockRow(id) {
    var tr = document.querySelector('tr[data-fid="' + id + '"]');
    if (tr) Array.prototype.forEach.call(tr.querySelectorAll('button'), function (x) { x.disabled = true; });
  }
  function dismiss(id) {
    lockRow(id);
    api('/findings/' + id + '/dismiss', { method: 'POST' }).then(function () {
      toast('Finding #' + id + ' dismissed');
      // Optimistic: move it out of the open list into the dismissed list, drop
      // the badge, and refresh. A dismissal also closes an open-findings series
      // row, so the cached analytics is stale — invalidate it.
      var moved = null;
      state.findings = (state.findings || []).filter(function (f) { if (f.id === id) { moved = f; return false; } return true; });
      if (moved) state.dismissed = [moved].concat(state.dismissed || []);
      renderFindings(state.findings, state.dismissed); updateBadges();
      analyticsData = null;
      load();
    }).catch(function (e) { toast(e.message); load(); });
  }
  function restore(id) {
    lockRow(id);
    api('/findings/' + id + '/restore', { method: 'POST' }).then(function () {
      // Restore lifts the mute but does NOT re-open — the next crawl does, if the
      // condition still holds. So the row just leaves the Dismissed list here.
      toast('Finding #' + id + ' restored — re-opens next crawl if still present');
      state.dismissed = (state.dismissed || []).filter(function (f) { return f.id !== id; });
      renderFindings(state.findings, state.dismissed);
      analyticsData = null;
      load();
    }).catch(function (e) { toast(e.message); load(); });
  }
  function draftFix(id) {
    lockRow(id);
    api('/findings/' + id + '/draft', { method: 'POST' }).then(function (r) {
      toast(r.enqueued ? 'Draft queued — proposal appears shortly' : (r.note || 'Already drafted'));
      // The queue consumer creates the proposal over the next ~1–2 min; refresh
      // a couple of times so it surfaces (and the row's remediation updates).
      load();
      setTimeout(load, 15000);
      setTimeout(load, 35000);
    }).catch(function (e) { toast(e.message); load(); });
  }
  function resetRunBtn() { var b = el('runbtn'); b.disabled = false; b.textContent = 'Run pipeline'; }
  function runPipeline() {
    var b = el('runbtn'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Running';
    // /run fires the pipeline in the background and returns immediately; poll
    // /status until nothing is running and the latest run is fully done.
    api('/run', { method: 'POST' }).then(function (r) {
      toast(r.started ? 'Run started…' : 'A run is already in progress…');
      pollRun(0);
    }).catch(function (e) { resetRunBtn(); toast(e.message); });
  }
  function pollRun(tries) {
    if (tries > 80) { resetRunBtn(); toast('Still running — refreshing.'); load(); return; }
    setTimeout(function () {
      api('/status').then(function (s) {
        if (!s.running && s.lastRun && s.lastRun.pipeline_done) {
          resetRunBtn();
          toast('Run #' + s.lastRun.id + ' complete — drafting proposals…');
          // Drafts are produced asynchronously by the queue after the run
          // finishes; refresh a few times to surface them as they land.
          load();
          setTimeout(load, 8000);
          setTimeout(load, 20000);
          setTimeout(load, 35000);
        } else {
          pollRun(tries + 1);
        }
      }).catch(function () { pollRun(tries + 1); });
    }, 3000);
  }
  var lastDraft = null;
  function dryRun() {
    var path = el('drpath').value.trim(); if (!path) return;
    el('drout').innerHTML = '<div class="muted" style="margin-top:8px"><span class="spin"></span> Drafting…</div>';
    api('/proposals/dry-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path }) })
      .then(function (r) {
        if (!r.value) { lastDraft = null; el('drout').innerHTML = '<div class="empty">No valid draft (all attempts failed validation).</div>'; return; }
        lastDraft = { path: path, value: r.value };
        el('drout').innerHTML = '<div class="val new">' + esc(r.value) + '</div>'
          + '<div class="row"><button class="ok small" data-act="promote">Create proposal</button>'
          + '<button class="small" data-act="dryrun">Try again</button>'
          + '<span class="muted" style="font-size:12px">' + r.value.length + ' chars · not saved yet</span></div>';
      }).catch(function (e) { el('drout').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function promote() {
    if (!lastDraft) return;
    api('/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: lastDraft.path, value: lastDraft.value, rationale: 'dashboard dry-run' }) })
      .then(function (r) { toast('Proposal #' + r.id + ' created'); lastDraft = null; load(); })
      .catch(function (e) { toast(e.message); });
  }

  // One delegated click handler — no inline onclick anywhere (cleaner + CSP-friendly).
  // Tab / card navigation is plain <a href="#…">, handled by the browser + the
  // hashchange listener, so it needs nothing here.
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (act === 'login') doLogin();
    else if (act === 'logout') logout();
    else if (act === 'run') runPipeline();
    else if (act === 'dryrun') dryRun();
    else if (act === 'promote') promote();
    else if (act === 'approve') decide(Number(id), 'approve');
    else if (act === 'reject') decide(Number(id), 'reject');
    else if (act === 'revert') revert(Number(id));
    else if (act === 'dismiss') dismiss(Number(id));
    else if (act === 'restore') restore(Number(id));
    else if (act === 'draft') draftFix(Number(id));
  });
  el('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  window.addEventListener('hashchange', onHashChange);

  // --- Analytics section: client-side inline-SVG charts over /analytics/summary.
  // Kept dependency-free and template-literal-free like the rest of this script.
  // Doubled backslashes: this whole script is emitted from a TS template
  // literal, which consumes one level of escaping — singles would strip.
  function dnum(x) { return String(Math.round(x == null ? 0 : x)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function panel(title, inner) { return '<div class="panel"><h3>' + esc(title) + '</h3>' + inner + '</div>'; }

  function buildGsc(g, changes) {
    var daily = (g && g.daily) || [];
    if (!daily.length) return panel('Search clicks & impressions (90d)', '<div class="empty">No GSC data yet.</div>');
    var W = 860, H = 210, PL = 46, PR = 46, PT = 16, PB = 24;
    var first = daily[0].date, last = daily[daily.length - 1].date;
    var span = Math.max(1, dayDiff(first, last));
    var maxC = 1, maxI = 1;
    daily.forEach(function (d) { maxC = Math.max(maxC, d.clicks); maxI = Math.max(maxI, d.impressions); });
    function X(date) { return PL + (dayDiff(first, date) / span) * (W - PL - PR); }
    function YC(v) { return PT + (1 - v / maxC) * (H - PT - PB); }
    function YI(v) { return PT + (1 - v / maxI) * (H - PT - PB); }
    var clicksPts = daily.map(function (d) { return X(d.date).toFixed(1) + ',' + YC(d.clicks).toFixed(1); }).join(' ');
    var imprPts = daily.map(function (d) { return X(d.date).toFixed(1) + ',' + YI(d.impressions).toFixed(1); }).join(' ');
    var ticks = (changes || []).map(function (c) {
      var dt = (c.applied_at || '').slice(0, 10);
      if (dt < first || dt > last) return '';
      var x = X(dt).toFixed(1);
      return '<line x1="' + x + '" y1="' + PT + '" x2="' + x + '" y2="' + (H - PB) + '" style="stroke:var(--muted)" stroke-dasharray="2 2" opacity="0.5"><title>change #' + c.id + ' ' + esc(c.field) + ' ' + dt + '</title></line>';
    }).join('');
    var w = (W - PL - PR) / Math.max(1, daily.length);
    var hovers = daily.map(function (d) {
      return '<rect x="' + (X(d.date) - w / 2).toFixed(1) + '" y="' + PT + '" width="' + w.toFixed(1) + '" height="' + (H - PT - PB) + '" fill="transparent"><title>' + d.date + ' — ' + dnum(d.clicks) + ' clicks, ' + dnum(d.impressions) + ' impressions, CTR ' + (d.ctr * 100).toFixed(1) + '%, pos ' + d.position.toFixed(1) + '</title></rect>';
    }).join('');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">'
      + '<text x="' + PL + '" y="11" style="fill:var(--accent)" font-size="10">clicks (L)</text>'
      + '<text x="' + (W - PR) + '" y="11" text-anchor="end" style="fill:var(--warn)" font-size="10">impressions (R)</text>'
      + ticks
      + '<polyline points="' + imprPts + '" fill="none" style="stroke:var(--warn)" stroke-width="1.5"/>'
      + '<polyline points="' + clicksPts + '" fill="none" style="stroke:var(--accent)" stroke-width="1.5"/>'
      + '<text x="2" y="' + (PT + 4) + '" style="fill:var(--muted)" font-size="9">' + dnum(maxC) + '</text>'
      + '<text x="' + (W - 2) + '" y="' + (PT + 4) + '" text-anchor="end" style="fill:var(--muted)" font-size="9">' + dnum(maxI) + '</text>'
      + '<text x="' + PL + '" y="' + (H - 2) + '" style="fill:var(--muted)" font-size="9">' + first + '</text>'
      + '<text x="' + (W - PR) + '" y="' + (H - 2) + '" text-anchor="end" style="fill:var(--muted)" font-size="9">' + last + '</text>'
      + hovers + '</svg>';
    return panel('Search clicks & impressions (90d)', '<div class="svgwrap">' + svg + '</div>');
  }

  function buildAeo(a) {
    var daily = (a && a.daily) || [], bots = (a && a.topBots7d) || [];
    if (!daily.length && !bots.length) return panel('AI traffic (30d)', '<div class="empty">No AI-traffic telemetry yet.</div>');
    var inner = '';
    if (daily.length) {
      var W = 860, H = 170, PL = 30, PR = 10, PT = 12, PB = 22;
      var max = 1;
      daily.forEach(function (d) { max = Math.max(max, (d.crawler || 0) + (d.referral || 0) + (d.agent || 0)); });
      var bw = (W - PL - PR) / daily.length;
      var bars = daily.map(function (d, i) {
        var x = PL + i * bw, y = H - PB, out = '';
        [['crawler', d.crawler || 0, 'var(--accent)'], ['referral', d.referral || 0, 'var(--ok)'], ['agent', d.agent || 0, 'var(--warn)']].forEach(function (s) {
          var h = (s[1] / max) * (H - PT - PB); y -= h;
          if (h > 0) out += '<rect x="' + (x + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" style="fill:' + s[2] + '"/>';
        });
        out += '<rect x="' + x.toFixed(1) + '" y="' + PT + '" width="' + bw.toFixed(1) + '" height="' + (H - PT - PB) + '" fill="transparent"><title>' + d.date + ' — ' + (d.crawler || 0) + ' crawler, ' + (d.referral || 0) + ' referral, ' + (d.agent || 0) + ' agent</title></rect>';
        return out;
      }).join('');
      inner += '<div class="svgwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">'
        + '<text x="2" y="' + (PT + 8) + '" style="fill:var(--muted)" font-size="9">' + max + '</text>'
        + '<text x="' + PL + '" y="' + (H - 2) + '" style="fill:var(--muted)" font-size="9">' + daily[0].date + '</text>'
        + '<text x="' + (W - PR) + '" y="' + (H - 2) + '" text-anchor="end" style="fill:var(--muted)" font-size="9">' + daily[daily.length - 1].date + '</text>'
        + bars + '</svg></div>'
        + '<div class="legend"><span><i style="background:var(--accent)"></i>crawler</span><span><i style="background:var(--ok)"></i>referral</span><span><i style="background:var(--warn)"></i>agent</span></div>';
    }
    if (bots.length) {
      inner += '<div class="muted" style="font-size:12px;margin-top:8px">Top AI bots (7d): '
        + bots.map(function (b) { return esc(b.bot) + ' (' + b.hits + ')'; }).join(', ') + '</div>';
    }
    return panel('AI traffic (30d)', inner);
  }

  function buildCitations(c) {
    var series = (c && c.series) || [];
    if (!series.length) return panel('Citations', '<div class="empty">' + ((c && c.active) ? 'Configured — no probes recorded yet (they run weekly).' : 'Citation probes not configured.') + '</div>');
    var dates = [], seen = {};
    series.forEach(function (r) { var d = (r.checked_at || '').slice(0, 10); if (!seen[d]) { seen[d] = 1; dates.push(d); } });
    dates.sort();
    var keys = [], kseen = {}, cell = {};
    series.forEach(function (r) {
      var k = r.engine + ' · ' + r.query;
      if (!kseen[k]) { kseen[k] = 1; keys.push(k); }
      cell[k + '|' + (r.checked_at || '').slice(0, 10)] = r;
    });
    var rowsHtml = keys.map(function (k) {
      var cells = dates.map(function (d) {
        var r = cell[k + '|' + d];
        if (!r) return '<span class="cit-cell" title="' + esc(k) + ' ' + d + ': no probe"></span>';
        var cited = r.cited == 1 || r.cited === true;
        var t = esc(k) + ' ' + d + ': ' + (cited ? ('cited (rank ' + (r.rank || '?') + ')') : 'not cited');
        return '<span class="cit-cell"' + (cited ? ' style="background:var(--ok)"' : '') + ' title="' + t + '"></span>';
      }).join('');
      return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px"><span class="muted" style="font-size:11px;min-width:210px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(k) + '">' + esc(k) + '</span><span style="display:grid;grid-auto-flow:column;grid-auto-columns:minmax(6px,1fr);gap:2px;flex:1">' + cells + '</span></div>';
    }).join('');
    return panel('Citations (' + dates.length + ' checks)', '<div class="svgwrap">' + rowsHtml + '</div>');
  }

  function buildFindings(f) {
    var s = (f && f.series) || [];
    var any = s.some(function (d) { return d.total > 0; });
    if (!s.length || !any) return panel('Open findings over time (90d)', '<div class="empty">No open findings in the window.</div>');
    var W = 860, H = 150, PL = 30, PR = 10, PT = 12, PB = 22;
    var max = 1; s.forEach(function (d) { max = Math.max(max, d.total); });
    var span = Math.max(1, s.length - 1);
    function X(i) { return PL + (i / span) * (W - PL - PR); }
    function Y(v) { return PT + (1 - v / max) * (H - PT - PB); }
    var line = s.map(function (d, i) { return X(i).toFixed(1) + ',' + Y(d.total).toFixed(1); }).join(' ');
    var area = PL + ',' + (H - PB) + ' ' + line + ' ' + (W - PR) + ',' + (H - PB);
    var w = (W - PL - PR) / Math.max(1, s.length);
    var hovers = s.map(function (d, i) {
      var br = [];
      ['critical', 'high', 'medium', 'low', 'info'].forEach(function (sev) { var n = (d.counts && d.counts[sev]) || 0; if (n) br.push(n + ' ' + sev); });
      return '<rect x="' + (X(i) - w / 2).toFixed(1) + '" y="' + PT + '" width="' + w.toFixed(1) + '" height="' + (H - PT - PB) + '" fill="transparent"><title>' + d.date + ' — ' + d.total + ' open' + (br.length ? (' (' + br.join(', ') + ')') : '') + '</title></rect>';
    }).join('');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">'
      + '<polygon points="' + area + '" style="fill:var(--warn)" opacity="0.15"/>'
      + '<polyline points="' + line + '" fill="none" style="stroke:var(--warn)" stroke-width="1.5"/>'
      + '<text x="2" y="' + (PT + 8) + '" style="fill:var(--muted)" font-size="9">' + max + '</text>'
      + '<text x="' + PL + '" y="' + (H - 2) + '" style="fill:var(--muted)" font-size="9">' + s[0].date + '</text>'
      + '<text x="' + (W - PR) + '" y="' + (H - 2) + '" text-anchor="end" style="fill:var(--muted)" font-size="9">' + s[s.length - 1].date + '</text>'
      + hovers + '</svg>';
    return panel('Open findings over time (90d)', '<div class="svgwrap">' + svg + '</div>');
  }

  function renderAnalytics(data) {
    data = data || {};
    var html = '';
    // GSC panel is hidden entirely where GSC is off (e.g. the eo instance).
    if (data.gsc && data.gsc.active) html += buildGsc(data.gsc, data.changes);
    html += buildAeo(data.aeo);
    html += buildCitations(data.citations);
    html += buildFindings(data.findings);
    el('analytics').innerHTML = html;
  }

  // Deferred + session-cached /analytics/summary loader. Fetched on first open
  // of the Analytics or Changes tab; a mutating action nulls analyticsData to
  // force a refresh on next open.
  function ensureAnalytics() {
    if (analyticsData) { renderAnalytics(analyticsData); backfillVerdicts(); return; }
    if (analyticsPending) return;
    analyticsPending = true;
    el('analytics').innerHTML = '<div class="muted" style="padding:8px 2px"><span class="spin"></span> Loading analytics…</div>';
    api('/analytics/summary').then(function (d) {
      analyticsData = d || {};
      analyticsPending = false;
      renderAnalytics(analyticsData);
      backfillVerdicts();
    }).catch(function (e) {
      analyticsPending = false;
      if (e.message !== 'unauthorized') el('analytics').innerHTML = '<div class="empty">Analytics unavailable right now.</div>';
    });
  }

  // Core load — everything EXCEPT the deferred /analytics payload. Re-run after
  // actions and after a pipeline run; tab switches never call it.
  function load() {
    Promise.all([
      api('/status'), api('/proposals?status=proposed'), api('/findings?status=open'), api('/changes'), api('/findings?status=dismissed')
    ]).then(function (res) {
      state.status = res[0]; state.proposals = res[1]; state.findings = res[2]; state.changes = res[3]; state.dismissed = res[4];
      renderCards(res[0]);
      renderProposals(res[1]);
      renderFindings(res[2], res[4]);
      renderChanges(res[3]);
      updateBadges();
      // If the user is already on a tab that needs analytics, (re)load it —
      // e.g. after an action invalidated the cache.
      if (currentTab === 'analytics' || currentTab === 'changes') ensureAnalytics();
    }).catch(function (e) { if (e.message !== 'unauthorized') toast(e.message); });
  }

  function boot() {
    activateTab(resolveHash());
    load();
  }

  if (!token) showLogin('');
  else { el('login').style.display = 'none'; el('app').style.display = ''; boot(); }
})();
</script>
</body>
</html>`;
