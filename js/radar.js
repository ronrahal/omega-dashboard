/* js/radar.js
   Whale Radar v2 — builds wallet win-rates from OBSERVED 5m crypto trade outcomes.
   Does NOT use the global leaderboard (which covers all market types).
   Instead: watches the live trade feed, stores each bet, infers outcomes
   when markets close, and surfaces wallets with strong 5m-crypto win-rates.
*/

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
const RADAR_STORE_KEY = 'omega_radar_v2';

let radarState = _loadRadarState();   // persisted across sessions
let radarAlerts     = [];             // session-only copy signals
let radarWatching   = new Set(JSON.parse(localStorage.getItem('omega_watching') || '[]'));
let radarFilterMode = 'all';
let radarPollTimer  = null;
let radarRefreshing = false;

function _loadRadarState() {
  try {
    const raw = localStorage.getItem(RADAR_STORE_KEY);
    if (!raw) return _emptyState();
    const s = JSON.parse(raw);
    // restore plain objects — no Sets needed
    return s;
  } catch { return _emptyState(); }
}

function _emptyState() {
  return {
    wallets:      {},   // pubkey → { pubkey, bets:[], wins, losses, totalAmt }
    openBets:     {},   // tradeId → { pubkey, marketId, side, price, amount, ts }
    seenTrades:   [],   // array of tradeIds (cap at 2000)
    lastPollTs:   0,
  };
}

function _saveRadarState() {
  try {
    // cap seenTrades to avoid unbounded localStorage growth
    if (radarState.seenTrades.length > 2000) {
      radarState.seenTrades = radarState.seenTrades.slice(-1000);
    }
    localStorage.setItem(RADAR_STORE_KEY, JSON.stringify(radarState));
  } catch {}
}

/* ═══════════════════════════════════════════════
   WALLET SCORING (from observed outcomes)
═══════════════════════════════════════════════ */
function scoreObservedWallet(w) {
  const total = w.wins + w.losses;
  if (total < 3) return null;   // not enough data
  const wr       = w.wins / total;
  const minSample = Math.min(1, total / 20);   // confidence weight — grows to 1 at 20 bets
  return {
    pubkey:    w.pubkey,
    wins:      w.wins,
    losses:    w.losses,
    total,
    wr,
    winRate:   wr * 100,
    totalAmt:  w.totalAmt || 0,
    score:     Math.round(wr * minSample * 100),
    tier:      wr >= 0.65 && total >= 5 ? 'high' : wr >= 0.55 && total >= 3 ? 'med' : 'low',
    isWatched: radarWatching.has(w.pubkey),
  };
}

function getScoredWallets() {
  return Object.values(radarState.wallets)
    .map(scoreObservedWallet)
    .filter(Boolean)
    .sort((a,b) => b.score - a.score);
}

