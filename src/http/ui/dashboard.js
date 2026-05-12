/* Cockpit OS dashboard client. No bundler, no framework. */

(() => {
  const tokenInput = document.getElementById('token');
  const uidInput = document.getElementById('uid');
  const refreshBtn = document.getElementById('refresh');

  const pulseEl = document.getElementById('pulse');
  const jobsEl = document.getElementById('jobs');
  const byKindEl = document.getElementById('by-kind');
  const bySourceEl = document.getElementById('by-source');
  const recentEl = document.getElementById('recent');

  // Restore token + uid filter across reloads. localStorage is fine here:
  // the token already lives in the operator's clipboard / password manager,
  // and the dashboard is admin-only.
  try {
    const saved = localStorage.getItem('_cockpit_admin_token');
    if (saved) tokenInput.value = saved;
    const savedUid = localStorage.getItem('cockpit.uid');
    if (savedUid) uidInput.value = savedUid;
  } catch (_) {
    /* ignore storage errors */
  }

  function persist() {
    try {
      localStorage.setItem('_cockpit_admin_token', tokenInput.value);
      localStorage.setItem('cockpit.uid', uidInput.value);
    } catch (_) {
      /* ignore */
    }
  }

  function authHeaders() {
    const token = tokenInput.value.trim();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  function uidQuery() {
    const uid = uidInput.value.trim();
    return uid ? `?uid=${encodeURIComponent(uid)}` : '';
  }

  async function fetchJson(path) {
    const res = await fetch(path, { headers: authHeaders() });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok) {
      const reason = (body && body.error) || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    return body;
  }

  function renderError(msg) {
    pulseEl.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`;
    jobsEl.innerHTML = '';
    byKindEl.innerHTML = '';
    bySourceEl.innerHTML = '';
    recentEl.innerHTML = '';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function row(key, value) {
    return `<div class="row"><span class="key">${escapeHtml(key)}</span><span class="value">${escapeHtml(value)}</span></div>`;
  }

  function renderPulse(summary) {
    const totalEvents = summary.totalEvents ?? 0;
    const first = summary.firstAt ? new Date(summary.firstAt).toLocaleString() : '—';
    const last = summary.lastAt ? new Date(summary.lastAt).toLocaleString() : '—';
    pulseEl.innerHTML = [
      row('total events', String(totalEvents)),
      row('first seen', first),
      row('last seen', last),
      row('kinds', String((summary.byKind || []).length)),
      row('sources', String((summary.bySource || []).length)),
    ].join('');
  }

  function renderJobs(histogram) {
    const order = ['queued', 'claimed', 'running', 'awaiting_input', 'done', 'failed', 'cancelled'];
    const known = new Set(order);
    const extras = Object.keys(histogram || {}).filter((k) => !known.has(k));
    const all = [...order, ...extras];
    jobsEl.innerHTML = all
      .map((status) => row(status, String(histogram?.[status] ?? 0)))
      .join('');
  }

  function renderBars(target, items, keyField) {
    if (!items || items.length === 0) {
      target.innerHTML = '<div class="muted">no events in window</div>';
      return;
    }
    const max = items[0]?.count || 1;
    target.innerHTML = items
      .map((it) => {
        const pct = Math.max(4, Math.round((it.count / max) * 100));
        return `
          <div class="bar-row">
            <div class="bar-label" title="${escapeHtml(it[keyField])}">${escapeHtml(it[keyField])}</div>
            <div class="bar-count">${escapeHtml(String(it.count))}</div>
            <div class="bar-track" style="grid-column: 1 / -1;">
              <div class="bar-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function eventClassFor(kind) {
    if (!kind) return '';
    if (kind.endsWith('.failed')) return 'kind-failed';
    if (kind.endsWith('.rejected')) return 'kind-rejected';
    if (kind.endsWith('.done') || kind.endsWith('.delivered') || kind.endsWith('.bound'))
      return 'kind-done';
    if (kind.endsWith('.awaiting') || kind.endsWith('.dropped') || kind.endsWith('.deduped'))
      return 'kind-awaiting';
    return '';
  }

  function summarizeData(data) {
    if (!data || typeof data !== 'object') return '';
    const entries = Object.entries(data).slice(0, 4);
    return entries
      .map(([k, v]) => {
        let str;
        if (v === null) str = 'null';
        else if (typeof v === 'object') str = JSON.stringify(v);
        else str = String(v);
        if (str.length > 60) str = str.slice(0, 57) + '…';
        return `${k}=${str}`;
      })
      .join(' ');
  }

  function renderRecent(events) {
    if (!events || events.length === 0) {
      recentEl.innerHTML = '<div class="muted">no events in window</div>';
      return;
    }
    recentEl.innerHTML = events
      .map((ev) => {
        const at = ev.at ? new Date(ev.at).toLocaleString() : '';
        const cls = eventClassFor(ev.kind);
        return `
          <div class="event-row ${cls}">
            <div class="at">${escapeHtml(at)}</div>
            <div class="kind">${escapeHtml(ev.kind ?? '')}</div>
            <div class="source">${escapeHtml(ev.source ?? '')}</div>
            <div class="uid">${escapeHtml(ev.uid ?? '')}</div>
            <div class="data" title="${escapeHtml(JSON.stringify(ev.data ?? {}))}">${escapeHtml(summarizeData(ev.data))}</div>
          </div>
        `;
      })
      .join('');
  }

  async function refresh() {
    persist();
    if (!tokenInput.value.trim()) {
      renderError('Enter your OPENCLAW_HOOKS_TOKEN above to load the dashboard.');
      return;
    }
    refreshBtn.disabled = true;
    try {
      const q = uidQuery();
      const [summaryRes, jobsRes, recentRes] = await Promise.all([
        fetchJson(`/api/dashboard/summary${q}`),
        fetchJson(`/api/dashboard/jobs${q}`),
        fetchJson(`/api/dashboard/recent${q}${q ? '&' : '?'}limit=50`),
      ]);
      renderPulse(summaryRes.summary || {});
      renderJobs(jobsRes.histogram || {});
      renderBars(byKindEl, summaryRes.summary?.byKind || [], 'kind');
      renderBars(bySourceEl, summaryRes.summary?.bySource || [], 'source');
      renderRecent(recentRes.events || []);
    } catch (err) {
      renderError(err && err.message ? err.message : 'failed to load dashboard');
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', refresh);
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refresh();
  });
  uidInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refresh();
  });

  // Auto-refresh every 30s while the tab is visible.
  let timer = null;
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 30_000);
  }
  startTimer();

  // Kick once on load if we already have a token.
  if (tokenInput.value.trim()) refresh();
})();
