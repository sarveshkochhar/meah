'use strict';
/* MEAH console. No framework, no build step, no dependencies.
   Every value rendered here comes from the local control plane, which has
   already redacted secrets. Text is inserted via textContent only. */

const $ = (id) => document.getElementById(id);

const state = {
  workers: [],
  selectedId: null,
  detail: null,
  connected: false,
  pollMs: 1000,
};

/* ---------- helpers ---------- */

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtNum(n) {
  return n === null || n === undefined ? '–' : n.toLocaleString('en-US');
}

function setBanner(code, message) {
  const banner = $('banner');
  if (!code) {
    banner.hidden = true;
    return;
  }
  $('banner-code').textContent = code;
  $('banner-msg').textContent = message;
  banner.hidden = false;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({
    ok: false,
    error: { code: 'E_NETWORK', message: `${res.status} ${res.statusText}` },
  }));
  if (!json.ok) throw json.error;
  return json.data;
}

/* ---------- sidebar ---------- */

let sidebarSignature = '';

function renderSidebar(data) {
  // Config is static per process; only repaint when it actually changes.
  const signature = JSON.stringify([data.providers, data.roles, data.defaults]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;

  const providers = $('providers');
  providers.textContent = '';
  if (data.providers.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No providers configured. See .env.example.';
    providers.append(p);
  }
  for (const p of data.providers) {
    const wrap = document.createElement('div');
    wrap.className = 'provider';

    const name = document.createElement('div');
    name.className = 'name';
    const dot = document.createElement('span');
    // Class, not an inline style: the console ships a strict CSP with no
    // 'unsafe-inline', so style attributes are blocked by design.
    dot.className = `dot ${p.apiKeyPresent ? 'key-present' : 'key-missing'}`;
    // Key presence is the only credential fact ever exposed.
    dot.title = p.apiKeyPresent ? `${p.apiKeyEnv} is set` : `${p.apiKeyEnv} is NOT set`;
    name.append(dot, document.createTextNode(p.provider));

    const base = document.createElement('div');
    base.className = 'meta';
    base.textContent = p.baseUrl;

    const model = document.createElement('div');
    model.className = 'meta';
    model.textContent = `default: ${p.defaultModel}`;

    wrap.append(name, base, model);
    providers.append(wrap);
  }

  renderRoutes(data);

  const limits = $('limits');
  limits.textContent = '';
  const rows = [
    ['max concurrent', data.defaults.maxConcurrent],
    ['timeout', `${data.defaults.timeoutMs / 1000}s`],
    ['max output', fmtNum(data.defaults.maxOutputTokens)],
    ['context cap', `${fmtNum(data.defaults.maxContextChars)} ch`],
    ['permissions', data.defaults.permissionProfile],
    ['terminal', data.terminal.enabled ? 'enabled' : 'disabled'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    limits.append(dt, dd);
  }

  const providerSelect = $('provider');
  const current = providerSelect.value;
  providerSelect.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'role default';
  providerSelect.append(def);
  for (const p of data.providers) {
    const opt = document.createElement('option');
    opt.value = p.provider;
    opt.textContent = p.provider;
    providerSelect.append(opt);
  }
  providerSelect.value = current;

  $('s-limit').textContent = data.defaults.maxConcurrent;
  $('timeoutMs').value = data.defaults.timeoutMs;
}

/* ---------- agents (editable role -> model routing) ---------- */

async function loadCatalog(provider) {
  const list = $('model-catalog');
  if (!provider || list.dataset.provider === provider) return;
  try {
    const data = await api('GET', `/api/providers/${encodeURIComponent(provider)}/models`);
    list.dataset.provider = provider;
    list.textContent = '';
    for (const id of data.models) {
      const opt = document.createElement('option');
      opt.value = id;
      list.append(opt);
    }
  } catch {
    // A provider without a listable catalog is fine: the input stays free text.
  }
}

async function saveRole(role, input, providerSelect) {
  const model = input.value.trim();
  try {
    await api('PUT', `/api/roles/${encodeURIComponent(role)}`, {
      provider: providerSelect.value,
      ...(model ? { model } : {}),
    });
    input.classList.remove('dirty');
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1200);
    sidebarSignature = ''; // force a repaint from the server's new truth
    setBanner(null);
  } catch (err) {
    setBanner(err.code || 'E_UNKNOWN', err.message || 'Could not update the role.');
  }
}

function renderRoutes(data) {
  const routes = $('routes');
  routes.textContent = '';
  for (const r of data.roles) {
    const row = document.createElement('div');
    row.className = 'route-row';

    const head = document.createElement('div');
    head.className = 'r';
    const name = document.createElement('span');
    name.textContent = r.role;
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = r.effective ? r.effective.source : 'unrouted';
    head.append(name, src);

    const providerSelect = document.createElement('select');
    for (const p of data.providers) {
      const opt = document.createElement('option');
      opt.value = p.provider;
      opt.textContent = p.provider;
      providerSelect.append(opt);
    }
    providerSelect.value = r.effective?.provider ?? data.providers[0]?.provider ?? '';
    providerSelect.setAttribute('aria-label', `${r.role} provider`);

    const model = document.createElement('input');
    model.setAttribute('list', 'model-catalog');
    model.setAttribute('aria-label', `${r.role} model`);
    model.placeholder = 'provider default';
    model.value = r.effective?.model ?? '';
    model.autocomplete = 'off';

    model.addEventListener('focus', () => void loadCatalog(providerSelect.value));
    model.addEventListener('input', () => model.classList.add('dirty'));
    model.addEventListener('change', () => void saveRole(r.role, model, providerSelect));
    model.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void saveRole(r.role, model, providerSelect);
      }
    });
    providerSelect.addEventListener('change', () => {
      void loadCatalog(providerSelect.value);
      void saveRole(r.role, model, providerSelect);
    });

    row.append(head, providerSelect, model);
    routes.append(row);
  }

  // Populate the picker up front rather than waiting for a focus event, so the
  // model list is ready the moment someone clicks a field.
  const firstProvider = data.roles.find((r) => r.effective)?.effective.provider;
  void loadCatalog(firstProvider ?? data.providers[0]?.provider);
}

