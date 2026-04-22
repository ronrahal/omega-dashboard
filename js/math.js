/* js/math.js — 13 signal calculations + Bayesian fusion + Entropy Kelly */

/* ── Classic 8 ── */
function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  let ag = g/p, al = l/p;
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1], gn = d>0?d:0, ln = d<0?-d:0;
    ag = (ag*(p-1)+gn)/p;
    al = (al*(p-1)+ln)/p;
  }
  return al === 0 ? 100 : 100 - (100/(1+ag/al));
}

function calcStochRSI(closes, rp=14, sp=14, kp=3, dp=3) {
  if (closes.length < rp+sp+kp+dp) return { k:50, d:50 };
  const rs = [];
  for (let i = rp; i <= closes.length-1; i++) rs.push(calcRSI(closes.slice(0, i+1), rp));
  if (rs.length < sp) return { k:50, d:50 };
  const sma = (a, n) => a.slice(-n).reduce((x,y) => x+y, 0) / n;
  const ss = [];
  for (let i = sp-1; i < rs.length; i++) {
    const sl = rs.slice(i-sp+1, i+1), mn = Math.min(...sl), mx = Math.max(...sl);
    ss.push(mx===mn ? 50 : (rs[i]-mn)/(mx-mn)*100);
  }
  const ks = [];
  for (let i = kp-1; i < ss.length; i++) ks.push(sma(ss.slice(0, i+1), kp));
  if (ks.length < dp) return { k: ks[ks.length-1]||50, d:50 };
  return { k: ks[ks.length-1], d: sma(ks, dp) };
}

function calcVWAP(candles) {
  if (!candles || candles.length < 2) return { vwap:0, dev:0, sigma:0 };
  let sv = 0, spv = 0;
  const typ = candles.map(c => (c.h+c.l+c.c)/3);
  candles.forEach((c,i) => { sv += c.v; spv += typ[i]*c.v; });
  const vwap = spv/sv, last = typ[typ.length-1];
  const sigma = Math.sqrt(typ.reduce((a,t) => a+(t-vwap)**2, 0)/typ.length) || 1e-10;
  return { vwap, sigma, dev: (last-vwap)/sigma };
}

function calcBB(closes, p=20, mult=2) {
  if (closes.length < p) return 0.5;
  const sl = closes.slice(-p), mean = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/p);
  const upper = mean+mult*std, lower = mean-mult*std, price = closes[closes.length-1];
  return upper===lower ? 0.5 : (price-lower)/(upper-lower);
}

