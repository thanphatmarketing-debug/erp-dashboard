// Keep one storage origin. Opening the downloaded file directly would create
  // a separate localStorage database, so employee accounts would appear missing.
  if (location.protocol === 'file:') {
    var migration = {};
    ['erp-admin-users', 'erp-users-db', 'erp-admin-next-id'].forEach(function(key) {
      var value = localStorage.getItem(key);
      if (value !== null) migration[key] = value;
    });
    var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(migration))));
    location.replace('http://127.0.0.1:8084/erp_final_v6.html#migrate=' + encoded);
  } else if (location.hash.indexOf('#migrate=') === 0) {
    try {
      var payload = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(9)))));
      Object.keys(payload).forEach(function(key) {
        if (payload[key] !== null) localStorage.setItem(key, payload[key]);
      });
      history.replaceState(null, document.title, location.pathname + location.search);
    } catch (migrationError) {
      console.warn('Employee account migration failed', migrationError);
    }
  }

window.ERP_SECURITY = (function () {
  "use strict";
  var API_TOKEN_KEY = "erp-api-token";
  var SAVED_API_TOKEN_KEY = "erp-api-token-encrypted";
  var SESSION_KEY = "erp-backend-session";

  var legacyToken = localStorage.getItem("erp-token");
  if (legacyToken && !sessionStorage.getItem(API_TOKEN_KEY)) {
    sessionStorage.setItem(API_TOKEN_KEY, legacyToken);
  }
  localStorage.removeItem("erp-token");
  localStorage.removeItem("erp-access-token");
  var oldSavedToken = localStorage.getItem("erp-api-token-saved");
  if (oldSavedToken) {
    sessionStorage.setItem(API_TOKEN_KEY, oldSavedToken);
    localStorage.removeItem("erp-api-token-saved");
  }

  function setJson(key, value) {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  }

  function bytesToBase64(bytes) {
    var text = "";
    bytes.forEach(function (byte) { text += String.fromCharCode(byte); });
    return btoa(text);
  }

  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), function (char) { return char.charCodeAt(0); });
  }

  async function encryptionKey() {
    var seed = new TextEncoder().encode(location.origin + "|" + navigator.userAgent + "|erp-v6");
    var digest = await crypto.subtle.digest("SHA-256", seed);
    return crypto.subtle.importKey("raw", digest, { name:"AES-GCM" }, false, ["encrypt","decrypt"]);
  }

  async function encryptToken(value) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var encrypted = await crypto.subtle.encrypt(
      { name:"AES-GCM", iv:iv },
      await encryptionKey(),
      new TextEncoder().encode(value)
    );
    return JSON.stringify({ iv:bytesToBase64(iv), data:bytesToBase64(new Uint8Array(encrypted)) });
  }

  async function decryptToken(value) {
    var payload = JSON.parse(value);
    var decrypted = await crypto.subtle.decrypt(
      { name:"AES-GCM", iv:base64ToBytes(payload.iv) },
      await encryptionKey(),
      base64ToBytes(payload.data)
    );
    return new TextDecoder().decode(decrypted);
  }

  return {
    getApiToken: function () {
      return sessionStorage.getItem(API_TOKEN_KEY) || "";
    },
    setApiToken: function (value) {
      if (value) {
        sessionStorage.setItem(API_TOKEN_KEY, value);
        encryptToken(value).then(function (encrypted) {
          localStorage.setItem(SAVED_API_TOKEN_KEY, encrypted);
        }).catch(function () {});
      } else {
        sessionStorage.removeItem(API_TOKEN_KEY);
        localStorage.removeItem(SAVED_API_TOKEN_KEY);
      }
    },
    restoreApiToken: async function () {
      var current = sessionStorage.getItem(API_TOKEN_KEY);
      if (current) return current;
      var encrypted = localStorage.getItem(SAVED_API_TOKEN_KEY);
      if (!encrypted) return "";
      try {
        var token = await decryptToken(encrypted);
        sessionStorage.setItem(API_TOKEN_KEY, token);
        return token;
      } catch (error) {
        localStorage.removeItem(SAVED_API_TOKEN_KEY);
        return "";
      }
    },
    getSession: function () {
      try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
      catch (error) { return null; }
    },
    setSession: function (value) { setJson(SESSION_KEY, value); },
    sha256: async function (value) {
      var bytes = new TextEncoder().encode(String(value || ""));
      var digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest)).map(function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
    },
    clear: function () {
      sessionStorage.removeItem(API_TOKEN_KEY);
      localStorage.removeItem(SAVED_API_TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    }
  };
})();
