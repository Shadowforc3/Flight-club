/* =========================================================================
   Torn Travel Assistant — Torn API integration
   =========================================================================
   Handles logging in with a Torn API key and showing live average market
   prices for a configurable list of items.

   TO TRACK MORE ITEMS: edit TRACKED_ITEMS just below. Nothing else needs
   to change — item IDs are looked up by name automatically, and the price
   grid already lays out any number of cards.

   Expects this HTML to already exist on the page (IDs must match):
     #authArea, #live, #liveLoggedOut, #liveLoggedIn, #welcomeHeading,
     #priceGrid, #liveUpdatedAt, #loginModal, #apiKeyInput, #rememberKey,
     #modalError, #modalRawDump, #modalSubmitBtn, #modalCloseBtn,
     #modalCancelBtn, #toggleKeyVisible, #loginBtnHero, #loginBtnFinal,
     #loginBtnLive, #logoutBtn, #refreshPricesBtn
   Load this script at the end of <body>, after that HTML — e.g.:
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

  // ---- Items to track ----------------------------------------------------
  // Add or remove names here to change what shows in the "Live from your
  // account" panel. Matching against Torn's item list is case-insensitive;
  // an exact match is preferred, and a partial match is used as a
  // fallback (so "Plushie" still matches an item actually named
  // "Plushies"). A name that matches nothing shows up as a small "not
  // found" card instead of silently vanishing, so typos are easy to spot.
  var TRACKED_ITEMS = ['Flowers', 'Plushie'];

  // ---- Config --------------------------------------------------------------
  var API_BASE = 'https://api.torn.com';
  var STORAGE_KEY = 'tta_api_key';
  var STORAGE_NAME = 'tta_player_name';
  var STORAGE_ITEMS = 'tta_item_ids_v1';
  var ITEM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  // ---- Torn API error codes (see torn.com/api.html) ----
  var TORN_ERRORS = {
    0: "Unknown error from Torn's API. Try again in a moment.",
    1: "That key looks empty. Paste your 16-character API key.",
    2: "Torn didn't recognise that key. Double-check you copied it correctly.",
    3: "Torn rejected this request (wrong type).",
    4: "Torn rejected this request (wrong fields).",
    5: "Torn is rate-limiting these requests right now. Wait a minute and try again.",
    6: "Torn rejected this request (incorrect ID).",
    7: "That data is private and isn't visible to this key.",
    8: "Your IP has been temporarily blocked by Torn for too many requests.",
    9: "Torn's API is currently disabled.",
    10: "This key's owner is in federal jail, so Torn is blocking the key.",
    11: "You can only change your Torn API key once every 60 seconds.",
    12: "Torn had trouble reading this key. Try again.",
    13: "This key has been disabled because its owner hasn't been online in over 7 days.",
    14: "Daily read limit reached for this key.",
    16: "This key's access level is too low. Use a Limited access key, or a custom key with user \u2192 basic and market \u2192 itemmarket selected.",
    17: "Torn's backend had an error. Try again in a moment.",
    18: "This API key has been paused by its owner."
  };

  function tornErrorMessage(code){
    return TORN_ERRORS[code] || ("Torn's API returned an error (code " + code + ").");
  }

  // ---- Small utilities -------------------------------------------------

  function fmtMoney(n){
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function escapeHtml(s){
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Searches an API response for a property named keyName without assuming
  // exactly how deep it's nested, since Torn's v2 wrapping isn't the same
  // shape across every endpoint. Breadth-first, so a shallower match wins.
  function findByKey(obj, keyName, wantType, maxDepth){
    maxDepth = (typeof maxDepth === 'number') ? maxDepth : 4;
    var queue = [{ node: obj, depth: 0 }];
    while (queue.length) {
      var cur = queue.shift();
      var node = cur.node, depth = cur.depth;
      if (!node || typeof node !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(node, keyName)) {
        var v = node[keyName];
        if (wantType === 'string' && typeof v === 'string' && v.trim() !== '') return v;
        if (wantType === 'number' && typeof v === 'number' && isFinite(v)) return v;
      }
      if (depth < maxDepth) {
        Object.keys(node).forEach(function(k){
          queue.push({ node: node[k], depth: depth + 1 });
        });
      }
    }
    return null;
  }

  // ---- Login state (restored from localStorage if present) ----
  var state = { key: null, name: null };
  try {
    var savedKey = localStorage.getItem(STORAGE_KEY);
    var savedName = localStorage.getItem(STORAGE_NAME);
    if (savedKey && savedName) { state.key = savedKey; state.name = savedName; }
  } catch (e) { /* localStorage unavailable */ }

  // ---- Torn API calls ----------------------------------------------------

  function apiGet(path, key){
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var url = API_BASE + path + sep + 'key=' + encodeURIComponent(key);
    return fetch(url, { method: 'GET' }).then(function(res){
      return res.json();
    }).then(function(data){
      if (data && data.error) {
        var err = new Error(tornErrorMessage(data.error.code));
        err.tornCode = data.error.code;
        throw err;
      }
      return data;
    }, function(){
      var err = new Error("Couldn't reach Torn's API from this page. If you're viewing this inside Claude's preview, live requests are blocked there. If it's hosted elsewhere and this keeps failing, Torn's API is likely blocking direct browser requests (CORS) \u2014 the usual fix is a small server-side proxy you control.");
      err.isNetwork = true;
      throw err;
    });
  }

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

  // Resolves TRACKED_ITEMS (names) to Torn item IDs by fetching the full
  // item catalogue once and matching by name, then caches the result.
  // The cache is keyed to the current TRACKED_ITEMS list, so editing that
  // list above automatically invalidates any stale cached result.
  function resolveItemIds(key){
    try {
      var cached = JSON.parse(localStorage.getItem(STORAGE_ITEMS) || 'null');
      var sameList = cached && cached.tracked && cached.tracked.join('|') === TRACKED_ITEMS.join('|');
      if (sameList && (Date.now() - cached.ts) < ITEM_CACHE_TTL && cached.result) {
        return Promise.resolve(cached.result);
      }
    } catch (e) { /* ignore bad cache */ }

    return apiGet('/torn/?selections=items', key).then(function(data){
      var items = data.items || {};
      if (!data.items) {
        console.warn('[Torn Travel] unexpected /torn/?selections=items response', data);
      }
      var found = [], missing = [];
      TRACKED_ITEMS.forEach(function(target){
        var targetLow = target.trim().toLowerCase();
        var exact = null, partial = null;
        Object.keys(items).forEach(function(id){
          var nm = (items[id].name || '').trim();
          var low = nm.toLowerCase();
          if (low === targetLow) exact = { id: id, name: nm };
          else if (!partial && low.indexOf(targetLow) !== -1) partial = { id: id, name: nm };
        });
        var pick = exact || partial;
        if (pick) found.push(pick); else missing.push(target);
      });
      var result = { items: found, missing: missing };
      try {
        localStorage.setItem(STORAGE_ITEMS, JSON.stringify({ ts: Date.now(), tracked: TRACKED_ITEMS, result: result }));
      } catch (e) { /* storage full or unavailable, skip caching */ }
      return result;
    });
  }

  function fetchAveragePrice(key, id){
    return apiGet('/v2/market/' + id + '/itemmarket', key).then(function(data){
      var price = findByKey(data, 'average_price', 'number');
      if (price === null) {
        console.warn('[Torn Travel] unexpected itemmarket response for item', id, data);
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
    if (state.key && state.name) {
      authArea.innerHTML =
        '<span class="header-greeting"><strong>' + escapeHtml(state.name) + '</strong>, welcome</span>' +
        '<button type="button" class="btn btn-ghost" id="logoutBtnHeader">Log out</button>';
      document.getElementById('logoutBtnHeader').addEventListener('click', logout);

      liveLoggedOut.hidden = true;
      liveLoggedIn.hidden = false;
      welcomeHeading.textContent = state.name + ', welcome';
    } else {
      authArea.innerHTML = '<button type="button" class="btn btn-primary" id="loginBtnHeader">Log in</button>';
      document.getElementById('loginBtnHeader').addEventListener('click', openModal);

      liveLoggedOut.hidden = false;
      liveLoggedIn.hidden = true;
    }
  }

  function renderPriceCards(list){
    priceGrid.innerHTML = '';
    list.forEach(function(entry){
      var card = document.createElement('div');
      card.className = 'price-card' + (entry.error ? ' is-error' : '');
      if (entry.error) {
        card.innerHTML =
          '<div class="pname">' + escapeHtml(entry.name) + '</div>' +
          '<div class="pmsg">' + escapeHtml(entry.error) + '</div>';
      } else {
        card.innerHTML =
          '<div class="pname">' + escapeHtml(entry.name) + '</div>' +
          '<div class="pvalue">' + fmtMoney(entry.price) + '</div>' +
          '<div class="plabel">AVERAGE PRICE \u00B7 ITEM MARKET</div>';
      }
      priceGrid.appendChild(card);
    });
  }

  function loadLivePrices(){
    if (!state.key) return;
    priceGrid.innerHTML = '<div class="price-card is-loading"><div class="pname">Loading\u2026</div></div>';
    liveUpdatedAt.textContent = '';

    resolveItemIds(state.key).then(function(resolved){
      var wanted = resolved.items, missing = resolved.missing;
      if (!wanted.length) {
        priceGrid.innerHTML = '<div class="price-card is-error"><div class="pname">' + escapeHtml(TRACKED_ITEMS.join(' & ')) + '</div><div class="pmsg">Couldn\u2019t find any of these in Torn\u2019s item list.</div></div>';
        return;
      }
      return Promise.all(wanted.map(function(it){
        return fetchAveragePrice(state.key, it.id)
          .then(function(price){ return { name: it.name, price: price }; })
          .catch(function(err){ return { name: it.name, error: err.message }; });
      })).then(function(results){
        missing.forEach(function(name){
          results.push({ name: name, error: 'Not found in Torn\u2019s item list \u2014 check the spelling in TRACKED_ITEMS.' });
        });
        renderPriceCards(results);
        liveUpdatedAt.textContent = 'Updated ' + new Date().toLocaleTimeString();
      });
    }).catch(function(err){
      priceGrid.innerHTML = '<div class="price-card is-error"><div class="pname">Couldn\u2019t load prices</div><div class="pmsg">' + escapeHtml(err.message) + '</div></div>';
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
      localStorage.removeItem(STORAGE_ITEMS);
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

  renderAuthUI();
  if (state.key) loadLivePrices();
})();