/* ═══════════════════════════════════════════════
   POLL TRADES — ingest new trades from feed
═══════════════════════════════════════════════ */
async function pollTrades() {
  try {
    const d      = await japi('/trades');
    const trades = d.data || [];
    const seenSet = new Set(radarState.seenTrades);
    let   newCount = 0;

    for (const t of trades) {
      if (!t.ownerPubkey || !t.marketId) continue;
      const tradeId = t.ownerPubkey + '|' + (t.timestamp||'') + '|' + t.marketId;
      if (seenSet.has(tradeId)) continue;

      // Only track 5m crypto markets
      const title = (t.marketTitle || t.eventTitle || '').toLowerCase();
      const isCryptoMkt = ['sol','btc','eth','bnb','hyp','hype','bitcoin','ethereum'].some(k => title.includes(k));
      if (!isCryptoMkt) continue;

      seenSet.add(tradeId);
      radarState.seenTrades.push(tradeId);
      newCount++;

      const closeTime = t.marketCloseTime || 0;
      const msLeft_   = msLeft(closeTime);

      // Register wallet if new
      if (!radarState.wallets[t.ownerPubkey]) {
        radarState.wallets[t.ownerPubkey] = {
          pubkey: t.ownerPubkey, wins: 0, losses: 0, totalAmt: 0, bets: [],
        };
      }

      const wallet = radarState.wallets[t.ownerPubkey];
      const amount = parseFloat(t.amountUsd) || 0;
      wallet.totalAmt += amount;

      // Store as open bet if market still running
      if (msLeft_ > 0) {
        radarState.openBets[tradeId] = {
          pubkey:    t.ownerPubkey,
          marketId:  t.marketId,
          side:      t.side === 'yes' ? 'yes' : 'no',
          price:     normPrice(t.price || 0.5),
          amount,
          ts:        t.timestamp || Date.now()/1000,
          closeTime,
          market:    t.marketTitle || t.eventTitle || 'Unknown',
        };
      }

      // If market already closed, we can infer outcome from the bet price
      // YES bet at <0.5 that closed = YES resolved (price was low because it was unlikely)
      // We can't know for certain without outcome data — flag as pending
      // BUT: we can check if the live price has moved significantly to give a signal
    }

    if (newCount > 0) _saveRadarState();

    // Try to resolve open bets where market has now closed
    await _resolveClosedBets();

    // Generate copy signals for watched + elite wallets
    await _generateSignals(trades);

    renderWalletTable();
    _updateRadarStats();

  } catch(e) {
    console.warn('Radar poll error:', e);
  }
}

/* ═══════════════════════════════════════════════
   RESOLVE CLOSED BETS
   We infer outcome by calling the market prices API.
   If YES price → 0.99, YES resolved. If → 0.01, NO resolved.
═══════════════════════════════════════════════ */
async function _resolveClosedBets() {
  const now = Date.now();
  const toResolve = Object.entries(radarState.openBets).filter(([, bet]) => {
    const closeTs = bet.closeTime > 1e12 ? bet.closeTime : bet.closeTime * 1000;
    return closeTs < now && (now - closeTs) < 300000; // closed within last 5 min
  });

  for (const [tradeId, bet] of toResolve) {
    try {
      // Try to fetch final market state
      const d = await japi(`/markets/${bet.marketId}`);
      const mkt = d.data || d;
      let resolved = null;

      // Check resolution fields (API may vary)
      if (mkt.resolvedOutcome === 'yes')  resolved = 'yes';
      if (mkt.resolvedOutcome === 'no')   resolved = 'no';
      if (mkt.status === 'resolved_yes')  resolved = 'yes';
      if (mkt.status === 'resolved_no')   resolved = 'no';

      // Fallback: if final YES price is extreme, infer outcome
      if (!resolved) {
        const finalYes = normPrice(mkt.pricing?.buyYesPriceUsd);
        if (finalYes >= 0.95) resolved = 'yes';
        if (finalYes <= 0.05) resolved = 'no';
      }

      if (resolved) {
        const won = bet.side === resolved;
        const w   = radarState.wallets[bet.pubkey];
        if (w) {
          if (won) w.wins++;
          else     w.losses++;
        }
        delete radarState.openBets[tradeId];
        _saveRadarState();
      }
    } catch {
      // Can't resolve yet — leave open
    }
  }
}

