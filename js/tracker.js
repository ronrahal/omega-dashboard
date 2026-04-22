/* js/tracker.js — QC Tracker: log bets, stats, charts, signal attribution */

const TRACKER_KEY = 'omega_bets_v1';
let pnlChart   = null;
let assetChart = null;

function getBets() {
  try { return JSON.parse(localStorage.getItem(TRACKER_KEY) || '[]'); } catch { return []; }
}
function saveBets(bets) { localStorage.setItem(TRACKER_KEY, JSON.stringify(bets)); }

function logBet() {
  const asset  = document.getElementById('f-asset').value;
  const side   = document.getElementById('f-side').value;
  const tier   = document.getElementById('f-tier').value;
  const pedge  = parseFloat(document.getElementById('f-pedge').value) || 62;
  const ev     = parseFloat(document.getElementById('f-ev').value) || 0;
  const amt    = parseFloat(document.getElementById('f-amt').value) || 3;
  const price  = parseFloat(document.getElementById('f-price').value) || 0.5;
  const sigs   = document.getElementById('f-signals').value.trim();
  if (amt<=0||price<=0||price>=1) { toast('Check bet amount and price','err'); return; }
  const bet = {
    id: Date.now(), ts: new Date().toISOString(),
    asset, side, tier, pedge, ev, amt, price,
    signals: sigs ? sigs.split(',').map(s=>s.trim().toUpperCase()) : [],
    outcome: 'pending', pnl: 0,
  };
  const bets = getBets();
  bets.unshift(bet);
  saveBets(bets);
  toast(`Logged ${asset} ${side.toUpperCase()} $${amt}`);
  renderTracker();
}

function setOutcome(id, outcome) {
  const bets = getBets();
  const b    = bets.find(x => x.id === id);
  if (!b) return;
  b.outcome = outcome;
  if (outcome === 'win')  b.pnl = parseFloat(((b.amt/b.price)-b.amt).toFixed(2));
  else if (outcome === 'loss') b.pnl = -b.amt;
  else b.pnl = 0;
  saveBets(bets);
  renderTracker();
}

function deleteBet(id) {
  saveBets(getBets().filter(b => b.id !== id));
  renderTracker();
  toast('Bet removed');
}

function clearAll() {
  if (!confirm('Delete all logged bets?')) return;
  localStorage.removeItem(TRACKER_KEY);
  renderTracker();
  toast('Cleared');
}

function exportCSV() {
  const bets = getBets();
  if (!bets.length) { toast('Nothing to export','err'); return; }
  const hdr  = 'id,time,asset,side,tier,pedge,ev,amt,price,signals,outcome,pnl';
  const rows = bets.map(b => [b.id,b.ts,b.asset,b.side,b.tier,b.pedge,b.ev,b.amt,b.price,(b.signals||[]).join(';'),b.outcome,b.pnl].join(','));
  const csv  = [hdr, ...rows].join('\n');
  const a    = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'omega-bets-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  toast('CSV downloaded');
}

function renderTracker() {
  const bets     = getBets();
  const settled  = bets.filter(b => b.outcome !== 'pending');
  const wins     = settled.filter(b => b.outcome === 'win');
  const losses   = settled.filter(b => b.outcome === 'loss');
  const totalPnl = settled.reduce((a,b) => a+b.pnl, 0);
  const wr       = settled.length ? wins.length/settled.length : null;
  const bankroll = parseFloat(document.getElementById('bankroll').value) || 30;
  const avgEV    = bets.length ? bets.reduce((a,b)=>a+b.ev,0)/bets.length : null;

  let decay = '—';
  if (settled.length >= 10) {
    const first10 = settled.slice(-10), last10 = settled.slice(0,10);
    const wrFirst = first10.filter(b=>b.outcome==='win').length/first10.length;
    const wrLast  = last10.filter(b=>b.outcome==='win').length/last10.length;
    const diff    = (wrLast-wrFirst)*100;
    decay = (diff>=0?'+':'')+diff.toFixed(1)+'%';
    document.getElementById('tr-decay').style.color = diff>=0?'var(--g)':'var(--r)';
  }

  document.getElementById('tr-total').textContent = bets.length;
  document.getElementById('tr-wr').textContent    = wr!==null?(wr*100).toFixed(1)+'%':'—';
  document.getElementById('tr-wr').style.color    = wr!==null?(wr>=.54?'var(--g)':wr>=.50?'var(--y)':'var(--r)'):'var(--g)';
  document.getElementById('tr-wl').textContent    = `${wins.length}W / ${losses.length}L`;
  document.getElementById('tr-roi').textContent   = settled.length?(((totalPnl/bankroll)*100).toFixed(1)+'%'):'—';
  document.getElementById('tr-roi').style.color   = totalPnl>=0?'var(--g)':'var(--r)';
  document.getElementById('tr-avgev').textContent = avgEV!==null?(avgEV>=0?'+':'')+avgEV.toFixed(1)+'¢':'—';
  document.getElementById('tr-pnl').textContent   = settled.length?((totalPnl>=0?'+':'')+'$'+Math.abs(totalPnl).toFixed(2)):'—';
  document.getElementById('tr-pnl').style.color   = totalPnl>=0?'var(--g)':'var(--r)';
  document.getElementById('tr-decay').textContent = decay;

  _renderPnlChart(settled);
  _renderAssetChart(settled);
  _renderSignalBreakdown(settled);
  _renderBetTable(bets);
}

