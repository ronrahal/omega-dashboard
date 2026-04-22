/* js/modal.js — bet modal */

let currentBet = null;

async function openBet(mid, side, price, title, ct, whaleInfo) {
  const asset = getAsset(title);
  const mkt = {
    marketId: mid,
    pricing: {
      buyYesPriceUsd: side==='yes' ? price : 1-price+.02,
      buyNoPriceUsd:  side==='no'  ? price : 1-price+.02,
    },
    closeTime: ct,
  };
  const r = await runOmega(mkt, asset, side);
  currentBet = { mid, side, price, title, ct, r, asset };

  document.getElementById('mod-title').textContent = title;
  document.getElementById('mod-sub').textContent   = 'Market: ' + mid;

  const de = document.getElementById('mod-dir');
  de.textContent  = side.toUpperCase();
  de.style.color  = side==='yes' ? 'var(--g)' : 'var(--r)';

  document.getElementById('mod-price').textContent = '$' + fmt(price);
  document.getElementById('mod-time').textContent  = fmtTime(msLeft(ct));

  const pc = priceCache[asset];
  if (pc) {
    document.getElementById('mod-live').textContent = '$' + pc.price.toLocaleString('en',{maximumFractionDigits:4});
    const d  = (pc.price - pc.open5m) / pc.open5m;
    const dEl = document.getElementById('mod-delta');
    dEl.textContent = (d>=0?'+':'') + pct(d,3) + ' vs open';
    dEl.style.color = d>=0 ? 'var(--g)' : 'var(--r)';
  }

  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) el.style.color = color;
  };

  set('mb-rsi',    fmt(r.rsi,1)+(r.rsi>70?' OB':r.rsi<30?' OS':''), r.rsi>70?'var(--r)':r.rsi<30?'var(--g)':'var(--muted)');
  set('mb-srsi',   `%K ${fmt(r.srsiK,1)} / %D ${fmt(r.srsiD,1)}`);
  set('mb-vwap',   (r.vwapDev>=0?'+':'')+fmt(r.vwapDev,3)+'σ',     r.vwapDev>.3?'var(--g)':r.vwapDev<-.3?'var(--r)':'var(--muted)');
  set('mb-bb',     fmt(r.bbPctB*100,1)+'%',                          r.bbPctB>.8?'var(--r)':r.bbPctB<.2?'var(--g)':'var(--b)');
  set('mb-ema',    r.emaScore===1?'Bullish ↑':r.emaScore===-1?'Bearish ↓':'Flat', r.emaScore===1?'var(--g)':r.emaScore===-1?'var(--r)':'var(--muted)');
  set('mb-vol',    fmt(r.volSpike,2)+'×',                             r.volSpike>2?'var(--y)':r.volSpike>1.3?'var(--g)':'var(--muted)');
  set('mb-hurst',  'H='+fmt(r.hurst,3)+(r.hurst>.55?' trend':r.hurst<.45?' mean-rev':' rand'), r.hurst>.55?'var(--g)':r.hurst<.45?'var(--y)':'var(--muted)');
  set('mb-markov', pct(r.markov));
  set('mb-obi',    r.obi!==null?(r.obi>=0?'+':'')+fmt(r.obi,3):'—', r.obi!==null?(r.obi>.2?'var(--g)':r.obi<-.2?'var(--r)':'var(--muted)'):'var(--muted)');
  set('mb-cvd',    r.cvd!==null?(r.cvd>=0?'+':'')+fmt(r.cvd,3):'—', r.cvd!==null?(r.cvd>.1?'var(--g)':r.cvd<-.1?'var(--r)':'var(--muted)'):'var(--muted)');
  set('mb-fr',     r.fr!==null?(r.fr*100).toFixed(4)+'%':'—',        r.fr!==null?(r.fr>.0005?'var(--r)':r.fr<-.0003?'var(--g)':'var(--muted)'):'var(--muted)');
  set('mb-oi',     r.oid!==null?(r.oid>=0?'+':'')+pct(r.oid,2):'—', r.oid!==null?(Math.abs(r.oid)>.005?'var(--y)':'var(--muted)'):'var(--muted)');
  set('mb-mtf',    pct(r.mtfRsi),                                     r.mtfRsi>.6?'var(--g)':r.mtfRsi<.4?'var(--r)':'var(--b)');

  const ev100 = (r.ev*100).toFixed(2);
  set('mb-pedge', pct(r.pEdge,2), omegaColor(r.pEdge));
  set('mb-ev',    (ev100>=0?'+':'')+ev100+'¢',                        r.ev>0?'var(--g)':'var(--r)');
  set('mb-ent',   (r.entropy*100).toFixed(0)+'%',                     r.entropy<.4?'var(--g)':r.entropy<.7?'var(--y)':'var(--r)');

  const rec = Math.max(1, +(r.entropyKelly*BANK).toFixed(2));
  set('mb-kelly', '$'+rec+' ('+(r.entropyKelly*100).toFixed(1)+'%)', 'var(--g)');
  document.getElementById('mod-kfill').style.width = Math.min(100,r.entropyKelly*400)+'%';
  document.getElementById('mod-amt').value = rec;

  const whaleRow = document.getElementById('mod-whale-row');
  if (whaleInfo) {
    whaleRow.style.display = 'flex';
    document.getElementById('mod-whale-signal').textContent = whaleInfo;
  } else {
    whaleRow.style.display = 'none';
  }

  updatePayout();
  document.getElementById('overlay').style.display = 'flex';
}

function updatePayout() {
  if (!currentBet) return;
  const amt   = parseFloat(document.getElementById('mod-amt').value) || 0;
  const gross = amt / currentBet.price;
  document.getElementById('mod-payout').textContent = '$' + fmt(gross);
  document.getElementById('mod-profit').textContent = '+$' + fmt(gross-amt);
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('overlay')) return;
  document.getElementById('overlay').style.display = 'none';
  currentBet = null;
}

function confirmBet() {
  if (!currentBet) return;
  const amt = parseFloat(document.getElementById('mod-amt').value) || 0;
  if (amt < 1)              { toast('Min $1', 'err'); return; }
  if (msLeft(currentBet.ct) <= 0) { toast('Market closed!', 'err'); return; }
  if (currentBet.r.ev < 0)  toast('Negative EV — risky', 'err');
  window.open('https://jup.ag/prediction/' + currentBet.mid, '_blank');
  toast('Opening Jupiter — confirm in Phantom');
  document.getElementById('overlay').style.display = 'none';
}
