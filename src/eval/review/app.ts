// ---------------------------------------------------------------------------
// The review / audit page. One self-contained document: inline style and
// script under a per-response CSP nonce, no external assets, every piece of
// captured or engine data inserted with textContent (never as HTML).
// ---------------------------------------------------------------------------

export function renderApp(opts: { token: string; nonce: string; mode: "review" | "audit" }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="eval-token" content="${opts.token}">
<title>WCAG eval ${opts.mode}</title>
<style nonce="${opts.nonce}">${CSS}</style>
</head>
<body data-mode="${opts.mode}">
<header id="top"><strong>WCAG eval</strong> <span id="title"></span><span id="progress"></span><span id="timer" title="Active seconds on this item (pauses when hidden or idle over 120 s)"></span></header>
<main>
  <nav id="list" aria-label="Items"></nav>
  <section id="detail" aria-live="polite"><p class="muted">Loading…</p></section>
</main>
<div id="toast" role="status"></div>
<script nonce="${opts.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#deded8; --accent:#1f5f8b; --bad:#a3271b; --good:#2e6b30; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#171716; --fg:#ececea; --muted:#a3a39c; --line:#3a3a36; --accent:#7fb6dc; --bad:#f08a7e; --good:#8fd18f; --warn:#e6b85c; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header { display:flex; gap:16px; align-items:baseline; padding:8px 16px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; flex-wrap:wrap; }
#timer { margin-left:auto; font-variant-numeric: tabular-nums; color:var(--muted); }
main { display:grid; grid-template-columns: minmax(220px, 300px) 1fr; min-height: calc(100vh - 42px); }
nav { border-right:1px solid var(--line); overflow:auto; max-height: calc(100vh - 42px); padding:8px 0; }
nav h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:12px 12px 4px; }
nav button { display:block; width:100%; text-align:left; border:0; background:none; color:inherit; padding:4px 12px; font:inherit; cursor:pointer; }
nav button[aria-current="true"] { background:color-mix(in srgb, var(--accent) 15%, transparent); }
nav .v { float:right; font-size:12px; }
.v-violation { color:var(--bad); } .v-no_violation { color:var(--good); } .v-unsure { color:var(--warn); }
section { padding:16px 20px; overflow:auto; max-height: calc(100vh - 42px); }
.meta { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:4px 16px; margin-bottom:12px; }
.meta div span { color:var(--muted); display:block; font-size:12px; }
.reasoning { white-space:pre-wrap; border-left:3px solid var(--line); padding-left:10px; margin:8px 0 16px; }
figure { margin:0 0 12px; } figure img { max-width:100%; border:1px solid var(--line); } figcaption { font-size:12px; color:var(--muted); }
pre.html { white-space:pre-wrap; word-break:break-all; background:color-mix(in srgb, var(--fg) 5%, transparent); padding:10px; border-radius:4px; max-height:260px; overflow:auto; font-size:12px; }
pre.html .ctx { color:var(--muted); } pre.html mark { background:color-mix(in srgb, var(--warn) 30%, transparent); color:inherit; }
.actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:12px 0; position:sticky; bottom:0; background:var(--bg); padding:8px 0; border-top:1px solid var(--line); }
button.k { border:1px solid var(--line); background:none; color:inherit; padding:4px 10px; border-radius:4px; cursor:pointer; font:inherit; }
button.k kbd { font-weight:600; margin-right:4px; }
input, textarea, select { font:inherit; color:inherit; background:transparent; border:1px solid var(--line); border-radius:4px; padding:3px 6px; }
.muted { color:var(--muted); }
table { border-collapse:collapse; width:100%; } td, th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; font-size:13px; }
#toast { position:fixed; bottom:12px; right:12px; background:var(--fg); color:var(--bg); padding:6px 12px; border-radius:4px; opacity:0; transition:opacity .2s; }
#toast.on { opacity:.92; }
.sev { display:none; gap:6px; } .sev.on { display:inline-flex; }
label.block { display:block; }
form.grid { display:grid; grid-template-columns: 120px 1fr; gap:6px 10px; max-width:720px; }
@media (max-width: 700px) { main { grid-template-columns: 1fr; } nav { max-height: 30vh; border-right:0; border-bottom:1px solid var(--line); } }
`;

// Plain browser JS (no build step); keep it ES2019 and self-contained.
const SCRIPT = String.raw`
(function () {
  'use strict';
  var token = document.querySelector('meta[name="eval-token"]').content;
  var mode = document.body.dataset.mode;
  var state = null, current = null, items = [], sevPending = false;
  var active = 0, lastInput = Date.now(), timerItem = null;

  // --- active time: counts only while visible and not idle over 120 s ---
  ['keydown', 'mousemove', 'mousedown', 'scroll', 'wheel', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, function () { lastInput = Date.now(); }, { passive: true, capture: true });
  });
  setInterval(function () {
    if (timerItem === null) return;
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastInput > 120000) return;
    active += 1;
    document.getElementById('timer').textContent = active + ' s';
  }, 1000);
  function startTimer(id) { timerItem = id; active = 0; lastInput = Date.now(); document.getElementById('timer').textContent = '0 s'; }
  window.__evalActiveSeconds = function () { return active; };

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.className = 'on'; setTimeout(function () { t.className = ''; }, 1600); }
  function api(path, body) {
    var init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-eval-token': token }, body: JSON.stringify(body) };
    return fetch(path, init).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); });
  }
  function fail(e) { toast(e.message || String(e)); }

  // ======================= review =======================
  function loadState() {
    return api('/api/state').then(function (s) {
      state = s;
      if (s.mode === 'audit') return renderAudit();
      items = s.items;
      document.getElementById('title').textContent = 'run ' + s.run_id + ' · ' + s.batch + (s.criterion ? ' · ' + s.criterion : '');
      var done = items.filter(function (i) { return i.verdict; }).length;
      document.getElementById('progress').textContent = done + ' / ' + items.length + ' judged';
      renderList();
    });
  }
  function renderList() {
    var nav = document.getElementById('list'); nav.textContent = '';
    var last = null;
    items.forEach(function (i) {
      if (i.criterion !== last) { nav.appendChild(el('h3', { text: i.criterion })); last = i.criterion; }
      var b = el('button', { 'data-id': i.item_id, 'aria-current': current && current.item_id === i.item_id ? 'true' : 'false', on: { click: function () { show(i.item_id); } } },
        [i.site + '/' + i.page + ' · ' + (i.check || '?'), el('span', { 'class': 'v v-' + (i.verdict || 'none'), text: i.verdict ? i.verdict.replace('_', ' ') : '' })]);
      nav.appendChild(b);
    });
  }
  function show(id) {
    return api('/api/item/' + encodeURIComponent(id)).then(function (d) { current = d; sevPending = false; renderItem(); renderList(); startTimer(id); }).catch(fail);
  }
  function nextId() {
    if (!current) return items.length ? items[0].item_id : null;
    var idx = items.findIndex(function (i) { return i.item_id === current.item_id; });
    for (var k = idx + 1; k < items.length; k++) if (!items[k].verdict) return items[k].item_id;
    return idx + 1 < items.length ? items[idx + 1].item_id : null;
  }
  function renderItem() {
    var d = current, sec = document.getElementById('detail'); sec.textContent = '';
    var e = d.engine;
    sec.appendChild(el('h2', { text: d.criterion + ' · ' + d.site + '/' + d.page }));
    var meta = el('div', { 'class': 'meta' });
    [['Engine criterion', e.criterion], ['Check', e.check || 'unknown'], ['Tier', e.tier === null ? 'unknown' : String(e.tier)], ['Failure type', e.failure_type || '—'],
     ['Severity', e.severity], ['Confidence', e.confidence.tier + ' (' + e.confidence.score + ')'], ['State', e.state], ['Detected by', e.detected_by],
     ['Selector', e.selector], ['Model saw an image', e.model_image ? 'yes' : 'no'], ['Also found on', e.also_found_on.join(', ') || '—']].forEach(function (p) {
      meta.appendChild(el('div', null, [el('span', { text: p[0] }), p[1]]));
    });
    sec.appendChild(meta);
    sec.appendChild(el('div', { 'class': 'reasoning', 'data-testid': 'reasoning', text: e.reasoning || '(no reasoning recorded)' }));
    if (d.judge && state.judge_visible) sec.appendChild(el('p', { text: 'Judge: ' + d.judge }));
    d.assets.forEach(function (a) { sec.appendChild(el('figure', null, [el('img', { src: a.url, alt: a.label }), el('figcaption', { text: a.label })])); });
    var pre = el('pre', { 'class': 'html', 'data-testid': 'html' });
    pre.appendChild(el('span', { 'class': 'ctx', text: d.html_context.before }));
    pre.appendChild(el('mark', { text: d.html_context.element }));
    pre.appendChild(el('span', { 'class': 'ctx', text: d.html_context.after }));
    if (!d.html_context.found) sec.appendChild(el('p', { 'class': 'muted', text: 'Element HTML not found verbatim in the captured DOM; showing the engine\'s element only.' }));
    sec.appendChild(pre);
    var crit = el('input', { id: 'crit', value: d.criterion, size: '7', 'aria-label': 'Criterion for this judgment' });
    var sev = el('span', { 'class': 'sev', id: 'sev' }, ['critical', 'major', 'minor', 'advisory'].map(function (s, i) {
      return el('button', { 'class': 'k', on: { click: function () { judge('violation', s); } } }, [el('kbd', { text: String(i + 1) }), s]);
    }));
    var actions = el('div', { 'class': 'actions' }, [
      key('T', 'violation', function () { judge('violation'); }), key('F', 'no violation', function () { judge('no_violation'); }),
      key('S', 'severity…', function () { askSeverity(); }), key('U', 'unsure', function () { judge('unsure'); }),
      key('N', 'next', function () { goNext(); }), key('Z', 'undo', function () { undo(); }), sev,
      el('label', null, ['criterion ', crit]),
      el('button', { 'class': 'k', on: { click: openReplay } }, ['Open in replay']),
      el('button', { 'class': 'k', on: { click: toggleOutline } }, ['Toggle outline']),
      d.propagation.eligible ? el('button', { 'class': 'k', on: { click: propose } }, ['Propagate…']) : null,
    ]);
    sec.appendChild(actions);
    sec.appendChild(el('h3', { text: 'Ground truth so far' }));
    sec.appendChild(el('p', { 'data-testid': 'current', text: d.current ? 'Current: ' + d.current.verdict.replace('_', ' ') + (d.current.severity ? ' (severity ' + d.current.severity + ')' : '') + ' · ' + d.current.label_id : 'Not judged yet' }));
    var hist = el('ul', { 'data-testid': 'history' });
    d.history.forEach(function (h) { hist.appendChild(el('li', { text: h.label_id + ' ' + h.kind + (h.verdict ? ' ' + h.verdict : '') + (h.severity ? ' ' + h.severity : '') + ' · ' + h.reviewer + ' · ' + h.batch })); });
    sec.appendChild(hist);
    sec.appendChild(addCaseForm(d.site, d.page, null));
    var prop = el('div', { id: 'propagation' }); sec.appendChild(prop);
  }
  function key(k, label, fn) { return el('button', { 'class': 'k', 'data-key': k, on: { click: fn } }, [el('kbd', { text: k }), label]); }
  function askSeverity() { sevPending = true; document.getElementById('sev').className = 'sev on'; toast('Severity: 1 critical, 2 major, 3 minor, 4 advisory'); }
  function judge(verdict, severity) {
    if (!current) return;
    var criterion = document.getElementById('crit').value.trim();
    if (!/^\d\.\d\.\d{1,2}$/.test(criterion)) { toast('A criterion is required'); return; }
    api('/api/judge', { item_id: current.item_id, verdict: verdict, severity: severity || null, criterion: criterion, active_seconds: active })
      .then(function (r) { toast(verdict.replace('_', ' ') + ' · ' + r.label_id); return loadState(); })
      .then(function () { var n = nextId(); if (n) show(n); else show(current.item_id); }).catch(fail);
  }
  function goNext() { var n = nextId(); if (n) show(n); }
  function undo() {
    api('/api/undo', {}).then(function (r) { toast('undone ' + (r.undone.group || r.undone.labelIds[0])); return loadState(); })
      .then(function () { if (current) show(current.item_id); }).catch(fail);
  }
  function openReplay() {
    var body = current ? { item_id: current.item_id } : null;
    api('/api/replay/open', body).then(function (r) { toast(r.found ? 'Opened offline replay; target outlined' : 'Opened offline replay; target not found'); }).catch(fail);
  }
  var outlineOn = true;
  function toggleOutline() { outlineOn = !outlineOn; api('/api/replay/outline', { on: outlineOn }).then(function (r) { toast('outline ' + (r.outline ? 'on' : 'off')); }).catch(fail); }
  function propose() {
    api('/api/propagate/propose', { item_id: current.item_id }).then(function (r) {
      var box = document.getElementById('propagation'); box.textContent = '';
      if (!r.eligible) { box.appendChild(el('p', { text: r.reason })); return; }
      if (!r.instances.length) { box.appendChild(el('p', { text: 'No equivalent instances (same element, context and state) on other pages.' })); return; }
      box.appendChild(el('h3', { text: 'Equivalent instances: review each before confirming' }));
      var list = el('div');
      r.instances.forEach(function (i) {
        var pre = el('pre', { 'class': 'html' }, [el('span', { 'class': 'ctx', text: i.html_context.before.slice(-200) }), el('mark', { text: i.html_context.element }), el('span', { 'class': 'ctx', text: i.html_context.after.slice(0, 200) })]);
        list.appendChild(el('label', { 'class': 'block' }, [el('input', { type: 'checkbox', 'data-instance': i.item_id }), ' ' + i.site + '/' + i.page]));
        list.appendChild(pre);
      });
      box.appendChild(list);
      box.appendChild(el('button', { 'class': 'k', on: { click: function () { confirmProp('violation'); } } }, ['Confirm: violation on all checked']));
      box.appendChild(el('button', { 'class': 'k', on: { click: function () { confirmProp('no_violation'); } } }, ['Confirm: no violation on all checked']));
    }).catch(fail);
  }
  function confirmProp(verdict) {
    var ids = Array.prototype.map.call(document.querySelectorAll('[data-instance]:checked'), function (c) { return c.dataset.instance; });
    if (!ids.length) { toast('Check the instances you have reviewed'); return; }
    api('/api/propagate/confirm', { item_id: current.item_id, instance_ids: ids, verdict: verdict, active_seconds: active })
      .then(function (r) { toast('group ' + r.group + ': ' + r.labels.length + ' labels'); return loadState(); }).then(function () { show(current.item_id); }).catch(fail);
  }
  function addCaseForm(site, page, fixedCriterion) {
    var f = el('form', { 'class': 'grid', 'data-testid': 'addcase' });
    var fields = {
      site: el('input', { name: 'site', value: site || '', required: 'required' }), page: el('input', { name: 'page', value: page || '', required: 'required' }),
      selector: el('input', { name: 'selector', placeholder: 'CSS selector (optional)' }), html: el('textarea', { name: 'html', rows: '2', placeholder: 'Element HTML (optional)' }),
      criterion: el('input', { name: 'criterion', value: fixedCriterion || '', placeholder: 'e.g. 1.3.1', required: 'required' }), issue: el('textarea', { name: 'issue', rows: '2', required: 'required' }),
    };
    Object.keys(fields).forEach(function (k) { f.appendChild(el('label', { text: k })); f.appendChild(fields[k]); });
    f.appendChild(el('span'));
    f.appendChild(el('button', { 'class': 'k', type: 'submit' }, ['Add case (violation)']));
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var body = {}; Object.keys(fields).forEach(function (k) { body[k] = fields[k].value; });
      if (!/^\d\.\d\.\d{1,2}$/.test(body.criterion.trim())) { toast('A criterion is required'); return; }
      body.criterion = body.criterion.trim(); body.active_seconds = active;
      api('/api/case', body).then(function (r) { toast('case ' + r.case_id + ' · ' + r.label_id); fields.selector.value = ''; fields.html.value = ''; fields.issue.value = ''; return mode === 'audit' ? loadState() : null; }).catch(fail);
    });
    return el('details', { 'class': 'addcase' }, [el('summary', { text: 'Add ground truth with no finding (a defect the engine may have missed)' }), f]);
  }

  // ======================= audit =======================
  var cell = null;
  function renderAudit() {
    var a = state.audit;
    document.getElementById('title').textContent = 'audit ' + a.audit_id + ' · ' + a.status;
    var nav = document.getElementById('list'); nav.textContent = '';
    nav.appendChild(el('h3', { text: 'Pages × criteria' }));
    a.pages.forEach(function (p) {
      a.criteria.forEach(function (c) {
        var k = p + '|' + c;
        nav.appendChild(el('button', { 'aria-current': cell === k ? 'true' : 'false', on: { click: function () { cell = k; startTimer(k); renderAudit(); } } }, [p + ' · ' + c, el('span', { 'class': 'v', text: a.cells[k] })]));
      });
    });
    var done = Object.keys(a.cells).filter(function (k) { return a.cells[k] !== 'pending'; }).length;
    document.getElementById('progress').textContent = done + ' / ' + Object.keys(a.cells).length + ' cells marked';
    var sec = document.getElementById('detail'); sec.textContent = '';
    if (a.status === 'annotating') {
      sec.appendChild(el('p', { 'class': 'muted', 'data-testid': 'blind', text: 'Engine findings, reasoning and counts stay hidden until you freeze this annotation.' }));
      sec.appendChild(el('button', { 'class': 'k', 'data-testid': 'freeze', on: { click: function () { if (confirm('Freeze the annotation? Pre-reveal judgments cannot change afterwards.')) api('/api/audit/freeze', {}).then(loadState).catch(fail); } } }, ['Freeze annotation']));
    } else {
      var runInput = el('input', { id: 'run', placeholder: 'run id', value: a.revealed_run || '' });
      sec.appendChild(el('p', null, ['Frozen. Reveal engine output from run ', runInput, ' ',
        el('button', { 'class': 'k', 'data-testid': 'reveal', on: { click: function () { api('/api/audit/reveal', { run_id: runInput.value.trim() }).then(loadState).catch(fail); } } }, ['Reveal'])]));
    }
    if (a.reveal) renderReveal(sec, a.reveal);
    if (!cell) { sec.appendChild(el('p', { text: 'Choose a page and criterion.' })); return; }
    var parts = cell.split('|'), pageRef = parts[0], crit = parts[1], sp = pageRef.split('/');
    sec.appendChild(el('h2', { text: pageRef + ' · ' + crit }));
    sec.appendChild(el('figure', null, [el('img', { src: '/page-capture/' + sp[0] + '/' + sp[1], alt: 'Captured page' }), el('figcaption', { text: 'Full-page screenshot (captured)' })]));
    sec.appendChild(el('button', { 'class': 'k', on: { click: function () { api('/api/replay/open', { site: sp[0], page: sp[1] }).then(function () { toast('Opened offline replay'); }).catch(fail); } } }, ['Open in replay']));
    if (a.status === 'annotating') {
      var bar = el('div', { 'class': 'actions' }, ['complete', 'partial', 'unable'].map(function (s) {
        return el('button', { 'class': 'k', 'data-status': s, on: { click: function () { api('/api/audit/status', { page_ref: pageRef, criterion: crit, status: s }).then(loadState).catch(fail); } } }, ['Mark ' + s]);
      }));
      bar.appendChild(el('button', { 'class': 'k', 'data-testid': 'negative', on: { click: function () { api('/api/audit/negative', { page_ref: pageRef, criterion: crit, active_seconds: active }).then(function (r) { toast('tested negative ' + r.case_id); return loadState(); }).catch(fail); } } }, ['No violation found (tested negative)']));
      sec.appendChild(bar);
      sec.appendChild(addCaseForm(sp[0], sp[1], crit));
    }
    var mine = a.cases.filter(function (c) { return c.page_ref === pageRef && c.criterion === crit; });
    var t = el('table', { 'data-testid': 'audit-cases' }, [el('tr', null, ['case', 'issue', 'selector', 'verdict'].map(function (h) { return el('th', { text: h }); }))]);
    mine.forEach(function (c) { t.appendChild(el('tr', null, [c.case_id, c.issue, c.selector || '—', c.verdict || '—'].map(function (v) { return el('td', { text: v }); }))); });
    sec.appendChild(t);
  }
  function renderReveal(sec, r) {
    sec.appendChild(el('h2', { text: 'Revealed: run ' + r.run_id }));
    sec.appendChild(el('p', { 'data-testid': 'misses', text: r.misses.length + ' miss(es): ' + r.misses.map(function (m) { return m.case_id + ' ' + m.criterion + ' ' + m.page_ref; }).join(', ') }));
    var t = el('table', { 'data-testid': 'outcomes' }, [el('tr', null, ['case', 'criterion', 'page', 'class'].map(function (h) { return el('th', { text: h }); }))]);
    r.outcomes.forEach(function (o) { t.appendChild(el('tr', null, [o.case_id, o.criterion, o.page_ref, o.class].map(function (v) { return el('td', { text: v }); }))); });
    sec.appendChild(t);
    sec.appendChild(el('h3', { text: 'Engine findings not in your annotation (judge after reveal)' }));
    var list = el('ul', { 'data-testid': 'engine-only' });
    r.engine_only.forEach(function (p) {
      list.appendChild(el('li', null, [p.page_ref + ' ' + p.criterion + ' ' + p.selector + ' ',
        p.item_id ? el('button', { 'class': 'k', on: { click: function () { api('/api/judge', { item_id: p.item_id, verdict: 'violation', criterion: p.criterion, active_seconds: active }).then(function (x) { toast('post-reveal ' + x.label_id); }).catch(fail); } } }, ['T violation']) : null,
        p.item_id ? el('button', { 'class': 'k', on: { click: function () { api('/api/judge', { item_id: p.item_id, verdict: 'no_violation', criterion: p.criterion, active_seconds: active }).then(function (x) { toast('post-reveal ' + x.label_id); }).catch(fail); } } }, ['F no violation']) : null]));
    });
    sec.appendChild(list);
  }

  // ======================= keys =======================
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || mode !== 'review') return;
    var k = ev.key.toLowerCase();
    if (sevPending && ['1', '2', '3', '4'].indexOf(k) !== -1) { judge('violation', ['critical', 'major', 'minor', 'advisory'][Number(k) - 1]); ev.preventDefault(); return; }
    var map = { t: function () { judge('violation'); }, f: function () { judge('no_violation'); }, s: askSeverity, u: function () { judge('unsure'); }, n: goNext, z: undo };
    if (map[k]) { ev.preventDefault(); map[k](); }
  });

  loadState().then(function () { if (mode === 'review' && items.length) show(items[0].item_id); }).catch(fail);
})();
`;