function _renderPnlChart(settled) {
  const canvas = document.getElementById('chart-pnl');
  if (!canvas || !window.Chart) return;
  if (pnlChart) { pnlChart.destroy(); pnlChart = null; }
  if (!settled.length) return;
  const sorted = [...settled].reverse();
  let cum = 0;
  const data   = sorted.map(b => { cum+=b.pnl; return parseFloat(cum.toFixed(2)); });
  const labels = sorted.map((_,i) => '#'+(i+1));
  const color  = cum>=0 ? '#00e5a0' : '#ff4060';
  pnlChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets:[{ label:'P&L', data, borderColor:color, borderWidth:2, pointRadius:2, tension:.35, fill:true, backgroundColor:color+'14' }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ y:{ticks:{callback:v=>'$'+v,font:{size:10},color:'#6c6f8a'},grid:{color:'rgba(255,255,255,0.04)'}},
               x:{ticks:{font:{size:9},color:'#6c6f8a',maxTicksLimit:8},grid:{display:false}} } },
  });
}

function _renderAssetChart(settled) {
  const canvas = document.getElementById('chart-asset');
  if (!canvas || !window.Chart) return;
  if (assetChart) { assetChart.destroy(); assetChart = null; }
  if (!settled.length) return;
  const map = {};
  settled.forEach(b => { if(!map[b.asset]) map[b.asset]={w:0,t:0}; map[b.asset].t++; if(b.outcome==='win') map[b.asset].w++; });
  const labels = Object.keys(map);
  const data   = labels.map(a => parseFloat((map[a].w/map[a].t*100).toFixed(1)));
  const COLORS  = {SOL:'#9945ff',BTC:'#f7931a',ETH:'#627eea',BNB:'#f0b90b',HYP:'#00e5a0'};
  const colors  = labels.map(a => COLORS[a]||'#6c6f8a');
  assetChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets:[{data,backgroundColor:colors.map(c=>c+'44'),borderColor:colors,borderWidth:1.5,borderRadius:4}] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ y:{min:0,max:100,ticks:{callback:v=>v+'%',font:{size:10},color:'#6c6f8a'},grid:{color:'rgba(255,255,255,0.04)'}},
               x:{ticks:{font:{size:10},color:'#6c6f8a'},grid:{display:false}} } },
  });
}

function _renderSignalBreakdown(settled) {
  const el = document.getElementById('sig-breakdown');
  if (settled.length < 5) { el.innerHTML=`<div class="empty" style="padding:16px">Log at least 5 settled bets</div>`; return; }
  const sigMap = {};
  settled.forEach(b => {
    (b.signals||[]).forEach(s => { if(!sigMap[s]) sigMap[s]={w:0,t:0}; sigMap[s].t++; if(b.outcome==='win') sigMap[s].w++; });
  });
  ['ALPHA','BUY','WATCH'].forEach(tier => {
    const sub = settled.filter(b=>b.tier===tier);
    if (sub.length > 0) sigMap['Tier:'+tier] = { w:sub.filter(b=>b.outcome==='win').length, t:sub.length };
  });
  const sorted = Object.entries(sigMap).filter(([,v])=>v.t>=3).sort((a,b)=>b[1].w/b[1].t-a[1].w/a[1].t);
  if (!sorted.length) { el.innerHTML=`<div class="empty" style="padding:16px">Name your signals when logging</div>`; return; }
  el.innerHTML = sorted.map(([name,{w,t}]) => {
    const wr    = w/t;
    const color = wr>=.6?'var(--g)':wr>=.52?'var(--y)':'var(--r)';
    return `<div class="sig-row2">
      <div class="sig-name">${name}</div>
      <div class="sig-bar-wrap"><div class="sig-bar-inner" style="width:${(wr*100).toFixed(0)}%;background:${color}"></div></div>
      <div class="sig-wr" style="color:${color}">${(wr*100).toFixed(0)}%</div>
      <div class="sig-count">${t} bets</div>
    </div>`;
  }).join('');
}

