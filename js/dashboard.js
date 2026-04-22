/* js/dashboard.js — Signal Board (conviction cards) + detail panel + trades/lb */

let mktTimers   = [];
let selectedMid = null;
let midPriceInt = null;
let lastScored  = [];

/* ═══════════════════════════════════════════════
   LOAD + SCORE MARKETS
═══════════════════════════════════════════════ */
async function loadMarkets() {
  const el   = document.getElementById('mkt-list');
  const st   = document.getElementById('mkt-status');
  const chip = document.getElementById('status-chip');

  try {
    const data   = await japi('/events?filter=live&includeMarkets=true&category=crypto&end=80');
    const events = (data.data || []).filter(isCrypto);
    const rows   = [];
    for (const ev of events) {
      for (const mkt of (ev.markets || [])) {
        if (mkt.status !== 'open') continue;
        // Debug: log first market structure
        if (rows.length === 0) console.log('MARKET SAMPLE:', JSON.stringify(mkt, null, 2));
        rows.push({ ev, mkt });
      }
    }
    rows.sort((a,b) => msLeft(a.mkt.closeTime) - msLeft(b.mkt.closeTime));

    chip.textContent = 'LIVE';
    chip.className   = 'status-pill sp-live';
    st.textContent   = rows.length + ' open';

    if (!rows.length) {
      el.innerHTML = `<div class="empty">No live crypto markets right now</div>`;
      return;
    }

    const assets = [...new Set(rows.map(({ ev, mkt }) =>
      getAsset((ev.metadata?.title||'') + (mkt.metadata?.title||''))
    ))];
    await Promise.all(assets.map(a => refreshPriceCache(a)));

    mktTimers.forEach(t => clearInterval(t));
    mktTimers = [];

    const scored = await Promise.all(rows.map(async ({ ev, mkt }) => {
      const asset = getAsset((ev.metadata?.title||'') + (mkt.metadata?.title||''));
      const [yesR, noR] = await Promise.all([
        runOmega(mkt, asset, 'yes'),
        runOmega(mkt, asset, 'no'),
      ]);
      const ms       = msLeft(mkt.closeTime);
      const callData = buildCall(yesR, noR, mkt, asset, ms);
      updateScoreHistory(Math.max(yesR.pEdge, noR.pEdge));
      const timeFactor = Math.min(1, ms / 120000);
      const conviction = callData.side
        ? (callData.r.pEdge - 0.5) * 2 * (1 + callData.r.ev * 10) * timeFactor
        : 0;
      return { ev, mkt, asset, yesR, noR, callData, conviction };
    }));

    lastScored = scored;

    const actionable = scored.filter(s => s.callData.confidence >= 2);
    const bulls   = actionable.filter(s => s.callData.side === 'yes').length;
    const bears   = actionable.filter(s => s.callData.side === 'no').length;
    const avgEdge = scored.length ? scored.reduce((a,s) => a + Math.max(s.yesR.pEdge, s.noR.pEdge), 0) / scored.length : 0;
    const bestEV  = scored.length ? Math.max(...scored.map(s => Math.max(s.yesR.ev, s.noR.ev))) : 0;
    const topCard = scored.filter(s => s.callData.confidence === 3).sort((a,b) => b.conviction - a.conviction)[0];

    document.getElementById('hs-live').textContent  = rows.length;
    document.getElementById('hs-bull').textContent  = bulls;
    document.getElementById('hs-bear').textContent  = bears;
    document.getElementById('hs-omega').textContent = pct(avgEdge);
    document.getElementById('hs-ev').textContent    = fmt(bestEV * 100, 1) + '¢';
    document.getElementById('hs-top').textContent   = topCard
      ? ((ASSETS[topCard.asset]||ASSETS.sol).label + ' ' + topCard.callData.call) : '—';

    renderSignalBoard(scored);

  } catch(e) {
    el.innerHTML = `<div class="empty" style="color:var(--r)">API error: ${e.message}</div>`;
    chip.textContent = 'ERROR';
    chip.className   = 'status-pill';
    st.textContent   = 'error';
  }
}

