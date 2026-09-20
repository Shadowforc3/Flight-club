/* =========================================================================
   Flight Planner
   =========================================================================
   Only usable once logged in on the main page (index.html): reads
   the same tta_api_key / tta_player_name localStorage keys torn-api.js
   writes, and gates all content behind them being present.

   Data sources:
   - YATA (https://yata.yt/api/v1/travel/export/) — confirmed, documented,
     no API key needed. Primary source for overseas stock.
   - Prometheus Bot / prombot.co.uk (https://api.prombot.co.uk/api/travel)
     — a real, actively-used community source (built into Torn PDA and
     TornTools), but I could not find a public spec for its READ response
     shape while building this, only its contribute/import side. It's
     wired in as a best-effort secondary source: normalizeProm() tries a
     couple of plausible shapes, and if none match, this is skipped
     entirely and logged to the console rather than breaking the planner.
     YATA alone is enough to produce a full plan.
   - Torn's own API (v1 items catalogue + v2 itemmarket) for sell prices,
     via TornCore, using the key restored from localStorage.

   Travel times are one-way, "Standard" flight, in minutes, from Torn's
   own wiki. China and UAE could not be independently confirmed this
   session — check those two against your own game client.

   Depends on torn-core.js (window.TornCore) — load that first.
   ========================================================================= */