function _renderBetTable(bets) {
  const tbody = document.getElementById('bet-tbody');
  if (!bets.length) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--faint);padding:20px">No bets logged yet</td></tr>`;
    return;
  }
  const COLORS = {SOL:'#9945ff',BTC:'#f7931a',ETH:'#627eea',BNB:'#f0b90b',HYP:'#00e5a0'};
  tbody.innerHTML = bets.map((b,i) => {
    const ac     = COLORS[b.asset] || '#6c6f8a';
    const ts     = new Date(b.ts).toLocaleString('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const pnlStr = b.outcome==='pending'?'—':(b.pnl>=0?'+':'')+b.pnl.toFixed(2);
    const pnlColor = b.outcome==='win'?'var(--g)':b.outcome==='loss'?'var(--r)':'var(--muted)';
    return `<tr>
      <td style="color:var(--faint)">${bets.length-i}</td>
      <td style="color:var(--muted)">${ts}</td>
      <td><span class="bt-asset" style="background:${ac}22;color:${ac}">${b.asset}</span></td>
      <td><span class="bt-side ${b.side==='yes'?'bt-bull':'bt-bear'}">${b.side==='yes'?'UP':'DOWN'}</span></td>
      <td style="color:var(--muted)">${b.tier}</td>
      <td style="color:var(--p)">${b.pedge.toFixed(1)}%</td>
      <td style="color:var(--y)">${b.ev>=0?'+':''}${b.ev.toFixed(1)}¢</td>
      <td>$${b.amt.toFixed(2)}</td>
      <td style="color:var(--muted)">$${b.price.toFixed(2)}</td>
      <td style="color:var(--muted);font-size:9px">${(b.signals||[]).join(', ')||'—'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="bt-outcome ${b.outcome==='win'?'bt-win':''}"     onclick="setOutcome(${b.id},'win')">W</button>
          <button class="bt-outcome ${b.outcome==='loss'?'bt-loss':''}"   onclick="setOutcome(${b.id},'loss')">L</button>
          <button class="bt-outcome ${b.outcome==='pending'?'bt-pending':''}" onclick="setOutcome(${b.id},'pending')">?</button>
        </div>
      </td>
      <td style="color:${pnlColor};font-weight:700">${pnlStr}</td>
      <td><button class="hbtn danger" style="padding:3px 8px;font-size:9px" onclick="deleteBet(${b.id})">✕</button></td>
    </tr>`;
  }).join('');
}

/* ── Auto-poll outcomes for pending bets ── */
let _outcomePollTimer = null;

function startOutcomePoll() {
  if (_outcomePollTimer) return;
  _outcomePollTimer = setInterval(_checkPendingOutcomes, 30000);
  _checkPendingOutcomes(); // run immediately
}

async function _checkPendingOutcomes() {
  const bets    = getBets();
  const pending = bets.filter(b => b.outcome === 'pending' && b.marketId && b.closeTime);
  if (!pending.length) return;

  const now = Date.now();
  let changed = false;

  for (const b of pending) {
    const closeTs = b.closeTime > 1e12 ? b.closeTime : b.closeTime * 1000;
    if (closeTs > now) continue; // not closed yet

    try {
      const d   = await japi(`/markets/${b.marketId}`);
      const mkt = d.data || d;
      let resolved = null;

      if (mkt.resolvedOutcome === 'yes' || mkt.status === 'resolved_yes') resolved = 'yes';
      else if (mkt.resolvedOutcome === 'no' || mkt.status === 'resolved_no') resolved = 'no';
      else {
        const yp = normPrice(mkt.pricing?.buyYesPriceUsd);
        if (yp >= 0.95) resolved = 'yes';
        else if (yp <= 0.05) resolved = 'no';
      }

      if (resolved) {
        const won   = b.side === resolved;
        b.outcome   = won ? 'win' : 'loss';
        b.pnl       = won ? parseFloat(((b.amt / b.price) - b.amt).toFixed(2)) : -b.amt;
        changed     = true;
        toast(`Auto-settled: ${b.asset} ${b.side.toUpperCase()} → ${won ? 'WIN' : 'LOSS'}`, won ? 'ok' : 'err');
      }
    } catch {}
  }

  if (changed) {
    saveBets(bets);
    renderTracker();
    _updatePendingBadge();
  }
}

function _updatePendingBadge() {
  const pending = getBets().filter(b => b.outcome === 'pending').length;
  const tBtn    = document.querySelector('.tab-btn[onclick*="tracker"]');
  if (!tBtn) return;
  // show dot on tab if pending bets exist
  tBtn.textContent = pending > 0 ? `◈ QC Tracker (${pending})` : '◈ QC Tracker';
  tBtn.style.color  = pending > 0 ? 'var(--y)' : '';
}