function ema(arr, n) {
  const k = 2/(n+1); let e = arr[0];
  for (let i=1; i<arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function calcEMAribbon(closes) {
  if (closes.length < 21) return { score:0, e5:0, e8:0, e13:0, e21:0 };
  const e5=ema(closes,5), e8=ema(closes,8), e13=ema(closes,13), e21=ema(closes,21);
  return { score: e5>e8&&e8>e13&&e13>e21 ? 1 : e5<e8&&e8<e13&&e13<e21 ? -1 : 0, e5, e8, e13, e21 };
}

function calcVolSpike(candles) {
  if (!candles || candles.length < 5) return 1;
  const vols = candles.map(c => c.v);
  const avg = ema(vols.slice(0,-1), 20);
  return avg > 0 ? vols[vols.length-1]/avg : 1;
}

function calcHurst(closes) {
  if (closes.length < 16) return 0.5;
  const lags = [4, 8, 16].filter(l => l < closes.length);
  const rs = lags.map(lag => {
    const chunks = Math.floor(closes.length/lag); let s = 0;
    for (let c = 0; c < chunks; c++) {
      const seg = closes.slice(c*lag,(c+1)*lag), mean = seg.reduce((a,b)=>a+b,0)/seg.length;
      const dev = seg.map(x => x-mean); let cum=0, hi=-Infinity, lo=Infinity;
      dev.forEach(d => { cum+=d; hi=Math.max(hi,cum); lo=Math.min(lo,cum); });
      const S = Math.sqrt(dev.reduce((a,d)=>a+d*d,0)/dev.length) || 1e-10;
      s += (hi-lo)/S;
    }
    return s/chunks;
  });
  const ll=lags.map(l=>Math.log(l)), lr=rs.map(r=>Math.log(r));
  const n=ll.length, ml=ll.reduce((a,b)=>a+b,0)/n, mr=lr.reduce((a,b)=>a+b,0)/n;
  const num=ll.reduce((a,x,i)=>a+(x-ml)*(lr[i]-mr),0), den=ll.reduce((a,x)=>a+(x-ml)**2,0);
  return den===0 ? 0.5 : Math.min(1,Math.max(0,num/den));
}

const TRANS = { uu:.52, ud:.48, du:.48, dd:.52 };
function calcMarkov(candles) {
  if (!candles || candles.length < 3) return 0.5;
  const dirs = candles.slice(-5).map((c,i,a) => i===0?null:c.c>a[i-1].c?'u':'d').filter(Boolean);
  if (dirs.length < 2) return 0.5;
  return TRANS[dirs[dirs.length-2]+dirs[dirs.length-1]] ?? 0.5;
}

/* ── New 5 signals ── */
function obiToProb(obi, side) {
  if (obi === null) return 0.5;
  const p = 0.5 + Math.min(0.9,Math.max(-0.9,obi))*0.25;
  return side==='yes' ? p : 1-p;
}

function cvdToProb(cvd, side) {
  if (cvd === null) return 0.5;
  const p = 0.5 + Math.min(0.8,Math.max(-0.8,cvd))*0.2;
  return side==='yes' ? p : 1-p;
}

function frToProb(fr, side) {
  if (fr === null) return 0.5;
  const p = 0.5 - Math.min(1,Math.max(-1,fr/0.001))*0.15;
  return side==='yes' ? p : 1-p;
}

function oiToProb(oidelta, priceDelta, side) {
  if (oidelta === null) return 0.5;
  const aligned = (priceDelta>0&&oidelta>0)||(priceDelta<0&&oidelta<0);
  const mag = Math.min(0.12, Math.abs(oidelta)*5);
  const p = 0.5 + (aligned?mag:-mag);
  const pDir = priceDelta>0 ? p : 1-p;
  return side==='yes' ? pDir : 1-pDir;
}

function mtfRSIProb(closes1m, closes15m, closes1h, side) {
  if (!closes15m || !closes1h) return 0.5;
  const rsi1m=calcRSI(closes1m), rsi15m=calcRSI(closes15m), rsi1h=calcRSI(closes1h);
  const above50=[rsi1m>50,rsi15m>50,rsi1h>50].filter(Boolean).length;
  const below50=[rsi1m<50,rsi15m<50,rsi1h<50].filter(Boolean).length;
  let p=0.5;
  if(above50===3) p=0.5+(Math.min(rsi1m,rsi15m,rsi1h)-50)/100*0.6;
  else if(below50===3) p=0.5-(50-Math.max(rsi1m,rsi15m,rsi1h))/100*0.6;
  else if(above50===2) p=0.54;
  else if(below50===2) p=0.46;
  p=Math.min(0.78,Math.max(0.22,p));
  return side==='yes' ? p : 1-p;
}

/* ── Bayesian fusion ── */
function logOdds(p)  { return Math.log(Math.max(.001,Math.min(.999,p)) / (1-Math.max(.001,Math.min(.999,p)))); }
function fromLogOdds(lo) { return 1/(1+Math.exp(-lo)); }
function bayesFuse(probs, prior=0.5) {
  const lp = logOdds(prior); let lo = lp;
  probs.forEach(p => { lo += logOdds(p) - lp; });
  return fromLogOdds(lo);
}

/* ── Entropy Kelly ── */
function calcEntropy(probs) {
  const n = probs.length; if (n===0) return 1;
  let H = 0;
  probs.forEach(p => { const pc=Math.max(.001,Math.min(.999,p)); H -= pc*Math.log2(pc)+(1-pc)*Math.log2(1-pc); });
  return Math.min(1, H/n);
}
function calcEV(p, price, vig=VIG) { const b=(1/price)-1; return p*b-(1-p)*1-vig; }
function calcKelly(p, price) { const b=(1/price)-1; if(b<=0) return 0; return Math.max(0,(p*b-(1-p))/b); }

/* ── Rolling percentile ── */
let scoreHistory = [];
function updateScoreHistory(score) {
  scoreHistory.push(score);
  if (scoreHistory.length > 40) scoreHistory.shift();
}
function getPercentile(score) {
  if (scoreHistory.length < 5) return null;
  return Math.round(scoreHistory.filter(s=>s<=score).length / scoreHistory.length * 100);
}
