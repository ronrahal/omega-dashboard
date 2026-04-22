/* js/omega.js — master engine: runOmega + buildCall */

async function runOmega(mkt, assetKey, side) {
  const price    = normPrice(side==='yes' ? mkt.pricing?.buyYesPriceUsd : mkt.pricing?.buyNoPriceUsd);
  const priorYes = normPrice(mkt.pricing?.buyYesPriceUsd);
  const prior    = side==='yes' ? priorYes : 1-priorYes;
  const pc       = priceCache[assetKey];

  if (!pc || !pc.candles1m || pc.candles1m.length < 21) {
    const ev=calcEV(prior,price), k=calcKelly(prior,price);
    return { rsi:50,srsiK:50,srsiD:50,vwapDev:0,bbPctB:.5,emaScore:0,volSpike:1,
      hurst:.5,markov:.5,obi:null,cvd:null,fr:null,oid:null,mtfRsi:.5,
      pEdge:prior,ev,kelly:k,entropyKelly:k*.5,entropy:1,
      livePrice:null,delta:0,Z:0,fallback:true };
  }

  const closes = pc.candles1m.map(c => c.c);
  const live   = pc.price;
  const delta  = (live - pc.open5m) / pc.open5m;
  const atr5m  = (ASSETS[assetKey]||ASSETS.sol).dv / Math.sqrt(288);
  const Z      = delta / atr5m;

  const rsi                = calcRSI(closes);
  const { k:srsiK, d:srsiD } = calcStochRSI(closes);
  const { dev:vwapDev }    = calcVWAP(pc.candles1m);
  const bbPctB             = calcBB(closes);
  const { score:emaScore } = calcEMAribbon(closes);
  const volSpike           = calcVolSpike(pc.candles1m);
  const hurst              = calcHurst(closes);
  const markov             = calcMarkov(pc.candles1m);

  const up = side === 'yes';
  const pDelta  = up ? 1/(1+Math.exp(-2.8*Z)) : 1/(1+Math.exp(2.8*Z));
  const pRSI    = up ? (rsi>70?.37:rsi<30?.73:.5+(rsi-50)/100*-.28) : (rsi>70?.73:rsi<30?.37:.5-(rsi-50)/100*-.28);
  const sv      = (srsiK+srsiD)/2;
  const pStoch  = up ? (sv>80?.34:.5+(50-sv)/100*.48) : (sv>80?.74:.5-(50-sv)/100*.48);
  const pVWAP   = up ? Math.min(.82,Math.max(.18,.5+vwapDev*.12)) : Math.min(.82,Math.max(.18,.5-vwapDev*.12));
  const pBB     = up ? (bbPctB>.8?.35:bbPctB<.2?.73:.5+(0.5-bbPctB)*.38) : (bbPctB>.8?.73:bbPctB<.2?.35:.5-(0.5-bbPctB)*.38);
  const pEMA    = up ? (emaScore===1?.67:emaScore===-1?.33:.5) : (emaScore===1?.33:emaScore===-1?.67:.5);
  const pHurst  = Math.min(.82,Math.max(.18, up
    ? (hurst>.55 ? .5+delta*10*hurst*.3 : hurst<.45 ? .5-delta*10*(1-hurst)*.3 : .5)
    : (hurst>.55 ? .5-delta*10*hurst*.3 : hurst<.45 ? .5+delta*10*(1-hurst)*.3 : .5)));
  const pMarkov = up ? markov : 1-markov;

  const pOBI = obiToProb(pc.obi,  side);
  const pCVD = cvdToProb(pc.cvd,  side);
  const pFR  = frToProb(pc.fr,    side);
  const pOI  = oiToProb(pc.oid, delta, side);
  const closes15m = pc.candles15m ? pc.candles15m.map(c=>c.c) : null;
  const closes1h  = pc.candles1h  ? pc.candles1h.map(c=>c.c)  : null;
  const pMTF = mtfRSIProb(closes, closes15m, closes1h, side);

  const allProbs = [
    ...Array(3).fill(pDelta),
    ...Array(2).fill(pRSI),
    ...Array(2).fill(pStoch),
    ...Array(2).fill(pOBI),
    ...Array(2).fill(pCVD),
    pVWAP, pBB, pEMA, pHurst, pMarkov, pFR, pOI, pMTF,
  ];

  const regimePrior = hurst > .58
    ? (delta>0 ? Math.min(.65,prior+.05) : Math.max(.35,prior-.05))
    : hurst < .42
    ? (delta>0 ? Math.max(.35,prior-.04) : Math.min(.65,prior+.04))
    : prior;

  const raw   = bayesFuse(allProbs, regimePrior);
  const pEdge = 0.68*raw + 0.32*regimePrior;

  const signalProbs = [pDelta,pRSI,pStoch,pVWAP,pBB,pEMA,pHurst,pMarkov,pOBI,pCVD,pFR,pOI,pMTF];
  const entropy         = calcEntropy(signalProbs);
  const entropyMultiplier = 1 - entropy*.6;
  const kelly           = calcKelly(pEdge, price);
  const entropyKelly    = kelly * entropyMultiplier * .5;
  const ev              = calcEV(pEdge, price);

  return {
    rsi,srsiK,srsiD,vwapDev,bbPctB,emaScore,volSpike,hurst,markov,
    obi:pc.obi,cvd:pc.cvd,fr:pc.fr,oid:pc.oid,mtfRsi:pMTF,
    pEdge,ev,kelly,entropyKelly,entropy,
    livePrice:live,delta,Z,
    pDelta,pRSI,pStoch,pVWAP,pBB,pEMA,pHurst,pMarkov,pOBI,pCVD,pFR,pOI,
    regimePrior,fallback:false,
  };
}