/* ---------- worker table ---------- */

let rowsSignature = '';

function renderRows(force = false) {
  const tbody = $('rows');
  const empty = $('empty');

  // Repaint only when something actually changed. Rebuilding every poll tick
  // would clobber keyboard focus and text selection once a second.
  const signature = JSON.stringify([
    state.selectedId,
    state.workers.map((w) => [w.workerId, w.state, w.durationMs, w.totalTokens, w.model]),
  ]);
  if (!force && signature === rowsSignature) return;
  rowsSignature = signature;

  const focusedIndex = [...tbody.children].indexOf(document.activeElement?.closest?.('tr'));
  empty.hidden = state.workers.length > 0;
  tbody.textContent = '';

  // Newest first: that is the one you are waiting on.
  const ordered = [...state.workers].reverse();
  for (const w of ordered) {
    const tr = document.createElement('tr');
    tr.dataset.state = w.state;
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', String(w.workerId === state.selectedId));

    const stateCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'state';
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot, document.createTextNode(w.state));
    stateCell.append(badge);

    const role = document.createElement('td');
    role.textContent = w.role;

    const model = document.createElement('td');
    model.className = 'model';
    model.textContent = w.model;
    model.title = `${w.provider} / ${w.model}`;

    const task = document.createElement('td');
    task.textContent = w.label || '—';
    task.title = w.label || '';

    const tokens = document.createElement('td');
    tokens.className = 'num';
    tokens.textContent = w.totalTokens === undefined ? '–' : fmtNum(w.totalTokens);

    const duration = document.createElement('td');
    duration.className = 'num';
    duration.textContent = fmtDuration(w.durationMs);

    const id = document.createElement('td');
    id.className = 'id';
    id.textContent = w.workerId.replace(/^w_/, '').slice(0, 8);
    id.title = w.workerId;

    tr.append(stateCell, role, model, task, tokens, duration, id);
    const select = () => selectWorker(w.workerId);
    tr.addEventListener('click', select);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    tbody.append(tr);
  }

  // Restore keyboard focus to the same row position after a repaint.
  if (focusedIndex >= 0 && tbody.children[focusedIndex]) {
    tbody.children[focusedIndex].focus();
  }
}

/* ---------- detail ---------- */

async function selectWorker(id) {
  state.selectedId = id;
  $('detail').classList.add('open');
  renderRows();
  await refreshDetail();
}

async function refreshDetail() {
  if (!state.selectedId) return;
  try {
    state.detail = await api('GET', `/api/workers/${encodeURIComponent(state.selectedId)}`);
    renderDetail();
  } catch (err) {
    setBanner(err.code || 'E_UNKNOWN', err.message || 'Could not load worker.');
  }
}