(function(){
  'use strict';

  var STORAGE_KEY = 'tta_api_key';
  var STORAGE_NAME = 'tta_player_name';
  var STORAGE_CAPACITY = 'tta_capacity';
  var STORAGE_FLIGHT_TYPE = 'tta_flight_type';

  var apiGet = TornCore.apiGet;
  var findByKey = TornCore.findByKey;
  var fmtMoney = TornCore.fmtMoney;
  var escapeHtml = TornCore.escapeHtml;
  var relTime = TornCore.relTime;

  var COUNTRIES = [
    { code: 'mex', name: 'Mexico', minutes: 24 },
    { code: 'cay', name: 'Cayman Islands', minutes: 33 },
    { code: 'can', name: 'Canada', minutes: 39 },
    { code: 'haw', name: 'Hawaii', minutes: 127 },
    { code: 'uni', name: 'United Kingdom', minutes: 151 },
    { code: 'arg', name: 'Argentina', minutes: 158 },
    { code: 'swi', name: 'Switzerland', minutes: 166 },
    { code: 'jap', name: 'Japan', minutes: 213 },
    { code: 'chi', name: 'China', minutes: 220 },  // unconfirmed estimate — please verify
    { code: 'uae', name: 'UAE', minutes: 250 },    // unconfirmed estimate — please verify
    { code: 'sou', name: 'South Africa', minutes: 282 }
  ];
  var COUNTRY_BY_CODE = {};
  COUNTRIES.forEach(function(c){ COUNTRY_BY_CODE[c.code] = c; });

  var FLIGHT_TYPES = [
    { id: 'standard', label: 'Standard', multiplier: 1 },
    { id: 'airstrip', label: 'Airstrip', multiplier: 0.7 },
    { id: 'wlt', label: 'WLT benefit', multiplier: 0.5 },
    { id: 'business', label: 'Business Class', multiplier: 0.3 }
  ];

  var CANDIDATE_LIMIT = 25; // how many naive-ranked rows get a live price check
  var RESULT_LIMIT = 15;    // how many rows are displayed
  var CONCURRENCY = 5;      // simultaneous live-price requests, to be gentle on rate limits

  var state = { key: null, name: null, capacity: 24, flightType: 'standard' };
  var lastRows = null; // cached, priced rows from the most recent successful fetch

  try {
    state.key = localStorage.getItem(STORAGE_KEY);
    state.name = localStorage.getItem(STORAGE_NAME);
    var savedCap = parseInt(localStorage.getItem(STORAGE_CAPACITY), 10);
    if (!isNaN(savedCap) && savedCap > 0) state.capacity = savedCap;
    var savedFlight = localStorage.getItem(STORAGE_FLIGHT_TYPE);
    if (savedFlight && FLIGHT_TYPES.some(function(f){ return f.id === savedFlight; })) {
      state.flightType = savedFlight;
    }
  } catch (e) { /* localStorage unavailable */ }

  function currentFlightType(){
    var found = null;
    FLIGHT_TYPES.forEach(function(t){ if (t.id === state.flightType) found = t; });
    return found || FLIGHT_TYPES[0];
  }

  function saveSettings(){
    try {
      localStorage.setItem(STORAGE_CAPACITY, String(state.capacity));
      localStorage.setItem(STORAGE_FLIGHT_TYPE, state.flightType);
    } catch (e) { /* ignore */ }
  }

  // ---- DOM refs ----
  var gate = document.getElementById('gate');
  var planner = document.getElementById('planner');
  var headerAuth = document.getElementById('headerAuth');
  var capVal = document.getElementById('capVal');
  var flightSeg = document.getElementById('flightSeg');
  var statusLine = document.getElementById('statusLine');
  var bestRunCard = document.getElementById('bestRunCard');
  var resultsBody = document.getElementById('resultsBody');
  var refreshBtn = document.getElementById('refreshBtn');

  // ---- Access gate ----
  function checkAccess(){
    if (state.key && state.name) {
      gate.hidden = true;
      planner.hidden = false;
      headerAuth.innerHTML =
        '<span class="header-greeting"><strong>' + escapeHtml(state.name) + '</strong>, welcome</span>' +
        '<a href="torn-travel.html" class="btn btn-ghost">Dashboard</a>' +
        '<button type="button" class="btn btn-ghost" id="logoutBtn">Log out</button>';
      document.getElementById('logoutBtn').addEventListener('click', function(){
        try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(STORAGE_NAME); } catch (e) { /* ignore */ }
        window.location.href = 'index.html';
      });
      return true;
    }
    gate.hidden = false;
    planner.hidden = true;
    headerAuth.innerHTML = '';
    return false;
  }

  // ---- Data sources ----

  function fetchYata(){
    return fetch('https://yata.yt/api/v1/travel/export/').then(function(res){ return res.json(); });
  }

  // Best-effort secondary source — see file header. Never rejects; resolves
  // to null on any failure or unrecognised shape so it's never fatal.
  function fetchProm(){
    return fetch('https://api.prombot.co.uk/api/travel')
      .then(function(res){ return res.json(); })
      .catch(function(){ return null; })
      .then(function(data){
        try { return normalizeProm(data); }
        catch (e) {
          console.warn('[Flight Planner] unrecognised prombot response shape', data);
          return null;
        }
      });
  }

  // Returns { countryCode: [{id or ID, quantity or stock, cost or price}] }
  // or null if the shape isn't one of the guesses below.
  function normalizeProm(data){
    if (!data) return null;
    if (data.stocks && typeof data.stocks === 'object') {
      var out = {};
      Object.keys(data.stocks).forEach(function(code){
        var entry = data.stocks[code];
        var list = Array.isArray(entry) ? entry : (entry && entry.stocks);
        if (Array.isArray(list)) out[code.toLowerCase()] = list;
      });
      return Object.keys(out).length ? out : null;
    }
    if (Array.isArray(data)) {
      var out2 = {};
      data.forEach(function(entry){
        var code = (entry.country || entry.code || '').toString().trim().slice(0, 3).toLowerCase();
        var list = entry.items || entry.stocks;
        if (code && Array.isArray(list)) out2[code] = list;
      });
      return Object.keys(out2).length ? out2 : null;
    }
    return null;
  }

  function fetchTornItems(){
    return apiGet('/torn/?selections=items', state.key).then(function(data){ return data.items || {}; });
  }

  function fetchAveragePrice(itemId){
    return apiGet('/v2/market/' + itemId + '/itemmarket', state.key).then(function(data){
      var price = findByKey(data, 'average_price', 'number');
      if (price === null) throw new Error('unexpected itemmarket response');
      return price;
    });
  }

  // ---- Building the candidate list ----

  function buildStockRows(yataData, promMap){
    var rows = [];
    var stocks = (yataData && yataData.stocks) || {};
    Object.keys(stocks).forEach(function(code){
      var country = COUNTRY_BY_CODE[code];
      if (!country) return;
      var list = (stocks[code] && stocks[code].stocks) || [];
      list.forEach(function(item){
        rows.push({ country: country, item_id: item.id, item_name: item.name, quantity: item.quantity, cost: item.cost });
      });
    });

    if (promMap) {
      var seen = {};
      rows.forEach(function(r){ seen[r.country.code + '|' + r.item_id] = true; });
      Object.keys(promMap).forEach(function(code){
        var country = COUNTRY_BY_CODE[code];
        if (!country) return;
        promMap[code].forEach(function(item){
          var id = item.id != null ? item.id : item.ID;
          var cost = item.cost != null ? item.cost : item.price;
          var quantity = item.quantity != null ? item.quantity : item.stock;
          if (id == null) return;
          var key = country.code + '|' + id;
          if (!seen[key]) {
            rows.push({ country: country, item_id: id, item_name: null, quantity: quantity, cost: cost });
            seen[key] = true;
          }
        });
      });
    }
    return rows;
  }

  function scoreRow(r, flight){
    var usable = Math.max(0, Math.min(r.quantity || 0, state.capacity));
    r.profitPerItem = r.sellPrice - r.cost;
    r.runCost = r.cost * usable;
    r.totalProfit = r.profitPerItem * usable;
    var roundTripMinutes = r.country.minutes * flight.multiplier * 2;
    r.profitPerMin = roundTripMinutes > 0 ? (r.totalProfit / roundTripMinutes) : 0;
  }

  function refineWithLivePrices(candidates, flight){
    var queue = candidates.slice();
    var out = [];

    function worker(){
      if (!queue.length) return Promise.resolve();
      var r = queue.shift();
      return fetchAveragePrice(r.item_id).then(function(price){
        r.sellPrice = price;
        r.estimated = false;
      }).catch(function(){
        r.estimated = true; // keep the market_value-based estimate already on r
      }).then(function(){
        scoreRow(r, flight);
        out.push(r);
        return worker();
      });
    }

    var workers = [];
    for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
    return Promise.all(workers).then(function(){ return out; });
  }

  // ---- Run ----

  function runPlanner(){
    setStatus('Loading stock and prices\u2026');
    resultsBody.innerHTML = '';
    bestRunCard.innerHTML = '<div class="pname">Loading\u2026</div>';

    Promise.all([
      fetchYata().catch(function(err){ throw new Error("Couldn't reach YATA (" + err.message + ")"); }),
      fetchProm(),
      fetchTornItems()
    ]).then(function(results){
      var yataData = results[0], promMap = results[1], tornItems = results[2];

      var rows = buildStockRows(yataData, promMap);
      rows.forEach(function(r){
        var meta = tornItems[r.item_id];
        if (meta) {
          if (!r.item_name) r.item_name = meta.name;
          r.sellPrice = meta.market_value;
        }
        r.estimated = true;
      });
      rows = rows.filter(function(r){
        return r.item_name && typeof r.sellPrice === 'number' && r.cost > 0 && r.quantity > 0;
      });

      var flight = currentFlightType();
      rows.forEach(function(r){ scoreRow(r, flight); });
      rows.sort(function(a, b){ return b.profitPerMin - a.profitPerMin; });

      var candidates = rows.slice(0, CANDIDATE_LIMIT);
      var promStatus = promMap ? 'connected' : 'unavailable this run';
      var yataUpdated = yataData && yataData.timestamp ? relTime(yataData.timestamp * 1000) : 'unknown';

      return refineWithLivePrices(candidates, flight).then(function(refined){
        lastRows = refined;
        rescoreAndRender();
        setStatus('YATA stock updated ' + yataUpdated + ' \u00b7 Prombot: ' + promStatus + ' \u00b7 live prices checked for top ' + refined.length);
      });
    }).catch(function(err){
      setStatus('');
      lastRows = null;
      bestRunCard.innerHTML = '<div class="pname">Couldn\u2019t build a plan</div><div class="pmsg">' + escapeHtml(err.message) + '</div>';
      resultsBody.innerHTML = '';
    });
  }

  // Re-scores and re-renders the already-fetched rows against the current
  // capacity/flight settings, with no new network calls — used whenever a
  // setting changes so the plan updates instantly.
  function rescoreAndRender(){
    if (!lastRows) return;
    var flight = currentFlightType();
    lastRows.forEach(function(r){ scoreRow(r, flight); });
    var sorted = lastRows.slice().sort(function(a, b){ return b.profitPerMin - a.profitPerMin; });
    renderResults(sorted.slice(0, RESULT_LIMIT));
  }

  function setStatus(msg){ statusLine.textContent = msg; }

  function renderResults(rows){
    if (!rows.length) {
      bestRunCard.innerHTML = '<div class="pname">No runs found</div><div class="pmsg">No usable stock data right now \u2014 try refreshing shortly.</div>';
      resultsBody.innerHTML = '';
      return;
    }
    var best = rows[0];
    bestRunCard.innerHTML =
      '<div class="best-kicker">BEST RUN RIGHT NOW' + (best.estimated ? ' \u00b7 ESTIMATED SELL PRICE' : '') + '</div>' +
      '<div class="best-main">' + escapeHtml(best.item_name) + ' \u2014 ' + escapeHtml(best.country.name) + '</div>' +
      '<div class="best-stats">' +
        '<div><span class="k">Profit / min</span><span class="v">' + fmtMoney(best.profitPerMin) + '</span></div>' +
        '<div><span class="k">Profit / item</span><span class="v">' + fmtMoney(best.profitPerItem) + '</span></div>' +
        '<div><span class="k">Run cost</span><span class="v">' + fmtMoney(best.runCost) + '</span></div>' +
      '</div>';

    resultsBody.innerHTML = rows.map(function(r){
      return '<tr>' +
        '<td class="country">' + escapeHtml(r.country.name) + '</td>' +
        '<td>' + escapeHtml(r.item_name) + (r.estimated ? ' <span class="pcat">EST</span>' : '') + '</td>' +
        '<td class="num">' + r.quantity + '</td>' +
        '<td class="num">' + fmtMoney(r.cost) + '</td>' +
        '<td class="num">' + fmtMoney(r.sellPrice) + '</td>' +
        '<td class="num profit">' + fmtMoney(r.profitPerItem) + '</td>' +
        '<td class="num profit">' + fmtMoney(r.profitPerMin) + '/min</td>' +
        '<td class="num">' + fmtMoney(r.runCost) + '</td>' +
      '</tr>';
    }).join('');
  }

  // ---- Settings UI ----

  function renderSettings(){
    capVal.textContent = state.capacity;
    Array.prototype.forEach.call(flightSeg.querySelectorAll('button'), function(btn){
      btn.classList.toggle('active', btn.dataset.flight === state.flightType);
    });
  }

  flightSeg.addEventListener('click', function(e){
    var btn = e.target.closest('button');
    if (!btn) return;
    state.flightType = btn.dataset.flight;
    saveSettings();
    renderSettings();
    rescoreAndRender();
  });

  document.getElementById('capStepper').querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click', function(){
      var step = parseInt(btn.dataset.step, 10);
      state.capacity = Math.max(1, Math.min(500, state.capacity + step));
      saveSettings();
      renderSettings();
      rescoreAndRender();
    });
  });

  refreshBtn.addEventListener('click', runPlanner);

  // ---- Init ----
  if (checkAccess()) {
    renderSettings();
    runPlanner();
  }
})();