/* ═══════════════════════════════════════════════
   GENERATE COPY SIGNALS
   Only fire for wallets we're watching OR high-tier observed winners.
═══════════════════════════════════════════════ */
async function _generateSignals(trades) {
  const scoredWallets = getScoredWallets();
  const elitePubkeys  = new Set(scoredWallets.filter(w => w.tier === 'high').map(w => w.pubkey));
  const watchedPubkeys = new Set([...radarWatching, ...elitePubkeys]);
  if (!watchedPubkeys.size) return;

  const alertIds = new Set(radarAlerts.map(a => a.id));

  for (const t of trades) {
    if (!t.ownerPubkey || !watchedPubkeys.has(t.ownerPubkey)) continue;
    const tradeId = t.ownerPubkey + '|' + (t.timestamp||'') + '|' + t.marketId;
    if (alertIds.has(tradeId)) continue;

    const title     = t.marketTitle || t.eventTitle || '';
    const isCryptoMkt = ['sol','btc','eth','bnb','hyp','hype','bitcoin','ethereum']
      .some(k => title.toLowerCase().includes(k));
    if (!isCryptoMkt) continue;

    const asset  = getAsset(title);
    const side   = t.side === 'yes' ? 'yes' : 'no';
    const price  = normPrice(t.price || 0.5);
    const msRemaining = msLeft(t.marketCloseTime || 0);
    const secAgo = t.timestamp ? Math.round((Date.now() - t.timestamp*1000) / 1000) : 0;
    const wallet = scoredWallets.find(w => w.pubkey === t.ownerPubkey);

    // Staleness check
    const pc = priceCache[asset];
    let stale = false, staleMssg = '';
    if (msRemaining <= 60000) { stale = true; staleMssg = '<60s left'; }
    else if (pc && price > 0) {
      const drift = Math.abs(pc.price / price - 1);
      if (drift > 0.05) { stale = true; staleMssg = `price moved ${(drift*100).toFixed(1)}%`; }
    }

    // Run Omega
    let omegaAgrees = null, omegaCall = null;
    try {
      await refreshPriceCache(asset);
      const fakeMkt = {
        marketId: t.marketId || '',
        pricing:  { buyYesPriceUsd: side==='yes'?price:1-price, buyNoPriceUsd: side==='no'?price:1-price },
        closeTime: t.marketCloseTime || 0,
      };
      const yesR = await runOmega(fakeMkt, asset, 'yes');
      const noR  = await runOmega(fakeMkt, asset, 'no');
      const cd   = buildCall(yesR, noR, fakeMkt, asset, msRemaining);
      omegaAgrees = cd.side === side && cd.confidence >= 2;
      omegaCall   = cd;
    } catch {}

    radarAlerts.unshift({
      id: tradeId, ts: Date.now(), secAgo,
      pubkey: t.ownerPubkey, wallet,
      marketId: t.marketId || '',
      market: title || 'Unknown market',
      side, price, amount: parseFloat(t.amountUsd) || 0,
      asset, stale, staleMssg, omegaAgrees, omegaCall,
      closeTime: t.marketCloseTime || 0,
    });
  }

  if (radarAlerts.length > 0) {
    const total = radarAlerts.length;
    document.getElementById('wr-alerts-count').textContent = total;
    document.getElementById('hs-alerts').textContent = total;
    const agree = radarAlerts.filter(a => a.omegaAgrees).length;
    document.getElementById('wr-agree').textContent = agree + '/' + total;

    const latest  = radarAlerts[0];
    const tierStr = latest.wallet?.tier === 'high' ? '★★★ ' : '★ ';
    setAlertTicker(`${tierStr}${shortAddr(latest.pubkey)} bet ${latest.side.toUpperCase()} on ${latest.market.slice(0,40)} · ${latest.omegaAgrees?'Ω AGREES':'no Ω agree'}`);
    renderSignalFeed();

    if (document.hidden && Notification.permission === 'granted') {
      new Notification('OMEGA Whale Alert', {
        body: `${shortAddr(latest.pubkey)} → ${latest.side.toUpperCase()} $${latest.amount.toFixed(0)}`,
      });
    }
  }
}