/* ═══════════════════════════════════════════════
   SIGNAL BOARD — conviction card grid
═══════════════════════════════════════════════ */
function renderSignalBoard(scored) {
  const el = document.getElementById('mkt-list');
  el.innerHTML = '';
  el.className = 'signal-board';

  const sorted = [...scored].sort((a, b) => {
    if (a.callData.confidence >= 2 && b.callData.confidence < 2) return -1;
    if (b.callData.confidence >= 2 && a.callData.confidence < 2) return  1;
    return b.conviction - a.conviction;
  });

  sorted.forEach((s) => {
    const { ev: evt, mkt, asset, callData, yesR, noR } = s;
    const ac    = ASSETS[asset] || ASSETS.sol;
    const title = (evt.metadata?.title||'').replace(/up or down/i,'').trim() || ac.label;
    const sub   = mkt.metadata?.title || '';
    const ct    = mkt.closeTime;
    const ms0   = msLeft(ct);
    const r     = callData.r || (yesR.pEdge >= noR.pEdge ? yesR : noR);
    const yp    = normPrice(mkt.pricing?.buyYesPriceUsd);
    const np    = normPrice(mkt.pricing?.buyNoPriceUsd);
    const isAlpha      = callData.confidence === 3;
    const isActionable = callData.confidence >= 2;
    const isBull       = callData.side === 'yes';
    const isSkip       = !callData.side;
    const tid   = 'ct-' + mkt.marketId.replace(/[^a-z0-9]/gi, '_');

    const card = document.createElement('div');
    card.className = 'sc-card'
      + (isAlpha      ? ' sc-alpha'  : '')
      + (isActionable && !isAlpha ? ' sc-action' : '')
      + (isSkip       ? ' sc-skip'   : '')
      + (selectedMid === mkt.marketId ? ' sc-selected' : '');
    card.id = 'card-' + mkt.marketId.replace(/[^a-z0-9]/gi, '_');
    card.onclick = () => selectMarket(mkt, evt, asset, yesR, noR, callData);

    if (isSkip) {
      card.innerHTML = `
        <div class="sc-skip-inner">
          <div class="sc-asset-tag" style="background:${ac.bg};color:${ac.tx}">${ac.label}</div>
          <div class="sc-skip-title">${title}</div>
          <div class="sc-skip-reason">${callData.reason}</div>
          <div class="sc-timer-sm ${tc(ms0)}" id="${tid}">${fmtTime(ms0)}</div>
        </div>`;
    } else {
      const betPrice   = isBull ? yp : np;
      const ev100      = (r.ev * 100).toFixed(1);
      const kellyBet   = Math.max(0.5, (r.entropyKelly * BANK)).toFixed(2);
      const oc         = omegaColor(r.pEdge);
      const signalBar  = _buildSignalBar(r, callData.side);
      const safeTitle  = (title + ' ' + sub).replace(/'/g, '');
      const topReasons = callData.signals.slice(0, 3);

      card.innerHTML = `
        <div class="sc-header">
          <div class="sc-asset-tag" style="background:${ac.bg};color:${ac.tx}">${ac.label}</div>
          ${isAlpha ? '<div class="sc-alpha-badge">ALPHA</div>' : ''}
          <div class="sc-timer ${tc(ms0)}" id="${tid}">${fmtTime(ms0)}</div>
        </div>
        <div class="sc-action-row">
          <div class="sc-direction" style="color:${isBull?'var(--g)':'var(--r)'}">
            ${isBull ? '▲ BUY YES' : '▼ BUY NO'}
          </div>
          <div class="sc-price-tag" style="border-color:${isBull?'rgba(0,229,160,.3)':'rgba(255,64,96,.3)'}">
            $${fmt(betPrice)} / share
          </div>
        </div>
        <div class="sc-title">${title}</div>
        ${sub ? `<div class="sc-sub">${sub}</div>` : ''}
        <div class="sc-metrics">
          <div class="sc-metric">
            <div class="sc-metric-l">Edge</div>
            <div class="sc-metric-v" style="color:${oc}">${pct(r.pEdge, 1)}</div>
          </div>
          <div class="sc-metric">
            <div class="sc-metric-l">EV</div>
            <div class="sc-metric-v" style="color:${r.ev>0?'var(--g)':'var(--r)'}">+${ev100}¢</div>
          </div>
          <div class="sc-metric">
            <div class="sc-metric-l">Kelly</div>
            <div class="sc-metric-v" style="color:var(--g)">$${kellyBet}</div>
          </div>
          <div class="sc-metric">
            <div class="sc-metric-l">Vol</div>
            <div class="sc-metric-v">${_fmtVol(normVol(mkt.pricing?.volume))}</div>
          </div>
        </div>
        ${signalBar}
        ${topReasons.length ? `
          <div class="sc-reasons">
            ${topReasons.map(rr => `<span class="sc-reason-tag">${rr}</span>`).join('')}
          </div>` : ''}
        <div class="sc-btn-row">
          <button class="sc-bet-btn"
            style="background:${isBull?'rgba(0,229,160,.15)':'rgba(255,64,96,.15)'};color:${isBull?'var(--g)':'var(--r)'};border-color:${isBull?'rgba(0,229,160,.4)':'rgba(255,64,96,.4)'};"
            onclick="event.stopPropagation();openBet('${mkt.marketId}','${callData.side}',${betPrice},'${safeTitle}',${ct})">
            ${isBull ? '▲ BET YES' : '▼ BET NO'} &nbsp; $${fmt(betPrice)} →
          </button>
          <button class="sc-log-btn" title="Log to QC Tracker"
            onclick="event.stopPropagation();quickLogBet('${mkt.marketId}','${callData.side}',${betPrice},'${safeTitle}',${ct},${r.pEdge.toFixed(4)},${r.ev.toFixed(4)},${r.entropyKelly.toFixed(4)},'${callData.signals.slice(0,3).join(',')}')">
            +
          </button>
        </div>`;
    }

    el.appendChild(card);

    const iv = setInterval(() => {
      const ms = msLeft(ct);
      const te = document.getElementById(tid);
      if (!te) { clearInterval(iv); return; }
      te.textContent = fmtTime(ms);
      te.className   = (isSkip ? 'sc-timer-sm ' : 'sc-timer ') + tc(ms);
      if (ms <= 0) clearInterval(iv);
    }, 1000);
    mktTimers.push(iv);
  });
}

function _buildSignalBar(r, side) {
  if (!r || !side) return '';
  const up = side === 'yes';
  const LABELS = ['Δ','RSI','SRSI','VWAP','BB','EMA','H','MKV','OBI','CVD','FR','OI','MTF'];
  const checks = [
    up ? r.delta > 0.001    : r.delta < -0.001,
    up ? r.rsi < 45         : r.rsi > 55,
    up ? r.srsiK < 50       : r.srsiK > 50,
    up ? r.vwapDev > 0      : r.vwapDev < 0,
    up ? r.bbPctB < 0.5     : r.bbPctB > 0.5,
    up ? r.emaScore === 1   : r.emaScore === -1,
    r.hurst > 0.55,
    up ? r.markov > 0.5     : r.markov < 0.5,
    r.obi !== null && (up ? r.obi > 0.1     : r.obi < -0.1),
    r.cvd !== null && (up ? r.cvd > 0.1     : r.cvd < -0.1),
    r.fr  !== null && (up ? r.fr  < -0.0002 : r.fr  > 0.0002),
    r.oid !== null && Math.abs(r.oid) > 0.005,
    up ? r.mtfRsi > 0.52    : r.mtfRsi < 0.48,
  ];
  const agree = checks.filter(Boolean).length;
  const dotColor = up ? 'var(--g)' : 'var(--r)';
  return `
    <div class="sc-sigbar-wrap">
      <div class="sc-sigbar-dots">
        ${LABELS.map((lbl, i) => `<div class="sc-sigdot ${checks[i] ? 'ssd-on' : 'ssd-off'}" style="${checks[i] ? 'background:'+dotColor : ''}" title="${lbl}"></div>`).join('')}
      </div>
      <div class="sc-sigbar-count" style="color:${agree>=9?'var(--g)':agree>=6?'var(--y)':'var(--muted)'}">
        ${agree}/13
      </div>
    </div>`;
}

function _fmtVol(v) {
  if (v >= 1000) return (v/1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}

/* ═══════════════════════════════════════════════
   SELECT MARKET → detail panel
═══════════════════════════════════════════════ */
async function selectMarket(mkt, ev, asset, yesR, noR, callData) {
  selectedMid = mkt.marketId;
  document.querySelectorAll('.sc-card').forEach(c => c.classList.remove('sc-selected'));
  const cardEl = document.getElementById('card-' + mkt.marketId.replace(/[^a-z0-9]/gi, '_'));
  if (cardEl) cardEl.classList.add('sc-selected');

  const ac    = ASSETS[asset] || ASSETS.sol;
  const title = (ev.metadata?.title||'').replace(/up or down/i,'').trim() || ac.label;
  document.getElementById('mid-asset').textContent = title;
  document.getElementById('pt-asset').textContent  = ac.label;
  document.getElementById('pt-asset').style.color  = ac.tx;

  if (midPriceInt) clearInterval(midPriceInt);
  const upd = async () => {
    await refreshPriceCache(asset);
    const pc = priceCache[asset];
    if (!pc) return;
    const d = (pc.price - pc.open5m) / pc.open5m;
    document.getElementById('pt-price').textContent = '$' + pc.price.toLocaleString('en',{maximumFractionDigits:4});
    const dEl = document.getElementById('pt-delta');
    dEl.textContent = (d>=0?'+':'') + pct(d,3) + ' vs 5m open';
    dEl.style.color = d>=0 ? 'var(--g)' : 'var(--r)';
  };
  await upd();
  midPriceInt = setInterval(upd, PRICE_MS);
  renderMath(mkt, asset, yesR, noR, callData);
}

/* ═══════════════════════════════════════════════
   MID PANEL — full signal breakdown
═══════════════════════════════════════════════ */
function renderMath(mkt, asset, yesR, noR, callData) {
  const r        = callData.r || (yesR.pEdge >= noR.pEdge ? yesR : noR);
  const yp       = normPrice(mkt.pricing?.buyYesPriceUsd);
  const np       = normPrice(mkt.pricing?.buyNoPriceUsd);
  const kellyBet = Math.max(1, (r.entropyKelly * BANK)).toFixed(2);
  const ev100    = (r.ev * 100).toFixed(2);
  const oc       = omegaColor(r.pEdge);
  const pctile   = getPercentile(r.pEdge);
  const vColor   = callData.cls.includes('bull') ? 'var(--g)'
                 : callData.cls.includes('bear') ? 'var(--r)'
                 : callData.cls.includes('wait') ? 'var(--b)' : 'var(--muted)';
  const midTitle = document.getElementById('mid-asset').textContent;

  document.getElementById('mid-body').innerHTML = `
    <div class="verdict-block">
      <div class="vb-label">Omega verdict — 5m window</div>
      <div class="vb-direction" style="color:${vColor}">${callData.call}</div>
      <div class="vb-reason">${callData.reason}${r.fallback?' · proxy mode':' · live Binance'}</div>
      <div class="vb-stats">
        <div class="vb-stat"><div class="vb-stat-l">P_edge</div><div class="vb-stat-v" style="color:${oc}">${pct(r.pEdge,2)}</div></div>
        <div class="vb-stat"><div class="vb-stat-l">EV/dollar</div><div class="vb-stat-v" style="color:${r.ev>0?'var(--g)':'var(--r)'}">${ev100>=0?'+':''}${ev100}¢</div></div>
        <div class="vb-stat"><div class="vb-stat-l">Percentile</div><div class="vb-stat-v" style="color:var(--c)">${pctile!==null?pctile+'th':'—'}</div></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px">
        <div>
          <div style="font-size:9px;color:var(--muted);margin-bottom:2px;font-weight:500;text-transform:uppercase;letter-spacing:.08em">Entropy Kelly bet</div>
          <div style="font-size:20px;font-weight:700;font-family:var(--mono);color:var(--g)">$${kellyBet}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;color:var(--muted);margin-bottom:2px;font-weight:500;text-transform:uppercase;letter-spacing:.08em">Signal entropy</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:${r.entropy<.4?'var(--g)':r.entropy<.7?'var(--y)':'var(--r)'}">
            ${(r.entropy*100).toFixed(0)}% ${r.entropy<.4?'low — bet more':r.entropy<.7?'medium':'high — reduce'}
          </div>
        </div>
      </div>
      <div class="kelly-track"><div class="kelly-fill" style="width:${Math.min(100,r.entropyKelly*400)}%"></div></div>
    </div>
    <div class="bet-btns">
      <button class="bb-yes" onclick="openBet('${mkt.marketId}','yes',${yp},'${midTitle}',${mkt.closeTime})">BET YES $${fmt(yp)} ↗</button>
      <button class="bb-no"  onclick="openBet('${mkt.marketId}','no',${np},'${midTitle}',${mkt.closeTime})">BET NO $${fmt(np)} ↗</button>
    </div>
    ${eqB('RSI-14 (Wilder)','RSI=100−100/(1+avgGain/avgLoss)',r.rsi.toFixed(1),r.rsi>70?'var(--r)':r.rsi<30?'var(--g)':'var(--b)',r.rsi,100,r.rsi>70?'Overbought':r.rsi<30?'Oversold':'Neutral','①')}
    ${eqB('Stochastic RSI %K/%D','StochRSI=(RSI−min)/(max−min)',`${r.srsiK.toFixed(1)} / ${r.srsiD.toFixed(1)}`,(r.srsiK+r.srsiD)/2>70?'var(--r)':(r.srsiK+r.srsiD)/2<30?'var(--g)':'var(--b)',null,null,`${r.srsiK>r.srsiD?'Bullish crossover':'Bearish crossover'}`,'②')}
    ${eqB('VWAP deviation','dev=(price−VWAP)/σ',(r.vwapDev>=0?'+':'')+r.vwapDev.toFixed(3)+'σ',r.vwapDev>.3?'var(--g)':r.vwapDev<-.3?'var(--r)':'var(--muted)',null,null,r.vwapDev>.5?'Stretched above VWAP':r.vwapDev<-.5?'Below VWAP':'Within 0.5σ','③')}
    ${eqB('Bollinger %B','%B=(price−lower)/(upper−lower)',(r.bbPctB*100).toFixed(1)+'%',r.bbPctB>.8?'var(--r)':r.bbPctB<.2?'var(--g)':'var(--b)',r.bbPctB*100,100,r.bbPctB>.8?'Near upper band':r.bbPctB<.2?'Near lower band':'Mid-band','④')}
    ${eqB('EMA ribbon 5/8/13/21','Bullish: EMA5>EMA8>EMA13>EMA21',r.emaScore===1?'Bullish ↑':r.emaScore===-1?'Bearish ↓':'Flat',r.emaScore===1?'var(--g)':r.emaScore===-1?'var(--r)':'var(--muted)',null,null,r.emaScore===1?'All 4 EMAs stacked bullish':r.emaScore===-1?'All 4 EMAs stacked bearish':'Mixed','⑤')}
    ${eqB('Volume spike','spike=vol/EMA20(vol)',r.volSpike.toFixed(2)+'×',r.volSpike>2?'var(--y)':r.volSpike>1.3?'var(--g)':'var(--muted)',Math.min(r.volSpike,4)/4*100,100,r.volSpike>2?'Strong spike':r.volSpike>1.3?'Elevated':'Low volume','⑥')}
    ${eqB('Hurst exponent H','H=slope of log(R/S) vs log(lag)',r.hurst.toFixed(4),r.hurst>.55?'var(--g)':r.hurst<.45?'var(--y)':'var(--muted)',r.hurst*100,100,r.hurst>.55?`H=${r.hurst.toFixed(3)} trending`:r.hurst<.45?`H=${r.hurst.toFixed(3)} mean-rev`:`H=${r.hurst.toFixed(3)} random`,'⑦')}
    ${eqB('Markov chain','P(s_t|s_{t-2},s_{t-1})',pct(r.markov),'var(--c)',null,null,`P(up)=${pct(r.markov)} · P(down)=${pct(1-r.markov)}`,'⑧')}
    ${eqB('Order Book Imbalance','OBI=(bidVol−askVol)/(bidVol+askVol)',r.obi!==null?(r.obi>=0?'+':'')+fmt(r.obi,3):'no data',r.obi!==null?(r.obi>.2?'var(--g)':r.obi<-.2?'var(--r)':'var(--muted)'):'var(--muted)',null,null,r.obi!==null?(r.obi>.3?'Strong bid pressure':r.obi<-.3?'Strong ask pressure':'Balanced'):'Unavailable','⑨',true)}
    ${eqB('CVD — Cumulative Volume Delta','CVD=Σ(buyVol−sellVol)/totalVol',r.cvd!==null?(r.cvd>=0?'+':'')+fmt(r.cvd,3):'unavailable',r.cvd!==null?(r.cvd>.1?'var(--g)':r.cvd<-.1?'var(--r)':'var(--muted)'):'var(--muted)',null,null,r.cvd!==null?(r.cvd>.2?'Net buy flow':r.cvd<-.2?'Net sell flow':'Balanced flow'):'Unavailable','⑩',true)}
    ${eqB('Funding Rate','FR>0=longs pay · extreme=reversal',r.fr!==null?((r.fr*100).toFixed(4)+'%'):'no futures',r.fr!==null?(r.fr>.0005?'var(--r)':r.fr<-.0003?'var(--g)':'var(--muted)'):'var(--muted)',null,null,r.fr!==null?(r.fr>.001?'Longs overextended':r.fr<-.0005?'Shorts squeezed':'Neutral'):'Futures N/A','⑪',true)}
    ${eqB('Open Interest Δ','OI change last 5m',r.oid!==null?((r.oid>=0?'+':'')+pct(r.oid,2)):'no futures',r.oid!==null?(Math.abs(r.oid)>.005?'var(--y)':'var(--muted)'):'var(--muted)',null,null,r.oid!==null?(r.oid>.01?'OI expanding':r.oid<-.01?'OI contracting':'OI stable'):'Futures N/A','⑫',true)}
    ${eqB('Multi-TF RSI (5m/15m/1h)','Triple timeframe RSI alignment',pct(r.mtfRsi),r.mtfRsi>.6?'var(--g)':r.mtfRsi<.4?'var(--r)':'var(--b)',null,null,r.mtfRsi>.65?'All 3 TF bullish':r.mtfRsi<.35?'All 3 TF bearish':r.mtfRsi>.55?'2/3 TF bullish':'Mixed TF','⑬',true)}
    <div class="eq-block" style="background:rgba(155,109,255,.04);border-left:2px solid var(--p)">
      <div class="eq-hdr"><span class="eq-title" style="color:var(--p)">Bayesian fusion + Entropy Kelly</span><span class="eq-val" style="color:${oc};font-size:18px">${pct(r.pEdge,2)}</span></div>
      <div class="eq-formula">P_edge=0.68·bayesFuse(all)+0.32·regime_prior</div>
      <div class="eq-interp" style="color:${oc}">EV=${ev100>=0?'+':''}${ev100}¢ · Entropy=${(r.entropy*100).toFixed(0)}% · Kelly $${kellyBet}/$${BANK}</div>
      <div class="eq-bar-bg"><div class="eq-bar-fill" style="width:${Math.min(100,r.pEdge*100)}%;background:${oc}"></div></div>
    </div>`;
}

function eqB(title, formula, valStr, color, barVal, barMax, interp, num='', isNew=false) {
  const barPct = barVal!==null && barMax ? Math.min(100, Math.round(barVal/barMax*100)) : null;
  return `<div class="eq-block${isNew?' new-sig':''}">
    <div class="eq-hdr">
      <span class="eq-num">${num}</span>
      <span class="eq-title">${title}</span>
      <span class="eq-val" style="color:${color||'var(--text)'}">${valStr}</span>
    </div>
    <div class="eq-formula">${formula}</div>
    <div class="eq-interp" style="color:${color||'var(--muted)'}">${interp}</div>
    ${barPct!==null?`<div class="eq-bar-bg"><div class="eq-bar-fill" style="width:${barPct}%;background:${color||'var(--b)'}"></div></div>`:''}
  </div>`;
}

/* ═══════════════════════════════════════════════
   TRADES + LEADERBOARD
═══════════════════════════════════════════════ */
async function loadTrades() {
  const el = document.getElementById('trades');
  try {
    const d    = await japi('/trades');
    const list = (d.data||[]).slice(0, 30);
    document.getElementById('tc').textContent = list.length;
    if (!list.length) { el.innerHTML = `<div class="empty">No trades</div>`; return; }
    el.innerHTML = '';
    list.forEach(t => {
      const iy     = t.side === 'yes';
      const ago    = t.timestamp ? Math.round((Date.now()-t.timestamp*1000)/1000) : 0;
      const agoStr = ago<60 ? ago+'s' : Math.round(ago/60)+'m';
      const w      = t.ownerPubkey ? shortAddr(t.ownerPubkey) : '?';
      const div    = document.createElement('div');
      div.className = 'tr-row';
      div.innerHTML = `
        <span class="tr-side ${iy?'ty':'tn'}">${iy?'YES':'NO'}</span>
        <div class="tr-info">
          <div class="tr-mkt">${t.marketTitle||t.eventTitle||'—'}</div>
          <div class="tr-meta">${w} · ${agoStr}</div>
        </div>
        <div class="tr-amt" style="color:${iy?'var(--g)':'var(--r)'}">$${fmt(parseFloat(t.amountUsd)||0,0)}</div>`;
      el.appendChild(div);
    });
  } catch { el.innerHTML = `<div class="empty" style="color:var(--r)">error</div>`; }
}

async function loadLB() {
  const el = document.getElementById('lb');
  const p  = document.getElementById('lbp').value;
  el.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  try {
    const d    = await japi(`/leaderboards?period=${p}&metric=pnl&limit=10`);
    const list = d.data || [];
    if (!list.length) { el.innerHTML = `<div class="empty">No data</div>`; return; }
    el.innerHTML = '';
    list.forEach((e, i) => {
      const pnl = parseFloat(e.realizedPnlUsd)||0;
      const wr  = parseFloat(e.winRatePct)||0;
      const w   = e.ownerPubkey ? shortAddr(e.ownerPubkey) : '?';
      const r   = document.createElement('div');
      r.className = 'lb-row';
      r.innerHTML = `
        <div class="lb-r">#${i+1}</div>
        <div class="lb-w" onclick="navigator.clipboard.writeText('${e.ownerPubkey||''}').then(()=>toast('Copied'))">${w}</div>
        <div class="lb-p" style="color:${pnl>=0?'var(--g)':'var(--r)'}">$${pnl>=0?'+':''}${Math.round(pnl)}</div>
        <div class="lb-wr">${fmt(wr,1)}%</div>`;
      el.appendChild(r);
    });
  } catch(e) { el.innerHTML = `<div class="empty" style="color:var(--r)">error: ${e.message}</div>`; }
}
/* ── Quick log from card ── */
function quickLogBet(mid, side, price, title, ct, pedge, ev, kelly, signals) {
  const asset = getAsset(title);
  const amt   = Math.max(0.5, parseFloat((kelly * BANK).toFixed(2)));
  const bet = {
    id:       Date.now(),
    ts:       new Date().toISOString(),
    marketId: mid,
    closeTime: ct,
    asset:    (ASSETS[asset]||ASSETS.sol).label,
    side,
    tier:     pedge >= 0.62 ? 'ALPHA' : pedge >= 0.56 ? 'BUY' : 'WATCH',
    pedge:    parseFloat((pedge*100).toFixed(2)),
    ev:       parseFloat((ev*100).toFixed(2)),
    amt,
    price,
    signals:  signals ? signals.split(',').filter(Boolean) : [],
    outcome:  'pending',
    pnl:      0,
  };
  const bets = getBets();
  // avoid double-logging same market
  if (bets.find(b => b.marketId === mid && b.side === side)) {
    toast('Already logged', 'err'); return;
  }
  bets.unshift(bet);
  saveBets(bets);
  // flash the tracker tab
  const tBtn = document.querySelector('.tab-btn[onclick*="tracker"]');
  if (tBtn) { tBtn.style.color = 'var(--g)'; setTimeout(()=>tBtn.style.color='',1500); }
  toast(`Logged ${(ASSETS[asset]||ASSETS.sol).label} ${side.toUpperCase()} $${amt}`);
}
