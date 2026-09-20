/* =========================================================================
   Torn Travel Assistant — Torn API integration
   =========================================================================
   Handles logging in with a Torn API key and showing live average market
   prices for a configurable list of items.

   TO ADD AN ITEM: add an object to TRACKED_ITEMS below with its item_id
   (so no name lookup or item-catalogue fetch is needed — the ID goes
   straight into the price request). item_name is what's shown on the
   card. torn_value and category are both optional:
     - category renders as a small tag next to the item name.
     - torn_value is only used as a *starting* reference, for the very
       first time an item is ever checked on a given browser. After
       that, this script remembers the last average price it actually
       saw (in localStorage) and uses that as the comparison baseline
       instead, updating it after every successful check. Torn's
       average_price only moves roughly every 2 hours, so "the price
       from last check" is the meaningful comparison, not a fixed number.
     - That same stored last-known price is also shown, clearly marked
       as such, if a live check ever fails (rate limit, connection
       trouble, etc.) — so the panel still shows a real number instead
       of just an error whenever one is available.

   Example:
     {
       item_id: 186,
       item_name: 'Sheep Plushie',
       torn_value: 489,
       category: 'Plushie'
     }

   Expects this HTML to already exist on the page (IDs must match):
     #authArea, #live, #liveLoggedOut, #liveLoggedIn, #welcomeHeading,
     #priceGrid, #liveUpdatedAt, #loginModal, #apiKeyInput, #rememberKey,
     #modalError, #modalRawDump, #modalSubmitBtn, #modalCloseBtn,
     #modalCancelBtn, #toggleKeyVisible, #loginBtnHero, #loginBtnFinal,
     #loginBtnLive, #logoutBtn, #refreshPricesBtn
   Depends on torn-core.js (window.TornCore) — load that first:
     <script src="torn-core.js"></script>
     <script src="torn-api.js"></script>

   Hosting note: this calls https://api.torn.com directly from the browser.
   Torn's API does not appear to send CORS headers permitting that from an
   arbitrary website — community tools typically work around this with a
   browser userscript's privileged request API rather than plain fetch().
   If these calls fail with the "couldn't reach Torn's API" message below,
   that's almost certainly why. The fix is to proxy just these requests
   through a small server-side function you control (a Cloudflare Worker,
   a Vercel/Netlify function, etc.) that adds the key server-side and
   returns the JSON, rather than calling api.torn.com straight from the
   page.
   ========================================================================= */
