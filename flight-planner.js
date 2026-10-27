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
   - Optionally, a self-hosted restock-prediction backend (see backend/ —
     a Cloudflare Worker + D1) at PREDICTIONS_API below. Entirely
     best-effort: left unset, or unreachable, predictions are just
     skipped and everything else works the same.

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
  var STORAGE_TIME_BUDGET = 'tta_time_budget_min';
  var STORAGE_CASH_BUDGET = 'tta_cash_budget';
  var STORAGE_REINVEST = 'tta_reinvest';
  var STORAGE_DRUG_DEADLINE = 'tta_drug_deadline_min';
  var STORAGE_OC_DEADLINE = 'tta_oc_deadline_min';
  var STORAGE_PRESETS = 'tta_presets';

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

  // Set this to your deployed Worker's URL (see backend/DEPLOY.md) to turn
  // on restock predictions. Left null, predictions are just skipped —
  // everything else works the same either way.
  var PREDICTIONS_API = 'https://torn-travel-history.blade24690.workers.dev';

  var state = {
    key: null, name: null, capacity: 24, flightType: 'standard',
    timeBudgetMinutes: 240,   // "time available" for the sequential plan, default 4h
    cashBudget: 50000000,     // total cash the sequential plan is allowed to spend
    reinvest: false,          // whether a trip's profit is added back into the cash budget for later trips
    drugDeadlineMinutes: 0,   // 0 = no deadline
    ocDeadlineMinutes: 0,     // 0 = no deadline, always manual (see file header)
    presetId: ''              // currently-selected preset, '' = Custom
  };
  var lastRows = null; // cached, priced rows from the most recent successful fetch

  function readIntSetting(key, fallback){
    var v = parseInt(localStorage.getItem(key), 10);
    return isNaN(v) ? fallback : v;
  }

  try {
    state.key = localStorage.getItem(STORAGE_KEY);
    state.name = localStorage.getItem(STORAGE_NAME);
    var savedCap = parseInt(localStorage.getItem(STORAGE_CAPACITY), 10);
    if (!isNaN(savedCap) && savedCap > 0) state.capacity = savedCap;
    var savedFlight = localStorage.getItem(STORAGE_FLIGHT_TYPE);
    if (savedFlight && FLIGHT_TYPES.some(function(f){ return f.id === savedFlight; })) {
      state.flightType = savedFlight;
    }
    state.timeBudgetMinutes = readIntSetting(STORAGE_TIME_BUDGET, state.timeBudgetMinutes);
    state.cashBudget = readIntSetting(STORAGE_CASH_BUDGET, state.cashBudget);
    state.reinvest = localStorage.getItem(STORAGE_REINVEST) === '1';
    state.drugDeadlineMinutes = readIntSetting(STORAGE_DRUG_DEADLINE, 0);
    state.ocDeadlineMinutes = readIntSetting(STORAGE_OC_DEADLINE, 0);
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
      localStorage.setItem(STORAGE_TIME_BUDGET, String(state.timeBudgetMinutes));
      localStorage.setItem(STORAGE_CASH_BUDGET, String(state.cashBudget));
      localStorage.setItem(STORAGE_REINVEST, state.reinvest ? '1' : '0');
      localStorage.setItem(STORAGE_DRUG_DEADLINE, String(state.drugDeadlineMinutes));
      localStorage.setItem(STORAGE_OC_DEADLINE, String(state.ocDeadlineMinutes));
    } catch (e) { /* ignore */ }
  }

  // ---- Presets ----

  function loadPresets(){
    try { return JSON.parse(localStorage.getItem(STORAGE_PRESETS) || '[]') || []; }
    catch (e) { return []; }
  }
  function savePresetsList(list){
    try { localStorage.setItem(STORAGE_PRESETS, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function currentSettingsSnapshot(){
    return {
      capacity: state.capacity, flightType: state.flightType,
      timeBudgetMinutes: state.timeBudgetMinutes, cashBudget: state.cashBudget,
      reinvest: state.reinvest, drugDeadlineMinutes: state.drugDeadlineMinutes,
      ocDeadlineMinutes: state.ocDeadlineMinutes
    };
  }
  function applySettingsSnapshot(s){
    state.capacity = s.capacity; state.flightType = s.flightType;
    state.timeBudgetMinutes = s.timeBudgetMinutes; state.cashBudget = s.cashBudget;
    state.reinvest = s.reinvest; state.drugDeadlineMinutes = s.drugDeadlineMinutes;
    state.ocDeadlineMinutes = s.ocDeadlineMinutes;
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
  var planSequence = document.getElementById('planSequence');

  var presetSelect = document.getElementById('presetSelect');
  var savePresetBtn = document.getElementById('savePresetBtn');
  var deletePresetBtn = document.getElementById('deletePresetBtn');

  var budgetHours = document.getElementById('budgetHours');
  var budgetMins = document.getElementById('budgetMins');
  var cashBudgetInput = document.getElementById('cashBudget');
  var reinvestSwitch = document.getElementById('reinvestSwitch');
  var drugHours = document.getElementById('drugHours');
  var drugMins = document.getElementById('drugMins');
  var ocHours = document.getElementById('ocHours');
  var ocMins = document.getElementById('ocMins');
  var fetchCooldownBtn = document.getElementById('fetchCooldownBtn');

  // ---- Access gate ----
  function checkAccess(){
    var sideTabs = document.getElementById('sideTabs');
    if (state.key && state.name) {
      gate.hidden = true;
      planner.hidden = false;
      if (sideTabs) sideTabs.hidden = false;
      headerAuth.innerHTML =
        '<span class="header-greeting"><strong>' + escapeHtml(state.name) + '</strong>, welcome</span>' +
        '<a href="index.html" class="btn btn-ghost">Dashboard</a>' +
        '<button type="button" class="btn btn-ghost" id="logoutBtn">Log out</button>';
      document.getElementById('logoutBtn').addEventListener('click', function(){
        try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(STORAGE_NAME); } catch (e) { /* ignore */ }
        window.location.href = 'index.html';
      });
      return true;
    }
    gate.hidden = false;
    planner.hidden = true;
    if (sideTabs) sideTabs.hidden = true;
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

  // Best-effort, same spirit as fetchProm: no backend configured, or a
  // failed request, just means no predictions this run — never fatal.
  function fetchPredictions(){
    if (!PREDICTIONS_API) return Promise.resolve({});
    return fetch(PREDICTIONS_API.replace(/\/$/, '') + '/predictions')
      .then(function(res){ return res.json(); })
      .then(function(data){ return (data && data.predictions) || {}; })
      .catch(function(){ return {}; });
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
      fetchTornItems(),
      fetchPredictions()
    ]).then(function(results){
      var yataData = results[0], promMap = results[1], tornItems = results[2], predictions = results[3];

      var rows = buildStockRows(yataData, promMap);
      rows.forEach(function(r){
        var meta = tornItems[r.item_id];
        if (meta) {
          if (!r.item_name) r.item_name = meta.name;
          r.sellPrice = meta.market_value;
        }
        r.estimated = true;
        r.prediction = predictions[r.country.code + '|' + r.item_id] || null;
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
      var predictionCount = Object.keys(predictions).length;
      var predictionStatus = !PREDICTIONS_API ? 'not configured' : (predictionCount ? predictionCount + ' items' : 'no data yet');

      return refineWithLivePrices(candidates, flight).then(function(refined){
        lastRows = refined;
        rescoreAndRender();
        setStatus('YATA stock updated ' + yataUpdated + ' \u00b7 Prombot: ' + promStatus + ' \u00b7 live prices checked for top ' + refined.length + ' \u00b7 restock predictions: ' + predictionStatus);
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
    renderSequentialPlan(buildSequentialPlan(lastRows, flight));
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

  // ---- Drug cooldown ----
  // Confirmed: user/cooldowns needs only a Minimal-access key. The exact
  // field shape wasn't something I could verify against a live response,
  // so this is read defensively via findByKey rather than one hardcoded
  // path. The value Torn returns could plausibly be either "seconds
  // remaining" or an absolute end-timestamp — a real Unix timestamp right
  // now is always a huge number (1.7+ billion), while a cooldown duration
  // tops out around 24-25h (~90,000 seconds), so the two are easy to tell
  // apart by size.
  function fetchDrugCooldownMinutes(){
    return apiGet('/v2/user/cooldowns', state.key).then(function(data){
      var raw = findByKey(data, 'drug', 'number');
      if (raw === null) throw new Error("Torn returned a response this page didn't expect.");
      var endMs = raw > 10000000 ? raw * 1000 : (Date.now() + raw * 1000);
      return Math.max(0, Math.round((endMs - Date.now()) / 60000));
    });
  }

  // ---- Sequential (multi-stop) planner ----
  // A greedy scheduler, same approach clovanzo describes using: repeatedly
  // pick the single best remaining trip that still fits the time and cash
  // left, until nothing more fits. Known simplifications, stated plainly
  // rather than hidden: each country+item pairing is only used once per
  // plan (restock timing isn't modelled, so a second visit can't be
  // assumed to have fresh stock), and every trip is a round trip back to
  // Torn — there's no direct foreign-to-foreign travel in-game.
  function effectiveDeadlineMinutes(){
    var d = state.timeBudgetMinutes;
    if (state.drugDeadlineMinutes > 0) d = Math.min(d, state.drugDeadlineMinutes);
    if (state.ocDeadlineMinutes > 0) d = Math.min(d, state.ocDeadlineMinutes);
    return Math.max(0, d);
  }

  function buildSequentialPlan(rows, flight){
    var deadline = effectiveDeadlineMinutes();
    var remainingTime = deadline;
    var remainingCash = state.cashBudget;
    var used = {};
    var pool = rows.slice().sort(function(a, b){ return b.profitPerMin - a.profitPerMin; });
    var trips = [];
    var elapsed = 0;

    while (true) {
      var pick = null, roundTrip = 0;
      for (var i = 0; i < pool.length; i++) {
        var r = pool[i];
        var key = r.country.code + '|' + r.item_id;
        if (used[key]) continue;
        var rt = r.country.minutes * flight.multiplier * 2;
        if (rt > remainingTime) continue;
        if (r.runCost > remainingCash) continue;
        pick = r; roundTrip = rt;
        break; // pool is sorted by profitPerMin, so the first fit is the best fit
      }
      if (!pick) break;

      used[pick.country.code + '|' + pick.item_id] = true;
      trips.push({
        row: pick, roundTripMinutes: roundTrip,
        departAt: elapsed, backBy: elapsed + roundTrip
      });
      elapsed += roundTrip;
      remainingTime -= roundTrip;
      remainingCash -= pick.runCost;
      if (state.reinvest) remainingCash += pick.totalProfit;
    }

    var totalProfit = trips.reduce(function(sum, t){ return sum + t.row.totalProfit; }, 0);
    var totalCost = trips.reduce(function(sum, t){ return sum + t.row.runCost; }, 0);

    return {
      trips: trips, deadline: deadline,
      totalProfit: totalProfit, totalCost: totalCost,
      timeUsed: elapsed, timeLeft: Math.max(0, deadline - elapsed),
      cashLeft: remainingCash
    };
  }

  function untilText(tsSeconds){
    var diffMin = Math.round((tsSeconds * 1000 - Date.now()) / 60000);
    if (diffMin <= 0) return 'due any time now';
    return 'next due in \u2248' + fmtDuration(diffMin);
  }

  function fmtDuration(mins){
    mins = Math.round(mins);
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h <= 0) return m + 'm';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
  }

  function renderSequentialPlan(plan){
    if (!plan.deadline) {
      planSequence.innerHTML = '<div class="best-run"><div class="pname">No time budget set</div><div class="pmsg">Set "Time available" above to build a sequence of trips rather than just a single best run.</div></div>';
      return;
    }
    if (!plan.trips.length) {
      planSequence.innerHTML = '<div class="best-run"><div class="pname">No trips fit</div><div class="pmsg">Nothing fits your current time and cash budget \u2014 try raising one of them.</div></div>';
      return;
    }

    var summary = '<div class="plan-summary">' +
      '<div><span class="k">TRIPS</span><span class="v">' + plan.trips.length + '</span></div>' +
      '<div><span class="k">TOTAL PROFIT</span><span class="v">' + fmtMoney(plan.totalProfit) + '</span></div>' +
      '<div><span class="k">TIME USED</span><span class="v">' + fmtDuration(plan.timeUsed) + ' of ' + fmtDuration(plan.deadline) + '</span></div>' +
      '<div><span class="k">CASH SPENT</span><span class="v">' + fmtMoney(plan.totalCost) + '</span></div>' +
    '</div>';

    var cards = plan.trips.map(function(t, i){
      var r = t.row;
      var sub = 'Depart +' + fmtDuration(t.departAt) + ' \u00b7 back by +' + fmtDuration(t.backBy);
      if (r.prediction) {
        sub += ' \u00b7 restocks ~every ' + fmtDuration(r.prediction.median_interval_minutes) +
          ', ' + untilText(r.prediction.predicted_next_at) +
          ' (' + r.prediction.sample_size + ' past restocks seen)';
      }
      return '<div class="trip-card">' +
        '<div class="trip-num mono">' + (i + 1) + '</div>' +
        '<div class="trip-main">' +
          '<div class="name">' + escapeHtml(r.item_name) + ' \u2014 ' + escapeHtml(r.country.name) + (r.estimated ? ' <span class="pcat">EST</span>' : '') + '</div>' +
          '<div class="sub">' + sub + '</div>' +
        '</div>' +
        '<div class="trip-stats">' +
          '<div><span class="k">PROFIT</span>' + fmtMoney(r.totalProfit) + '</div>' +
          '<div><span class="k">COST</span>' + fmtMoney(r.runCost) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    planSequence.innerHTML = summary + cards;
  }

  // ---- Settings UI ----

  function renderSettings(){
    capVal.textContent = state.capacity;
    Array.prototype.forEach.call(flightSeg.querySelectorAll('button'), function(btn){
      btn.classList.toggle('active', btn.dataset.flight === state.flightType);
    });
    budgetHours.value = Math.floor(state.timeBudgetMinutes / 60);
    budgetMins.value = state.timeBudgetMinutes % 60;
    cashBudgetInput.value = state.cashBudget;
    reinvestSwitch.setAttribute('aria-pressed', state.reinvest ? 'true' : 'false');
    drugHours.value = Math.floor(state.drugDeadlineMinutes / 60);
    drugMins.value = state.drugDeadlineMinutes % 60;
    ocHours.value = Math.floor(state.ocDeadlineMinutes / 60);
    ocMins.value = state.ocDeadlineMinutes % 60;
    renderPresetOptions();
  }

  function renderPresetOptions(){
    var presets = loadPresets();
    presetSelect.innerHTML = '<option value="">Custom</option>' + presets.map(function(p){
      return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
    }).join('');
    presetSelect.value = state.presetId;
    deletePresetBtn.hidden = !state.presetId;
  }

  function markCustom(){
    if (state.presetId) { state.presetId = ''; renderPresetOptions(); }
  }

  // ---- Preset controls ----

  presetSelect.addEventListener('change', function(){
    var id = presetSelect.value;
    if (!id) { state.presetId = ''; deletePresetBtn.hidden = true; return; }
    var preset = loadPresets().filter(function(p){ return p.id === id; })[0];
    if (!preset) return;
    applySettingsSnapshot(preset);
    state.presetId = id;
    saveSettings();
    renderSettings();
    rescoreAndRender();
  });

  savePresetBtn.addEventListener('click', function(){
    var name = window.prompt('Name this preset:');
    if (!name) return;
    var presets = loadPresets();
    var preset = currentSettingsSnapshot();
    preset.id = 'p' + Date.now();
    preset.name = name.trim().slice(0, 40);
    presets.push(preset);
    savePresetsList(presets);
    state.presetId = preset.id;
    renderPresetOptions();
  });

  deletePresetBtn.addEventListener('click', function(){
    if (!state.presetId) return;
    var presets = loadPresets().filter(function(p){ return p.id !== state.presetId; });
    savePresetsList(presets);
    state.presetId = '';
    renderPresetOptions();
  });

  // ---- Trip budget / cooldown controls ----

  function bindDurationInputs(hoursEl, minsEl, onChange){
    function read(){
      var h = Math.max(0, parseInt(hoursEl.value, 10) || 0);
      var m = Math.max(0, Math.min(59, parseInt(minsEl.value, 10) || 0));
      onChange(h * 60 + m);
      markCustom();
      saveSettings();
      rescoreAndRender();
    }
    hoursEl.addEventListener('change', read);
    minsEl.addEventListener('change', read);
  }

  bindDurationInputs(budgetHours, budgetMins, function(mins){ state.timeBudgetMinutes = mins; });
  bindDurationInputs(drugHours, drugMins, function(mins){ state.drugDeadlineMinutes = mins; });
  bindDurationInputs(ocHours, ocMins, function(mins){ state.ocDeadlineMinutes = mins; });

  cashBudgetInput.addEventListener('change', function(){
    state.cashBudget = Math.max(0, parseInt(cashBudgetInput.value, 10) || 0);
    markCustom();
    saveSettings();
    rescoreAndRender();
  });

  reinvestSwitch.addEventListener('click', function(){
    state.reinvest = reinvestSwitch.getAttribute('aria-pressed') !== 'true';
    reinvestSwitch.setAttribute('aria-pressed', state.reinvest ? 'true' : 'false');
    markCustom();
    saveSettings();
    rescoreAndRender();
  });

  fetchCooldownBtn.addEventListener('click', function(){
    fetchCooldownBtn.disabled = true;
    fetchCooldownBtn.textContent = 'Checking\u2026';
    fetchDrugCooldownMinutes().then(function(mins){
      state.drugDeadlineMinutes = mins;
      markCustom();
      saveSettings();
      renderSettings();
      rescoreAndRender();
    }).catch(function(err){
      setStatus('Couldn\u2019t fetch your cooldown: ' + err.message);
    }).then(function(){
      fetchCooldownBtn.disabled = false;
      fetchCooldownBtn.textContent = 'Use my cooldown';
    });
  });

  flightSeg.addEventListener('click', function(e){
    var btn = e.target.closest('button');
    if (!btn) return;
    state.flightType = btn.dataset.flight;
    markCustom();
    saveSettings();
    renderSettings();
    rescoreAndRender();
  });

  document.getElementById('capStepper').querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click', function(){
      var step = parseInt(btn.dataset.step, 10);
      state.capacity = Math.max(1, Math.min(500, state.capacity + step));
      markCustom();
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
