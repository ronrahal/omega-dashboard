/* js/app.js — bootstrap, tab switcher, global timers */

let refreshTimer = null;

async function doRefresh() {
  BANK = parseFloat(document.getElementById('bankroll').value) || 30;
  await Promise.all([loadMarkets(), loadTrades(), loadLB()]);
}

function resetKey() {
  localStorage.removeItem('omega_jkey');
  toast('API key cleared — reloading...', 'ok');
  setTimeout(() => location.reload(), 1500);
}

function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('view-' + tab).classList.add('active');
  if (tab === 'tracker') { renderTracker(); _updatePendingBadge(); }
  if (tab === 'radar' && radarState.lastPollTs === 0) radarRefresh();
}

/* load Chart.js from CDN */
(function loadChartJS() {
  if (window.Chart) return;
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
  document.head.appendChild(s);
})();

/* bootstrap on load */
window.addEventListener('load', () => {
  BANK = parseFloat(document.getElementById('bankroll').value) || 30;
  document.getElementById('bankroll').addEventListener('change', () => {
    BANK = parseFloat(document.getElementById('bankroll').value) || 30;
  });
  doRefresh();
  refreshTimer = setInterval(doRefresh, REFRESH_MS);
  startOutcomePoll();
});
