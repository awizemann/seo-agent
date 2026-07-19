/**
 * Human review dashboard — a single self-contained page served by the agent
 * Worker itself. Zero dependencies, zero build step: inline CSS + vanilla JS.
 *
 * Served UNAUTHENTICATED at GET / and GET /dashboard (it contains no secrets —
 * just a login form and client code). The visitor pastes the AGENT_TOKEN once;
 * it is kept in localStorage and sent as `Authorization: Bearer …` on every API
 * call, which is where the real auth lives. Same token as the REST/MCP surface.
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
  .chip { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); }
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
  .chip.insufficient_data, .chip.pending { color: var(--muted); background: transparent; border: 1px solid var(--line); }
  .chip.insufficient_data { border-style: dashed; }
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
  <div id="lastrun" class="muted" style="font-size:12px"></div>

  <div class="cards" id="cards"></div>

  <section id="analyticsSection">
    <h2>Analytics</h2>
    <div id="analytics"></div>
  </section>

  <section>
    <h2>Pending proposals</h2>
    <div id="proposals"></div>
  </section>

  <section>
    <details>
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

  <section>
    <details>
      <summary id="findsum">Open findings</summary>
      <div id="findings"></div>
    </details>
  </section>

  <section>
    <details>
      <summary id="chgsum">Applied changes</summary>
      <div id="changes"></div>
    </details>
  </section>
</div>

<div id="toast" class="toast"></div>

<script>
(function () {
  var KEY = 'seo_agent_token';
  var token = localStorage.getItem(KEY) || '';

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
    load();
  }
  function logout() { localStorage.removeItem(KEY); token = ''; showLogin(''); }

  function num(x) { return x == null ? '0' : String(x); }

  function renderCards(s) {
    var open = 0;
    (s.openFindingsBySeverity || []).forEach(function (r) { open += r.n; });
    var pending = 0, applied = (s.changes && s.changes.applied) || 0;
    (s.proposalsByStatus || []).forEach(function (r) { if (r.status === 'proposed') pending = r.n; });
    var gsc = s.gsc || {};
    var aeo = s.aeo || {}, tel = aeo.telemetry || {}, cit = aeo.citations || {};
    var crawls = 0;
    (tel.crawler7d || []).forEach(function (r) { crawls += r.n; });
    var cards = [
      ['Pending', pending], ['Open findings', open], ['Applied', applied],
      ['GSC rows', num(gsc.n) + (gsc.latest ? ' · to ' + gsc.latest : '')],
      ['AI crawls 7d', tel.active ? crawls : '—'],
      ['AI referrals 7d', tel.active ? num(tel.referral7d) : '—'],
      ['Cited', cit.total ? (num(cit.cited) + '/' + num(cit.total)) : ((cit.queries && (cit.engines || []).length) ? 'pending' : 'off')]
    ];
    el('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="n">' + esc(c[1]) + '</div><div class="l">' + esc(c[0]) + '</div></div>';
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

  function renderFindings(list) {
    el('findsum').textContent = 'Open findings (' + list.length + ')';
    if (!list.length) { el('findings').innerHTML = '<div class="empty">None — all clear.</div>'; return; }
    var rows = list.map(function (f) {
      return '<tr><td><span class="chip ' + esc(f.severity) + '">' + esc(f.severity) + '</span></td>'
        + '<td>' + esc(f.rule) + '</td><td>' + esc(f.path) + '</td>'
        + '<td class="muted">' + esc((f.detail || '').slice(0, 120)) + '</td></tr>';
    }).join('');
    el('findings').innerHTML = '<table><thead><tr><th>Sev</th><th>Rule</th><th>Path</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderChanges(list) {
    el('chgsum').textContent = 'Applied changes (' + list.filter(function (c) { return !c.reverted_at; }).length + ' live)';
    if (!list.length) { el('changes').innerHTML = '<div class="empty">No changes applied yet.</div>'; return; }
    var rows = list.map(function (c) {
      var reverted = !!c.reverted_at;
      var action = reverted
        ? '<span class="muted">reverted</span>'
        : '<button class="bad small" data-act="revert" data-id="' + c.id + '">Revert</button>';
      return '<tr style="' + (reverted ? 'opacity:.55' : '') + '"><td>' + c.id + '</td>'
        + '<td>' + esc(c.path) + '</td><td>' + esc(c.field) + '</td>'
        + '<td>' + esc((c.new_value || '').slice(0, 90)) + '</td>'
        + '<td class="muted">' + esc(c.source) + '</td><td>' + action + '</td></tr>';
    }).join('');
    el('changes').innerHTML = '<table><thead><tr><th>#</th><th>Path</th><th>Field</th><th>New value</th><th>Src</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function decide(id, action) {
    var b = document.querySelector('.item[data-id="' + id + '"]');
    if (b) Array.prototype.forEach.call(b.querySelectorAll('button'), function (x) { x.disabled = true; });
    api('/proposals/' + id + '/' + action, { method: 'POST' }).then(function () {
      toast('Proposal #' + id + ' ' + action + (action === 'approve' ? 'd — live in ~5 min' : 'ed'));
      load();
    }).catch(function (e) { toast(e.message); load(); });
  }
  function revert(id) {
    api('/changes/' + id + '/revert', { method: 'POST' }).then(function () {
      toast('Change #' + id + ' reverted'); load();
    }).catch(function (e) { toast(e.message); });
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
  });
  el('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  // --- Analytics section: client-side inline-SVG charts over /analytics/summary.
  // Kept dependency-free and template-literal-free like the rest of this script.
  function dnum(x) { return String(Math.round(x == null ? 0 : x)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
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

  function buildChangesTable(list) {
    if (!list || !list.length) return panel('Changes & impact', '<div class="empty">No changes applied yet.</div>');
    var rows = list.map(function (c) {
      var v = c.latestVerdict || 'pending';
      var label = (c.latestPhase ? (c.latestPhase + ' ') : '') + String(v).replace('_', ' ');
      var chip = '<span class="chip ' + esc(v) + '">' + esc(label) + '</span>';
      var action = c.reverted_at ? '<span class="muted">reverted</span>' : '<button class="bad small" data-act="revert" data-id="' + c.id + '">Revert</button>';
      return '<tr style="' + (c.reverted_at ? 'opacity:.55' : '') + '"><td>' + c.id + '</td><td>' + esc(c.path) + '</td><td>' + esc(c.field) + '</td><td class="muted">' + esc((c.applied_at || '').slice(0, 10)) + '</td><td>' + chip + '</td><td>' + action + '</td></tr>';
    }).join('');
    return panel('Changes & impact', '<table><thead><tr><th>#</th><th>Path</th><th>Field</th><th>Applied</th><th>Verdict</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>');
  }

  function renderAnalytics(data) {
    data = data || {};
    var html = '';
    if (data.gsc && data.gsc.active) html += buildGsc(data.gsc, data.changes);
    html += buildAeo(data.aeo);
    html += buildCitations(data.citations);
    html += buildFindings(data.findings);
    html += buildChangesTable(data.changes);
    el('analytics').innerHTML = html;
  }

  function load() {
    Promise.all([
      api('/status'), api('/proposals?status=proposed'), api('/findings?status=open'), api('/changes'),
      api('/analytics/summary').catch(function () { return {}; })
    ]).then(function (res) {
      renderCards(res[0]); renderProposals(res[1]); renderFindings(res[2]); renderChanges(res[3]); renderAnalytics(res[4]);
    }).catch(function (e) { if (e.message !== 'unauthorized') toast(e.message); });
  }

  if (!token) showLogin('');
  else { el('login').style.display = 'none'; el('app').style.display = ''; load(); }
})();
</script>
</body>
</html>`;
