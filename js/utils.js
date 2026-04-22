/* js/utils.js — shared helpers */

function getAsset(t = '') {
  const s = t.toLowerCase();
  if (s.includes('sol'))                          return 'sol';
  if (s.includes('btc') || s.includes('bitcoin')) return 'btc';
  if (s.includes('eth') || s.includes('ethereum'))return 'eth';
  if (s.includes('bnb'))                          return 'bnb';
  if (s.includes('hyp') || s.includes('hype'))    return 'hyp';
  return 'sol';
}

function isCrypto(ev) {
  const t = ((ev.metadata?.title || '') + ' ' + (ev.category || '')).toLowerCase();
  return ['sol','btc','eth','bnb','hyp','hype','bitcoin','ethereum'].some(k => t.includes(k));
}

function normPrice(raw) {
  if (!raw || isNaN(raw)) return 0.5;
  let p = +raw;
  while (p > 1.0) p = p / 1e6;
  return Math.min(0.99, Math.max(0.01, p));
}

function normVol(raw) {
  if (!raw || isNaN(raw)) return 0;
  let v = +raw;
  return v > 1e6 ? v / 1e6 : v;
}

function msLeft(ct) {
  const c = typeof ct === 'number' && ct > 1e12 ? ct : ct * 1000;
  return c - Date.now();
}

function fmtTime(ms) {
  if (ms <= 0) return 'CLOSED';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), sc = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

function tc(ms) {
  return ms > 180000 ? 'tc-f' : ms > 60000 ? 'tc-n' : 'tc-u';
}

function fmt(n, d = 2) {
  return isNaN(n) ? '—' : Number(n).toFixed(d);
}

function pct(n, d = 1) {
  return isNaN(n) ? '—' : (Number(n) * 100).toFixed(d) + '%';
}

function shortAddr(a) {
  return a ? a.slice(0, 4) + '…' + a.slice(-4) : '?';
}

function toast(msg, type = 'ok') {
  const e = document.getElementById('toast');
  e.textContent = msg;
  e.className = 'toast show ' + type;
  setTimeout(() => { e.className = 'toast'; }, 3200);
}

/* ── API fetch helpers ── */
async function bfetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } catch {
    const r2 = await fetch(PROXY + encodeURIComponent(url));
    if (!r2.ok) throw new Error(r2.status);
    return r2.json();
  }
}

async function japi(path) {
  const url = JBASE + path;
  const h = { 'x-api-key': JKEY, 'Accept': 'application/json' };
  try {
    const r = await fetch(url, { headers: h });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } catch {
    if (!useProxy) { useProxy = true; toast('Using CORS proxy', 'ok'); }
    const r2 = await fetch(PROXY + encodeURIComponent(url), { headers: h });
    if (!r2.ok) throw new Error(r2.status);
    return r2.json();
  }
}
