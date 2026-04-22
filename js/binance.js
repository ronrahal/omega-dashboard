/* js/binance.js — all Binance API calls + price cache */

let priceCache = {};

async function fetchCandles(sym, interval = '1m', limit = 60) {
  try {
    const d = await bfetch(`${BINANCE}/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
    return d.map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }));
  } catch { return null; }
}

async function fetchLivePrice(sym) {
  try {
    const d = await bfetch(`${BINANCE}/ticker/price?symbol=${sym}`);
    return +d.price;
  } catch { return null; }
}

async function fetchOBI(sym) {
  try {
    const d = await bfetch(`${BINANCE}/depth?symbol=${sym}&limit=10`);
    const bidVol = d.bids.slice(0,5).reduce((a,b) => a + +b[1], 0);
    const askVol = d.asks.slice(0,5).reduce((a,b) => a + +b[1], 0);
    const total = bidVol + askVol;
    return total === 0 ? 0 : (bidVol - askVol) / total;
  } catch { return null; }
}

async function fetchCVD(sym, limit = 200) {
  try {
    const d = await bfetch(`${BINANCE}/aggTrades?symbol=${sym}&limit=${limit}`);
    let cvd = 0;
    d.forEach(t => { const vol = +t.q; cvd += t.m ? -vol : vol; });
    const totalVol = d.reduce((a,t) => a + +t.q, 0);
    return totalVol === 0 ? 0 : cvd / totalVol;
  } catch { return null; }
}

async function fetchFundingRate(fsym) {
  if (!fsym) return null;
  try {
    const d = await bfetch(`${BFUT}/premiumIndex?symbol=${fsym}`);
    return parseFloat(d.lastFundingRate) || 0;
  } catch { return null; }
}

async function fetchOIDelta(fsym){
  if(!fsym) return null;
  try{
    const d = await bfetch(`${BFUT}/openInterest?symbol=${fsym}`);
    return null; // single snapshot only, no delta without history endpoint
  }catch{ return null; }
}

async function fetchMTFCandles(sym) {
  try {
    const [c15m, c1h] = await Promise.all([
      fetchCandles(sym, '15m', 30),
      fetchCandles(sym, '1h', 20),
    ]);
    return { c15m, c1h };
  } catch { return { c15m: null, c1h: null }; }
}

async function refreshPriceCache(assetKey) {
  const ac = ASSETS[assetKey] || ASSETS.sol;
  const [c1m, c5m, live, obi, cvd, fr, oid, mtf] = await Promise.all([
    fetchCandles(ac.sym, '1m', 60),
    fetchCandles(ac.sym, '5m', 20),
    fetchLivePrice(ac.sym),
    fetchOBI(ac.sym),
    fetchCVD(ac.sym),
    fetchFundingRate(ac.fsym),
    fetchOIDelta(ac.fsym),
    fetchMTFCandles(ac.sym),
  ]);
  if (!c1m || !live) return;
  const last5 = c5m?.[c5m.length - 1];
  priceCache[assetKey] = {
    price: live,
    open5m: last5 ? last5.o : live,
    candles1m: c1m,
    candles5m: c5m || [],
    obi, cvd, fr, oid,
    candles15m: mtf.c15m,
    candles1h: mtf.c1h,
    ts: Date.now(),
  };
}