function renderDetail() {
  const w = state.detail;
  $('detail-empty').hidden = Boolean(w);
  $('detail-content').hidden = !w;
  if (!w) return;

  const head = $('d-state');
  head.dataset.state = w.state;
  head.lastElementChild.textContent = w.state;
  $('d-id').textContent = w.workerId;

  const routing = $('d-routing');
  routing.textContent = '';
  const rows = [
    ['provider', w.provider],
    ['model', w.model],
    ['role', w.role],
    ['route', w.routeSource],
    ['permissions', w.permissionProfile],
    ['prompt', `${fmtNum(w.promptChars)} ch`],
    ['duration', fmtDuration(w.durationMs)],
  ];
  if (w.result) {
    rows.push(
      ['latency', fmtDuration(w.result.latencyMs)],
      ['tokens', fmtNum(w.result.usage.totalTokens)],
      ['attempts', w.result.attempts],
      ['finish', w.result.finishReason],
    );
  }
  if (w.contextTruncated) rows.push(['context', 'truncated']);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    routing.append(dt, dd);
  }

  $('d-result-wrap').hidden = !w.result;
  if (w.result) {
    $('d-result').textContent = w.result.text;
    $('d-trunc').hidden = !w.result.truncated;
  }

  $('d-error-wrap').hidden = !w.error;
  if (w.error) {
    const lines = [`${w.error.code}: ${w.error.message}`];
    if (w.error.hint) lines.push('', `hint: ${w.error.hint}`);
    if (w.error.details) lines.push('', JSON.stringify(w.error.details, null, 2));
    $('d-error').textContent = lines.join('\n');
  }

  const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(w.state);
  $('d-cancel').disabled = terminal;
  $('d-cleanup').disabled = !terminal || !w.workspace || w.workspaceRemoved;
}

/* ---------- polling ---------- */

async function poll() {
  try {
    const data = await api('GET', '/api/state');
    if (!state.connected) {
      state.connected = true;
      $('conn').dataset.state = 'succeeded';
      $('conn-text').textContent = 'connected';
      setBanner(null);
    }
    renderSidebar(data);
    state.workers = data.workers;
    $('s-running').textContent = data.runtime.running;
    $('s-queued').textContent = data.runtime.queued;
    renderRows();
    if (state.selectedId) {
      const summary = state.workers.find((w) => w.workerId === state.selectedId);
      // Only refetch while it can still change, or when first opened.
      if (!state.detail || state.detail.workerId !== state.selectedId) await refreshDetail();
      else if (summary && summary.state !== state.detail.state) await refreshDetail();
      else if (summary && ['queued', 'running'].includes(summary.state)) await refreshDetail();
    }
  } catch (err) {
    state.connected = false;
    $('conn').dataset.state = 'failed';
    $('conn-text').textContent = 'disconnected';
    setBanner(err.code || 'E_NETWORK', err.message || 'MEAH control plane unreachable.');
  } finally {
    setTimeout(poll, state.pollMs);
  }
}

/* ---------- actions ---------- */

function buildRequest(dryRun) {
  const task = $('task').value.trim();
  const contextText = $('context').value.trim();
  const body = {
    task,
    role: $('role').value,
    maxOutputTokens: Number($('maxOutputTokens').value),
    timeoutMs: Number($('timeoutMs').value),
    label: task.length > 60 ? `${task.slice(0, 60)}…` : task,
    dryRun,
  };
  if ($('provider').value) body.provider = $('provider').value;
  if ($('model').value.trim()) body.model = $('model').value.trim();
  if (contextText) body.context = [{ name: 'pasted-context', kind: 'text', text: contextText }];
  return body;
}

async function submit(dryRun) {
  const body = buildRequest(dryRun);
  if (!body.task) return;
  $('run').disabled = true;
  $('dry').disabled = true;
  try {
    setBanner(null);
    const record = await api('POST', '/api/workers', body);
    $('task').value = '';
    $('context').value = '';
    await selectWorker(record.workerId);
  } catch (err) {
    const detail = err.details?.issues?.[0];
    setBanner(
      err.code || 'E_UNKNOWN',
      detail ? `${err.message} (${detail.path?.join('.')}: ${detail.message})` : err.message,
    );
  } finally {
    $('run').disabled = false;
    $('dry').disabled = false;
  }
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  void submit(false);
});
$('dry').addEventListener('click', () => void submit(true));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    void submit(false);
  }
  if (e.key === 'Escape' && state.selectedId) {
    state.selectedId = null;
    state.detail = null;
    $('detail').classList.remove('open');
    renderRows();
    renderDetail();
  }
});

$('d-cancel').addEventListener('click', async () => {
  try {
    await api('POST', `/api/workers/${encodeURIComponent(state.selectedId)}/cancel`);
    await refreshDetail();
  } catch (err) {
    setBanner(err.code, err.message);
  }
});

$('d-cleanup').addEventListener('click', async () => {
  try {
    await api('DELETE', `/api/workers/${encodeURIComponent(state.selectedId)}/workspace`);
    await refreshDetail();
  } catch (err) {
    setBanner(err.code, err.message);
  }
});

// Reasoning models can spend an entire small budget on reasoning tokens.
$('maxOutputTokens').addEventListener('input', (e) => {
  $('budget-hint').textContent =
    Number(e.target.value) < 1024 ? 'low budget — reasoning models may return no content' : '';
});

poll();
