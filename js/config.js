/* js/config.js — global config, API key prompt */

const JKEY = (() => {
  let k = localStorage.getItem('omega_jkey');
  if (!k) {
    k = prompt('Enter your Jupiter API key (portal.jup.ag):');
    if (k) localStorage.setItem('omega_jkey', k.trim());
  }
  return k ? k.trim() : '';
})();

const JBASE      = 'https://api.jup.ag/prediction/v1';
const BINANCE    = 'https://api.binance.com/api/v3';
const BFUT       = 'https://fapi.binance.com/fapi/v1';
const PROXY      = 'https://corsproxy.io/?';
const VIG        = 0.04;
const MIN_EDGE   = 0.535;
const MIN_EV     = 0.004;
const REFRESH_MS     = 28000;
const PRICE_MS       = 8000;
const RADAR_POLL_MS  = 15000;

const ASSETS = {
  sol: { sym:'SOLUSDT',  fsym:'SOLUSDT',  bg:'#9945ff22', tx:'#9945ff', label:'SOL', dv:.038 },
  btc: { sym:'BTCUSDT',  fsym:'BTCUSDT',  bg:'#f7931a22', tx:'#f7931a', label:'BTC', dv:.022 },
  eth: { sym:'ETHUSDT',  fsym:'ETHUSDT',  bg:'#627eea22', tx:'#627eea', label:'ETH', dv:.028 },
  bnb: { sym:'BNBUSDT',  fsym:null,        bg:'#f0b90b22', tx:'#f0b90b', label:'BNB', dv:.032 },
  hyp: { sym:'SOLUSDT',  fsym:null,        bg:'#00e5a022', tx:'#00e5a0', label:'HYP', dv:.055 },
};

let BANK = 30;
let useProxy = false;
