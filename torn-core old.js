/* =========================================================================
   Torn Travel Assistant — shared core
   =========================================================================
   Small, DOM-free helpers for talking to Torn's API, shared by torn-api.js
   (the main page's login + price panel) and flight-planner.js. Exposed as
   window.TornCore so plain <script> tags on either page can use it without
   a build step.

   Load this before torn-api.js and before flight-planner.js.

   Hosting note: this calls https://api.torn.com directly from the browser.
   Torn's API does not appear to send CORS headers permitting that from an
   arbitrary website — community tools typically work around this with a
   browser userscript's privileged request API rather than plain fetch().
   If calls fail with the "couldn't reach Torn's API" message below, that's
   almost certainly why. The fix is to proxy requests through a small
   server-side function you control (a Cloudflare Worker, a Vercel/Netlify
   function, etc.) that adds the key server-side and returns the JSON,
   rather than calling api.torn.com straight from the page.
   ========================================================================= */
(function(){
  'use strict';

  var API_BASE = 'https://api.torn.com';

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
    16: "This key's access level is too low. Use a Limited access key, or a custom key with the right selections.",
    17: "Torn's backend had an error. Try again in a moment.",
    18: "This API key has been paused by its owner."
  };

  function tornErrorMessage(code){
    return TORN_ERRORS[code] || ("Torn's API returned an error (code " + code + ").");
  }

  function fmtMoney(n){
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }

  function escapeHtml(s){
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function relTime(ts){
    if (!ts) return '';
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
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

  // GET a Torn API path (v1 or v2, e.g. "/v2/user/basic" or
  // "/torn/?selections=items") with a key appended, and normalise both
  // Torn-level errors and network/CORS failures into thrown Errors.
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

  window.TornCore = {
    API_BASE: API_BASE,
    TORN_ERRORS: TORN_ERRORS,
    tornErrorMessage: tornErrorMessage,
    fmtMoney: fmtMoney,
    escapeHtml: escapeHtml,
    relTime: relTime,
    findByKey: findByKey,
    apiGet: apiGet
  };
})();