function buildCall(yesR, noR, mkt, assetKey, ms) {
  const yesOk = yesR.pEdge >= MIN_EDGE && yesR.ev >= MIN_EV;
  const noOk  = noR.pEdge  >= MIN_EDGE && noR.ev  >= MIN_EV;

  if (!yesOk && !noOk) {
    const r = yesR;
    const skipReason =
      r.hurst>.45&&r.hurst<.55 ? 'Random walk regime — no edge' :
      Math.abs(r.delta)<.0005  ? 'Price pinned at window open'  :
      r.volSpike<.7            ? 'Volume collapse — direction unclear' :
      r.ev<0                   ? 'Negative EV after vig' : 'Insufficient edge';
    return { side:null, call:'SKIP', cls:'cta-skip', reason:skipReason, ev:0, r:yesR, confidence:0, signals:[] };
  }

  let side, r;
  if (yesOk && (!noOk || yesR.ev >= noR.ev)) { side='yes'; r=yesR; }
  else { side='no'; r=noR; }

  const ev100 = (r.ev*100).toFixed(1);
  const signals = [];
  if (side==='yes') {
    if (r.delta>.001)       signals.push(`+${(r.delta*100).toFixed(2)}% window delta`);
    if (r.rsi<32)           signals.push(`RSI ${r.rsi.toFixed(0)} oversold`);
    if (r.rsi>68)           signals.push(`RSI ${r.rsi.toFixed(0)} — fade`);
    if (r.emaScore===1)     signals.push('EMA ribbon bullish');
    if (r.vwapDev>.4)       signals.push(`+${r.vwapDev.toFixed(2)}σ VWAP`);
    if (r.hurst>.58)        signals.push(`H=${r.hurst.toFixed(2)} trending`);
    if (r.volSpike>1.8)     signals.push(`${r.volSpike.toFixed(1)}× vol`);
    if (r.obi!==null&&r.obi>.2)  signals.push(`OBI +${(r.obi*100).toFixed(0)}% bid`);
    if (r.cvd!==null&&r.cvd>.15) signals.push('CVD buy flow');
  } else {
    if (r.delta<-.001)      signals.push(`${(r.delta*100).toFixed(2)}% momentum`);
    if (r.rsi>68)           signals.push(`RSI ${r.rsi.toFixed(0)} overbought`);
    if (r.emaScore===-1)    signals.push('EMA ribbon bearish');
    if (r.vwapDev<-.4)      signals.push(`${r.vwapDev.toFixed(2)}σ VWAP`);
    if (r.hurst>.58)        signals.push(`H=${r.hurst.toFixed(2)} trending`);
    if (r.obi!==null&&r.obi<-.2)  signals.push(`OBI ${(r.obi*100).toFixed(0)}% ask`);
    if (r.cvd!==null&&r.cvd<-.15) signals.push('CVD sell flow');
    if (r.fr!==null&&r.fr>.0005)  signals.push('FR longs overextended');
  }

  const reason = signals.slice(0,2).join(' · ') || `EV +${ev100}¢ · edge ${(r.pEdge*100).toFixed(1)}%`;
  let call, cls, confidence;

  if (r.pEdge>=.62&&r.entropyKelly>.05) {
    call=`BUY ${side.toUpperCase()}`; cls=side==='yes'?'cta-bull':'cta-bear'; confidence=3;
  } else if (r.pEdge>=.56) {
    call=side==='yes'?'LONG YES':'LONG NO'; cls=side==='yes'?'cta-bull':'cta-bear'; confidence=2;
  } else {
    call='WATCH'; cls='cta-wait'; confidence=1;
  }

  if (ms<90000&&Math.abs(r.delta)>.002&&r.pEdge>.58) {
    call=side==='yes'?'⚡ BUY YES':'⚡ BUY NO'; confidence=3;
  }

  return { side, call, cls, reason, ev:r.ev, r, confidence, signals };
}

function omegaColor(p) {
  return p>=.62?'var(--g)':p>=.56?'var(--y)':p>=.535?'var(--b)':'var(--muted)';
}