/* ═══════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════ */
function setAlertTicker(msg) {
  document.getElementById('alert-ticker-text').textContent = msg;
  document.getElementById('alert-ticker-time').textContent =
    new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function _updateRadarStats() {
  const all   = getScoredWallets();
  const elite = all.filter(w => w.tier === 'high');
  document.getElementById('wr-total').textContent    = all.length || '—';
  document.getElementById('wr-elite').textContent    = elite.length || '—';
  document.getElementById('hs-whales').textContent   = all.length || '—';
  document.getElementById('wr-watching').textContent = radarWatching.size;

  const openCount = Object.keys(radarState.openBets).length;
  document.getElementById('wr-open-bets').textContent = openCount;
}

/* ── Filter button ── */
function radarFilter(f, btn) {
  radarFilterMode = f;
  document.querySelectorAll('.wb-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderWalletTable();
}

/* ── Render wallet table ── */
function renderWalletTable() {
  const el = document.getElementById('wallet-table');
  let wallets = getScoredWallets();

  if (!wallets.length) {
    el.innerHTML = `<div class="empty">
      <span style="font-size:18px">👁</span><br><br>
      Observing trades...<br>
      <span style="color:var(--muted)">Win-rates build as 5m crypto markets resolve.<br>Check back after a few minutes.</span><br><br>
      <span style="color:var(--faint)">Open bets tracked: ${Object.keys(radarState.openBets).length}</span>
    </div>`;
    return;
  }

  if (radarFilterMode === 'elite')    wallets = wallets.filter(w => w.tier === 'high');
  if (radarFilterMode === 'watching') wallets = wallets.filter(w => radarWatching.has(w.pubkey));

  if (!wallets.length) {
    el.innerHTML = `<div class="empty">No wallets match this filter yet</div>`;
    return;
  }

  el.innerHTML = '';
  wallets.forEach((w, i) => {
    const isWatching = radarWatching.has(w.pubkey);
    const scoreColor = w.score>=70?'var(--y)':w.score>=50?'var(--g)':w.score>=30?'var(--b)':'var(--muted)';
    const wrColor    = w.winRate>=65?'var(--g)':w.winRate>=52?'var(--y)':'var(--r)';
    const tierLabel  = w.tier==='high' ? '★★★' : w.tier==='med' ? '★★' : '★';
    const confidence = w.total >= 10 ? 'HIGH' : w.total >= 5 ? 'MED' : 'LOW';
    const confColor  = w.total >= 10 ? 'var(--g)' : w.total >= 5 ? 'var(--y)' : 'var(--muted)';

    const row = document.createElement('div');
    row.className = 'wallet-row' + (isWatching ? ' watching' : '');
    row.onclick   = () => openWalletDetail(w);
    row.innerHTML = `
      <div>
        <div class="wr-rank ${i<3?'top':''}">#${i+1}</div>
        <div class="score-micro-bar"><div class="score-micro-fill" style="width:${w.score}%;background:${scoreColor}"></div></div>
      </div>
      <div>
        <div class="wr-addr" title="${isWatching?'Unwatch':'Watch'}" onclick="event.stopPropagation();toggleWatch('${w.pubkey}')">${isWatching?'◎ ':''}${shortAddr(w.pubkey)}</div>
        <div style="font-size:8px;color:var(--muted);font-family:var(--mono);margin-top:2px">${tierLabel} · <span style="color:${confColor}">${confidence} conf</span></div>
      </div>
      <div style="text-align:right">
        <div class="wr-score" style="color:${scoreColor}">${w.score}</div>
        <div style="font-size:9px;color:var(--muted);font-family:var(--mono)">score</div>
      </div>
      <div class="wr-wr" style="color:${wrColor}">${w.winRate.toFixed(1)}%</div>
      <div class="wr-pnl" style="color:var(--muted)">${w.wins}W/${w.losses}L</div>
      <div class="wr-trades">${w.total}</div>
      <div class="wr-badges">
        <span class="period-badge" style="background:rgba(0,212,229,.1);color:var(--c)">${w.total} obs</span>
      </div>`;
    el.appendChild(row);
  });
}

/* ── Toggle watch ── */
function toggleWatch(pubkey) {
  if (radarWatching.has(pubkey)) radarWatching.delete(pubkey);
  else radarWatching.add(pubkey);
  localStorage.setItem('omega_watching', JSON.stringify([...radarWatching]));
  document.getElementById('wr-watching').textContent = radarWatching.size;
  renderWalletTable();
  toast(radarWatching.has(pubkey) ? `Watching ${shortAddr(pubkey)}` : `Unwatched ${shortAddr(pubkey)}`);
}

/* ── Render signal feed ── */
function renderSignalFeed() {
  const el        = document.getElementById('signal-feed-body');
  const filterVal = document.getElementById('sf-filter').value;
  let alerts      = [...radarAlerts];
  if (filterVal === 'agree') alerts = alerts.filter(a => a.omegaAgrees);
  if (filterVal === 'elite') alerts = alerts.filter(a => a.wallet?.tier === 'high');

  if (!alerts.length) {
    el.innerHTML = `<div class="empty">No signals yet<br><span style="color:var(--faint)">Watching for elite wallet bets on 5m crypto markets</span></div>`;
    return;
  }

  el.innerHTML = '';
  alerts.slice(0, 50).forEach(a => {
    const wAddr   = shortAddr(a.pubkey);
    const tierStr = a.wallet?.tier === 'high' ? '★★★' : a.wallet?.tier === 'med' ? '★★' : '★';
    const agoStr  = a.secAgo<60 ? a.secAgo+'s ago' : Math.round(a.secAgo/60)+'m ago';
    const isNew   = (Date.now() - a.ts) < 120000;
    const wrLabel = a.wallet ? `${a.wallet.winRate.toFixed(0)}%WR` : '';

    let omegaBadge = '';
    if (a.omegaCall && a.omegaCall.call !== 'SKIP') {
      omegaBadge = `<span class="se-omega-badge ${a.omegaAgrees?'se-omega-bull':'se-omega-skip'}">${a.omegaAgrees?'Ω AGREES':'Ω skip'}</span>`;
    }

    const staleHtml = a.stale ? `<span class="se-staleness">⚠ ${a.staleMssg}</span>` : '';
    const copyBtnClass = a.omegaAgrees && !a.stale ? 'se-copy-btn agree' : 'se-copy-btn';

    const div = document.createElement('div');
    div.className = `signal-event${isNew?' new-alert':''}${a.omegaAgrees?' has-omega':''}`;
    div.innerHTML = `
      <div class="se-top">
        <span class="se-wallet">${tierStr} ${wAddr}</span>
        ${wrLabel ? `<span style="font-size:8px;color:var(--muted);font-family:var(--mono)">[${wrLabel} · ${a.wallet?.total||0} obs]</span>` : ''}
        <span class="se-time">${agoStr}</span>
      </div>
      <div class="se-market">${a.market}</div>
      <div class="se-meta">
        <span class="se-side ${a.side==='yes'?'ty':'tn'}">${a.side.toUpperCase()}</span>
        <span class="se-amt" style="color:${a.side==='yes'?'var(--g)':'var(--r)'}">$${a.amount.toFixed(0)}</span>
        <span class="se-price">@ $${a.price.toFixed(2)}</span>
        ${omegaBadge}
        ${staleHtml}
        ${!a.stale
          ? `<button class="${copyBtnClass}" data-aid="${a.id}">${a.omegaAgrees?'⚡ Copy':'Copy'}</button>`
          : '<span class="se-staleness">skip</span>'
        }
      </div>`;

    if (!a.stale) {
      const btn = div.querySelector('[data-aid]');
      if (btn) btn.addEventListener('click', () => copyTrade(a));
    }
    el.appendChild(div);
  });
}

/* ── Copy trade ── */
function copyTrade(alert) {
  const tierStr   = alert.wallet?.tier === 'high' ? '★★★ ' : '★ ';
  const wrInfo    = alert.wallet ? ` · ${alert.wallet.winRate.toFixed(0)}%WR (${alert.wallet.total} obs)` : '';
  const whaleInfo = `${tierStr}${shortAddr(alert.pubkey)}${wrInfo} · ${alert.omegaAgrees?'Ω agrees':'manual copy'}`;
  openBet(alert.marketId, alert.side, alert.price, alert.market, alert.closeTime, whaleInfo);
}

/* ── Wallet detail ── */
function openWalletDetail(w) {
  document.getElementById('wallet-detail').style.display = 'block';
  document.getElementById('wd-addr').textContent = w.pubkey;

  const scoreColor = w.score>=70?'var(--y)':w.score>=50?'var(--g)':'var(--b)';
  document.getElementById('wd-stats').innerHTML = `
    <div class="wd-stat"><div class="wd-stat-l">Score</div><div class="wd-stat-v" style="color:${scoreColor}">${w.score}</div></div>
    <div class="wd-stat"><div class="wd-stat-l">Win rate</div><div class="wd-stat-v" style="color:${w.winRate>=56?'var(--g)':'var(--y)'}">${w.winRate.toFixed(1)}%</div></div>
    <div class="wd-stat"><div class="wd-stat-l">Record</div><div class="wd-stat-v" style="color:var(--text)">${w.wins}W / ${w.losses}L</div></div>
    <div class="wd-stat"><div class="wd-stat-l">Observations</div><div class="wd-stat-v" style="color:var(--c)">${w.total}</div></div>`;

  const history = radarAlerts.filter(a => a.pubkey === w.pubkey).slice(0, 8);
  const histEl  = document.getElementById('wd-hist');
  if (!history.length) {
    histEl.innerHTML = `<div style="font-size:10px;color:var(--faint);font-family:var(--mono);padding:8px 0">No alerts captured this session</div>`;
    return;
  }
  histEl.innerHTML = history.map(a => {
    const agoStr = a.secAgo<60 ? a.secAgo+'s' : Math.round(a.secAgo/60)+'m';
    return `<div class="wd-hist-row">
      <span class="tr-side ${a.side==='yes'?'ty':'tn'}" style="font-size:8px;padding:2px 5px">${a.side.toUpperCase()}</span>
      <span style="flex:1;font-size:10px;font-family:var(--mono);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.market}</span>
      <span style="font-size:10px;font-family:var(--mono);color:${a.omegaAgrees?'var(--g)':'var(--muted)'};flex-shrink:0;margin-left:8px">${a.omegaAgrees?'Ω':'—'}</span>
      <span style="font-size:9px;color:var(--muted);font-family:var(--mono);flex-shrink:0;margin-left:8px">${agoStr}</span>
    </div>`;
  }).join('');
}

function closeWalletDetail() {
  document.getElementById('wallet-detail').style.display = 'none';
}

/* ── Clear alerts ── */
function radarClearAlerts() {
  radarAlerts = [];
  document.getElementById('wr-alerts-count').textContent = '0';
  document.getElementById('wr-agree').textContent        = '—';
  document.getElementById('hs-alerts').textContent       = '0';
  renderSignalFeed();
  toast('Alerts cleared');
}

/* ── Reset all observed data ── */
function radarResetData() {
  if (!confirm('Reset all observed wallet data? This cannot be undone.')) return;
  radarState = _emptyState();
  _saveRadarState();
  radarAlerts = [];
  renderWalletTable();
  renderSignalFeed();
  _updateRadarStats();
  toast('Radar data reset');
}

/* ── Main radar refresh ── */
async function radarRefresh() {
  if (radarRefreshing) return;
  radarRefreshing = true;
  document.getElementById('radar-wrap').classList.add('radar-refreshing');
  document.getElementById('radar-btn').textContent = '◎ Scanning...';
  setAlertTicker('Scanning live 5m crypto trades for wallet patterns...');

  try {
    await pollTrades();
  } finally {
    radarRefreshing = false;
    document.getElementById('radar-wrap').classList.remove('radar-refreshing');
    document.getElementById('radar-btn').textContent = '◎ Radar';
  }

  if (!radarPollTimer) {
    radarPollTimer = setInterval(pollTrades, RADAR_POLL_MS);
  }
  if (Notification.permission === 'default') Notification.requestPermission();
}