(function(){
  'use strict';

  // ---- Items to track ------------------------------------------------------
  // item_id is required. item_name is required for display. category is
  // optional (shown as a small tag). torn_value is optional too, and only
  // matters the first time an item is ever checked on a given browser —
  // see the file header above for why.
  var TRACKED_ITEMS = [
    {
      item_id: 186,
      item_name: 'Sheep Plushie',
      torn_value: 489,
      category: 'Plushie'
    }
    // Add more items here, same shape:
    // {
    //   item_id: 0,
    //   item_name: '',
    //   torn_value: 0,      // optional, starting reference only
    //   category: ''        // optional
    // }
  ];

  // ---- Config --------------------------------------------------------------
  var STORAGE_KEY = 'tta_api_key';
  var STORAGE_NAME = 'tta_player_name';
  var STORAGE_LAST_PRICES = 'tta_last_prices_v1'; // last known average_price per item_id
  var LEGACY_STORAGE_ITEMS = 'tta_item_ids_v1'; // used by an older version of this file

  // Pulled in from torn-core.js, which must be loaded first.
  var fmtMoney = TornCore.fmtMoney;
  var escapeHtml = TornCore.escapeHtml;
  var relTime = TornCore.relTime;
  var findByKey = TornCore.findByKey;
  var apiGet = TornCore.apiGet;

  // ---- Last-known-price store ----------------------------------------------
  // Remembers the last average_price actually seen for each item_id, so it
  // can be used as the "vs last check" comparison and as a fallback figure
  // if a live check ever fails. Keyed by item_id, persisted across visits.

  function loadLastPrices(){
    try {
      return JSON.parse(localStorage.getItem(STORAGE_LAST_PRICES) || '{}') || {};
    } catch (e) { return {}; }
  }

  function saveLastPrice(itemId, price){
    try {
      var all = loadLastPrices();
      all[itemId] = { price: price, ts: Date.now() };
      localStorage.setItem(STORAGE_LAST_PRICES, JSON.stringify(all));
    } catch (e) { /* storage full or unavailable, skip */ }
  }

  // Falls back to the item's configured torn_value (with no timestamp) the
  // first time an item is checked, before anything has been stored for it.
  function getLastKnown(itemId, configValue){
    var stored = loadLastPrices()[itemId];
    if (stored && typeof stored.price === 'number') {
      return { price: stored.price, ts: stored.ts };
    }
    if (typeof configValue === 'number') {
      return { price: configValue, ts: null };
    }
    return null;
  }

  // ---- Login state (restored from localStorage if present) ----
  var state = { key: null, name: null };
  try {
    var savedKey = localStorage.getItem(STORAGE_KEY);
    var savedName = localStorage.getItem(STORAGE_NAME);
    if (savedKey && savedName) { state.key = savedKey; state.name = savedName; }
    localStorage.removeItem(LEGACY_STORAGE_ITEMS); // one-time cleanup of an old cache format
  } catch (e) { /* localStorage unavailable */ }

  function fetchPlayerName(key){
    return apiGet('/v2/user/basic', key).then(function(data){
      var name = findByKey(data, 'name', 'string');
      if (!name) {
        console.warn('[Torn Travel] unexpected /v2/user/basic response', data);
        var err = new Error("Torn answered, but this page couldn't find your name in the response. Raw response below \u2014 if you share it, I can fix the lookup.");
        err.raw = data;
        throw err;
      }
      return name;
    });
  }

  function fetchAveragePrice(key, itemId){
    return apiGet('/v2/market/' + itemId + '/itemmarket', key).then(function(data){
      var price = findByKey(data, 'average_price', 'number');
      if (price === null) {
        console.warn('[Torn Travel] unexpected itemmarket response for item', itemId, data);
        throw new Error("Torn returned a response this page didn't expect.");
      }
      return price;
    });
  }

  // ---- DOM references ----------------------------------------------------

  var authArea = document.getElementById('authArea');
  var liveLoggedOut = document.getElementById('liveLoggedOut');
  var liveLoggedIn = document.getElementById('liveLoggedIn');
  var welcomeHeading = document.getElementById('welcomeHeading');
  var priceGrid = document.getElementById('priceGrid');
  var liveUpdatedAt = document.getElementById('liveUpdatedAt');

  var modal = document.getElementById('loginModal');
  var apiKeyInput = document.getElementById('apiKeyInput');
  var rememberKey = document.getElementById('rememberKey');
  var modalError = document.getElementById('modalError');
  var modalRawDump = document.getElementById('modalRawDump');
  var modalSubmitBtn = document.getElementById('modalSubmitBtn');

  // ---- Modal controls ----

  function openModal(){
    modalError.hidden = true;
    modalRawDump.hidden = true;
    modalRawDump.textContent = '';
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
    document.getElementById('toggleKeyVisible').textContent = 'Show';
    modal.hidden = false;
    setTimeout(function(){ apiKeyInput.focus(); }, 0);
  }
  function closeModal(){ modal.hidden = true; }
  function showModalError(msg){ modalError.textContent = msg; modalError.hidden = false; }

  // ---- Rendering ----------------------------------------------------------

  function renderAuthUI(){
    var sideTabs = document.getElementById('sideTabs');
    if (state.key && state.name) {
      authArea.innerHTML =
        '<span class="header-greeting"><strong>' + escapeHtml(state.name) + '</strong>, welcome</span>' +
        '<a href="flight-planner.html" class="btn btn-ghost">Flight Planner</a>' +
        '<button type="button" class="btn btn-ghost" id="logoutBtnHeader">Log out</button>';
      document.getElementById('logoutBtnHeader').addEventListener('click', logout);

      liveLoggedOut.hidden = true;
      liveLoggedIn.hidden = false;
      welcomeHeading.textContent = state.name + ', welcome';
      if (sideTabs) sideTabs.hidden = false;
    } else {
      authArea.innerHTML = '<button type="button" class="btn btn-primary" id="loginBtnHeader">Log in</button>';
      document.getElementById('loginBtnHeader').addEventListener('click', openModal);

      liveLoggedOut.hidden = false;
      liveLoggedIn.hidden = true;
      if (sideTabs) sideTabs.hidden = true;
    }
  }

  function renderPriceCards(list){
    priceGrid.innerHTML = '';
    list.forEach(function(entry){
      var card = document.createElement('div');
      var nameRow = '<div class="pname">' + escapeHtml(entry.name) +
        (entry.category ? ' <span class="pcat">' + escapeHtml(entry.category) + '</span>' : '') +
        '</div>';

      if (entry.ok) {
        var compareRow = '';
        if (entry.lastKnown) {
          var delta = entry.price - entry.lastKnown.price;
          var deltaClass = delta > 0 ? 'pos' : (delta < 0 ? 'neg' : '');
          var deltaText = (delta > 0 ? '+' : '') + fmtMoney(delta);
          var when = relTime(entry.lastKnown.ts);
          compareRow = '<div class="pcompare">Last check ' + fmtMoney(entry.lastKnown.price) +
            (when ? ' (' + when + ')' : '') + ' <span class="' + deltaClass + '">' + deltaText + '</span></div>';
        }
        card.className = 'price-card';
        card.innerHTML = nameRow +
          '<div class="pvalue">' + fmtMoney(entry.price) + '</div>' +
          '<div class="plabel">AVERAGE PRICE \u00B7 ITEM MARKET</div>' +
          compareRow;
      } else if (entry.isFallback) {
        var whenLabel = relTime(entry.ts);
        card.className = 'price-card is-stale';
        card.innerHTML = nameRow +
          '<div class="pvalue">' + fmtMoney(entry.price) + '</div>' +
          '<div class="plabel">LAST KNOWN PRICE' + (whenLabel ? ' \u00B7 ' + whenLabel.toUpperCase() : '') + '</div>' +
          '<div class="pmsg-soft">Live check failed \u2014 showing the last price we had.</div>';
      } else {
        card.className = 'price-card is-error';
        card.innerHTML = nameRow + '<div class="pmsg">' + escapeHtml(entry.error) + '</div>';
      }
      priceGrid.appendChild(card);
    });
  }

  function loadLivePrices(){
    if (!state.key) return;

    if (!TRACKED_ITEMS.length) {
      priceGrid.innerHTML = '<div class="price-card is-error"><div class="pname">No items configured</div><div class="pmsg">Add at least one item to TRACKED_ITEMS in torn-api.js.</div></div>';
      liveUpdatedAt.textContent = '';
      return;
    }

    priceGrid.innerHTML = '<div class="price-card is-loading"><div class="pname">Loading\u2026</div></div>';
    liveUpdatedAt.textContent = '';

    Promise.all(TRACKED_ITEMS.map(function(item){
      var lastKnown = getLastKnown(item.item_id, item.torn_value);
      return fetchAveragePrice(state.key, item.item_id)
        .then(function(price){
          saveLastPrice(item.item_id, price);
          return { ok: true, name: item.item_name, category: item.category, price: price, lastKnown: lastKnown };
        })
        .catch(function(err){
          if (lastKnown) {
            return { ok: false, isFallback: true, name: item.item_name, category: item.category, price: lastKnown.price, ts: lastKnown.ts };
          }
          return { ok: false, name: item.item_name, category: item.category, error: err.message };
        });
    })).then(function(results){
      renderPriceCards(results);
      liveUpdatedAt.textContent = 'Updated ' + new Date().toLocaleTimeString();
    });
  }

  // ---- Login / logout -----------------------------------------------------

  function login(){
    var key = apiKeyInput.value.trim();
    if (!key) { showModalError('Enter your API key.'); return; }

    modalSubmitBtn.disabled = true;
    modalSubmitBtn.textContent = 'Checking\u2026';
    modalError.hidden = true;
    modalRawDump.hidden = true;
    modalRawDump.textContent = '';

    fetchPlayerName(key).then(function(name){
      state.key = key;
      state.name = name;
      try {
        if (rememberKey.checked) {
          localStorage.setItem(STORAGE_KEY, key);
          localStorage.setItem(STORAGE_NAME, name);
        } else {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(STORAGE_NAME);
        }
      } catch (e) { /* storage unavailable, continue in-memory only */ }

      if (pendingRedirect) { window.location.href = pendingRedirect; return; }

      closeModal();
      renderAuthUI();
      loadLivePrices();
    }).catch(function(err){
      showModalError(err.message);
      if (err.raw) {
        try {
          modalRawDump.textContent = JSON.stringify(err.raw, null, 2);
          modalRawDump.hidden = false;
        } catch (e) { /* not serialisable, skip the dump */ }
      }
    }).then(function(){
      modalSubmitBtn.disabled = false;
      modalSubmitBtn.textContent = 'Log in';
    });
  }

  function logout(){
    state.key = null;
    state.name = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_NAME);
    } catch (e) { /* ignore */ }
    priceGrid.innerHTML = '';
    renderAuthUI();
  }

  function handleCtaClick(){
    if (state.key) {
      document.getElementById('live').scrollIntoView({ behavior: 'smooth' });
    } else {
      openModal();
    }
  }

  // ---- Event wiring ----

  document.getElementById('loginBtnHero').addEventListener('click', handleCtaClick);
  document.getElementById('loginBtnFinal').addEventListener('click', handleCtaClick);
  document.getElementById('loginBtnLive').addEventListener('click', openModal);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('refreshPricesBtn').addEventListener('click', loadLivePrices);

  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
  document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
  document.getElementById('modalSubmitBtn').addEventListener('click', login);
  modal.addEventListener('click', function(e){ if (e.target === modal) closeModal(); });
  apiKeyInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') login(); });

  document.getElementById('toggleKeyVisible').addEventListener('click', function(){
    var showing = apiKeyInput.type === 'text';
    apiKeyInput.type = showing ? 'password' : 'text';
    this.textContent = showing ? 'Show' : 'Hide';
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // ---- Init ----

  // If we arrived here via a gate on another page (e.g. the flight planner
  // linking to torn-travel.html?login=1), open the modal immediately and
  // send the person back there once they've logged in.
  var pendingRedirect = /[?&]login=1\b/.test(window.location.search) ? 'flight-planner.html' : null;

  renderAuthUI();
  if (state.key) {
    loadLivePrices();
  } else if (pendingRedirect) {
    openModal();
  }
})();
