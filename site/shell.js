// Family Fit's front door. This file is public, so it holds no family details at all.
// It signs a family member in (Supabase Auth), fetches the app's own screens from the database
// once signed in (they hold personal details, so they never sit on the website), keeps a copy of
// the family's data on the device so the app works offline, and sends changes back when there's signal.
// The app's screens talk to the data through window.claude.use("db"), the same interface they used
// as a Claude artifact, so they run here unchanged.
(function () {
  'use strict';

  // ---------- settings ----------
  // The publishable key is meant to be public. It can't read anything by itself: every family
  // function checks for a signed-in family member.
  // A local test copy (ports 5290 to 5299) talks to a pretend server instead of Supabase.
  var DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^529\d$/.test(location.port);
  var SB = DEV ? location.origin + '/__sb' : 'https://kyosepbdxjwugunylvyo.supabase.co';
  var KEY = DEV ? 'dev' : 'sb_publishable_aF-RQDFSinN2i1sGyjG3gg_DqA0x6TI';
  // Logins are first names. Supabase wants an email address, so each name gets this made-up ending,
  // which can never receive mail.
  var LOGIN_DOMAIN = 'familyfit.invalid';
  // Holeshot lives beside Family Fit on the same website. A local preview uses Holeshot's own preview.
  var HOLESHOT = DEV || location.hostname === 'localhost' ? 'http://localhost:5199/' : '/holeshot/';
  var PULL_EVERY = 15000;
  var AUTH_KEY = 'ff.auth.v1';
  var ME_KEY = 'ff.me.v1';
  var NAMES_KEY = 'ff.names.v1';

  var $ = function (id) { return document.getElementById(id); };
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function getLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setLS(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function readJSON(k) { try { return JSON.parse(getLS(k)); } catch (e) { return null; } }

  // ---------- a small key-value store on the device (IndexedDB) ----------
  var idbOpen = null;
  function idb() {
    if (!idbOpen) idbOpen = new Promise(function (ok, bad) {
      var rq = indexedDB.open('family-fit', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { ok(rq.result); };
      rq.onerror = function () { bad(rq.error); };
    });
    return idbOpen;
  }
  function kvGet(k) {
    return idb().then(function (db) {
      return new Promise(function (ok) {
        var rq = db.transaction('kv').objectStore('kv').get(k);
        rq.onsuccess = function () { ok(rq.result); };
        rq.onerror = function () { ok(undefined); };
      });
    }).catch(function () { return undefined; });
  }
  function kvSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (ok) {
        var tx = db.transaction('kv', 'readwrite');
        if (v === undefined) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k);
        tx.oncomplete = function () { ok(); };
        tx.onerror = function () { ok(); };
      });
    }).catch(function () {});
  }

  // ---------- signing in ----------
  var session = readJSON(AUTH_KEY);
  var refreshing = null;
  function saveSession(s) {
    session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user_id: s.user ? s.user.id : (session && session.user_id) } : null;
    setLS(AUTH_KEY, session ? JSON.stringify(session) : null);
  }
  // Another tab on this device may have refreshed the login.
  addEventListener('storage', function (e) { if (e.key === AUTH_KEY) session = readJSON(AUTH_KEY); });

  function authCall(path, body, token) {
    var h = { apikey: KEY, 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(SB + '/auth/v1/' + path, { method: path === 'user' ? 'PUT' : 'POST', headers: h, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }
  function signIn(name, password) {
    var email = name.trim().toLowerCase().replace(/[^a-z]/g, '') + '@' + LOGIN_DOMAIN;
    return authCall('token?grant_type=password', { email: email, password: password }).then(function (r) {
      if (r.status !== 200 || !r.body.access_token) {
        var e = new Error('login'); e.status = r.status; throw e;
      }
      saveSession(r.body);
      return r.body;
    });
  }
  // A fresh pass when the old one is about to run out. Offline, the old one is kept and the app carries on.
  function token() {
    if (!session) return Promise.reject(new Error('signed-out'));
    if (session.expires_at - 60 > Date.now() / 1000) return Promise.resolve(session.access_token);
    if (!refreshing) {
      refreshing = authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function (r) {
        refreshing = null;
        if (r.status === 200 && r.body.access_token) { saveSession(r.body); return session.access_token; }
        var fresh = readJSON(AUTH_KEY);
        if (fresh && fresh.expires_at - 60 > Date.now() / 1000) { session = fresh; return session.access_token; }
        if (r.status >= 400 && r.status < 500) { var e = new Error('signed-out'); e.signedOut = true; throw e; }
        throw new Error('offline');
      }, function () { refreshing = null; throw new Error('offline'); });
    }
    return refreshing;
  }
  function rpc(fn, args, retried) {
    return token().then(function (t) {
      return fetch(SB + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
    }).then(function (r) {
      if (r.status === 401 && !retried && session) { session.expires_at = 0; return rpc(fn, args, true); }
      if (r.status === 401) { var e = new Error('signed-out'); e.signedOut = true; throw e; }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  // ---------- the family's data, kept on the device ----------
  // mirror: what the server last said, per path {d: data, r: rev}. pending: changes made on this
  // device that haven't reached the server yet. What the app sees is the mirror with pending on top.
  var mirror = { rev: 0, docs: {} };
  var pending = {};
  var seq = 0;
  var listeners = [];
  var storeReady = null;

  function loadStore() {
    if (!storeReady) storeReady = Promise.all([kvGet('mirror'), kvGet('pending')]).then(function (v) {
      if (v[0] && v[0].docs) mirror = v[0];
      if (v[1]) pending = v[1];
      var uid = session && session.user_id;
      Object.keys(pending).forEach(function (p) { if (pending[p].uid !== uid) delete pending[p]; });
      Object.keys(pending).forEach(function (p) { seq = Math.max(seq, pending[p].seq || 0); });
    });
    return storeReady;
  }
  var saveTimer = null;
  function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { kvSet('mirror', mirror); kvSet('pending', pending); }, 200);
  }
  function view(path) {
    if (pending[path]) return pending[path].del ? undefined : pending[path].data;
    var m = mirror.docs[path];
    return m && m.d != null ? m.d : undefined;
  }
  function allPaths() {
    var s = {};
    Object.keys(mirror.docs).forEach(function (p) { s[p] = 1; });
    Object.keys(pending).forEach(function (p) { s[p] = 1; });
    return Object.keys(s);
  }

  // Tell the app's screens what changed, a batch at a time.
  var dirty = {};
  var emitting = false;
  function touched(paths) {
    paths.forEach(function (p) { dirty[p] = 1; });
    if (emitting) return;
    emitting = true;
    setTimeout(function () {
      emitting = false;
      var d = dirty; dirty = {};
      listeners.forEach(function (l) {
        var hit = l.col ? Object.keys(d).some(function (p) { return p.indexOf(l.col + '/') === 0; }) : !!d[l.path];
        if (hit) fire(l);
      });
    }, 0);
  }
  function fire(l) {
    try {
      if (l.col) {
        var docs = allPaths().filter(function (p) { return p.indexOf(l.col + '/') === 0 && p.split('/').length === 2 && view(p) !== undefined; }).sort()
          .map(function (p) { var data = view(p); return { id: p.slice(l.col.length + 1), data: function () { return clone(data); } }; });
        l.next({ size: docs.length, empty: !docs.length, docs: docs });
      } else {
        var data = view(l.path);
        l.next({ exists: data !== undefined, id: l.path.split('/').pop(), data: function () { return clone(data); } });
      }
    } catch (e) { setTimeout(function () { throw e; }); }
  }

  function localWrite(path, data, del) {
    var p = pending[path];
    var m = mirror.docs[path];
    if (!p) p = pending[path] = { base: m ? m.r : 0, baseData: m && m.d != null ? clone(m.d) : undefined };
    p.data = del ? undefined : clone(data);
    p.del = !!del;
    p.seq = ++seq;
    p.uid = session && session.user_id;
    saveStore();
    touched([path]);
    flushSoon();
    return Promise.resolve();
  }

  // Fold my change into a newer copy someone else saved: anything I didn't touch takes theirs,
  // anything they didn't touch keeps mine, and where we both changed the same thing, mine wins.
  function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
  function same(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !same(a[ka[i]], b[ka[i]])) return false;
    return true;
  }
  function merge3(base, mine, theirs) {
    if (same(mine, base)) return theirs;
    if (same(theirs, base)) return mine;
    if (isObj(base) && isObj(mine) && isObj(theirs)) {
      var out = {}, keys = {};
      [base, mine, theirs].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
      Object.keys(keys).forEach(function (k) { var v = merge3(base[k], mine[k], theirs[k]); if (v !== undefined) out[k] = v; });
      return out;
    }
    if (mine === undefined && isObj(base) && isObj(theirs)) return theirs;
    return mine;
  }

  var flushing = false;
  var flushTimer = null;
  var lastError = '';
  function flushSoon(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms == null ? 300 : ms); }
  function flush() {
    if (flushing || !session) return Promise.resolve();
    var paths = Object.keys(pending).sort(function (a, b) { return pending[a].seq - pending[b].seq; });
    if (!paths.length) return Promise.resolve();
    flushing = true;
    var i = 0, tries = 0;
    function next() {
      if (i >= paths.length) return Promise.resolve();
      var path = paths[i], p = pending[path];
      if (!p) { i++; return next(); }
      var sent = p.seq;
      return rpc('ff_put', { p_path: path, p_data: p.del ? null : p.data, p_base: p.base, p_delete: p.del }).then(function (res) {
        var now = pending[path];
        if (res && res.ok) {
          mirror.docs[path] = { d: p.del ? null : res.data, r: res.rev };
          if (now && now.seq === sent) delete pending[path];
          else if (now) { now.base = res.rev; now.baseData = p.del ? undefined : clone(res.data); }
          i++; tries = 0;
        } else if (res && res.reason === 'stale' && tries < 3) {
          tries++;
          if (now) {
            var theirs = res.data == null ? undefined : res.data;
            now.data = now.del ? undefined : merge3(now.baseData, now.data, theirs);
            if (now.data === undefined && !now.del) now.data = theirs;
            now.base = res.rev; now.baseData = clone(theirs);
          }
          mirror.docs[path] = { d: res.data, r: res.rev };
        } else {
          // Not allowed for this login, or something odd: drop the change and go back to the server's copy.
          if (res && res.rev != null) mirror.docs[path] = { d: res.data, r: res.rev };
          if (now && now.seq === sent) delete pending[path];
          lastError = res && res.reason ? res.reason : 'refused';
          i++; tries = 0;
        }
        saveStore();
        touched([path]);
        return next();
      });
    }
    return next().then(function () {
      flushing = false;
      status();
      if (Object.keys(pending).length) flushSoon(500);
      else pullSoon(200);
    }, function (e) {
      flushing = false;
      if (e && e.signedOut) return signedOut();
      status();
      flushSoon(15000);
    });
  }

  var pulling = false;
  var pullTimer = null;
  var lastPull = 0;
  function pullSoon(ms) { clearTimeout(pullTimer); pullTimer = setTimeout(pull, ms || 0); }
  function pull() {
    clearTimeout(pullTimer);
    if (pulling || !session) return Promise.resolve();
    pulling = true;
    return rpc('ff_pull', { p_since: mirror.rev || 0 }).then(function (res) {
      pulling = false;
      if (!res || !res.ok) throw new Error(res && res.reason || 'pull');
      var changed = [];
      res.docs.forEach(function (x) {
        var had = mirror.docs[x.p];
        if (had && had.r >= x.r) return;
        mirror.docs[x.p] = { d: x.x ? null : x.d, r: x.r };
        changed.push(x.p);
      });
      mirror.rev = Math.max(mirror.rev || 0, res.rev || 0);
      lastPull = Date.now();
      if (changed.length) { saveStore(); touched(changed); }
      status();
      pullTimer = setTimeout(pull, PULL_EVERY);
    }, function (e) {
      pulling = false;
      if (e && e.signedOut) return signedOut();
      status();
      pullTimer = setTimeout(pull, PULL_EVERY * 2);
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && session) { flushSoon(0); pullSoon(0); }
  });
  addEventListener('online', function () { if (session) { flushSoon(0); pullSoon(0); } });

  // The interface the app's screens were written against.
  var db = {
    collection: function (col) {
      return {
        onSnapshot: function (next) {
          var l = { col: col, next: next };
          listeners.push(l);
          loadStore().then(function () { fire(l); });
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        },
      };
    },
    doc: function (path) {
      return {
        onSnapshot: function (next) {
          var l = { path: path, next: next };
          listeners.push(l);
          loadStore().then(function () { fire(l); });
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        },
        set: function (data) { return localWrite(path, data, false); },
        delete: function () { return localWrite(path, null, true); },
      };
    },
  };
  // AI photo reading isn't switched on here, so "sample" answers with nothing and those buttons stay hidden.
  window.claude = { use: function (what) { return Promise.resolve(what === 'db' ? db : null); } };

  // ---------- small notices ----------
  var toastEl = null;
  function toast(text, button, onTap) {
    if (toastEl) toastEl.remove();
    if (!text) { toastEl = null; return; }
    toastEl = document.createElement('div');
    toastEl.className = 'ffs-toast';
    toastEl.setAttribute('role', 'status');
    var s = document.createElement('span'); s.textContent = text; toastEl.appendChild(s);
    if (button) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = button;
      b.addEventListener('click', onTap); toastEl.appendChild(b);
    }
    document.body.appendChild(toastEl);
  }
  var shownOffline = false;
  function status() {
    var waiting = Object.keys(pending).length;
    var offline = waiting && (!navigator.onLine || Date.now() - lastPull > PULL_EVERY * 3);
    if (offline && !shownOffline) { shownOffline = true; toast('No signal. Saved on this device, it sends when you\'re back online.'); setTimeout(function () { if (shownOffline) toast(''); }, 6000); }
    if (!waiting && shownOffline) { shownOffline = false; toast(''); }
  }

  // ---------- Holeshot, inside the app ----------
  var hsBusy = null;
  function holeshotSync() {
    if (!hsBusy) hsBusy = rpc('ff_holeshot_sync', {}).then(function (r) { hsBusy = null; pullSoon(0); return r; }, function (e) { hsBusy = null; throw e; });
    return hsBusy;
  }
  function openHoleshot() {
    if (document.querySelector('.ffs-hole')) return;
    var box = document.createElement('div');
    box.className = 'ffs-hole';
    var bar = document.createElement('div'); bar.className = 'ffs-holebar';
    var back = document.createElement('button'); back.type = 'button'; back.textContent = '‹ Family Fit';
    var own = document.createElement('a'); own.href = HOLESHOT; own.target = '_blank'; own.rel = 'noopener'; own.textContent = 'Open on its own';
    var frame = document.createElement('iframe');
    frame.src = HOLESHOT;
    frame.title = 'Holeshot';
    frame.allow = 'autoplay; microphone; clipboard-write; fullscreen; web-share';
    bar.appendChild(back); bar.appendChild(own); box.appendChild(bar); box.appendChild(frame);
    document.body.appendChild(box);
    document.documentElement.style.overflow = 'hidden';
    back.addEventListener('click', function () {
      box.remove();
      document.documentElement.style.overflow = '';
      holeshotSync().catch(function () {});
    });
  }

  // ---------- account card for the app's settings ----------
  function account(el) {
    var me = FF.me || {};
    el.innerHTML = '';
    el.className = (el.className + ' ffs-acct').trim();
    var p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Signed in as ' + (me.who ? me.who.charAt(0).toUpperCase() + me.who.slice(1) : '?') + (me.role === 'parent' ? ' (parent).' : '.') + ' Your log is saved to Family Fit and works offline.';
    el.appendChild(p);
    var row = document.createElement('div'); row.className = 'ffs-row';
    var pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = 'New password'; pw.autocomplete = 'new-password';
    var save = document.createElement('button'); save.type = 'button'; save.textContent = 'Change my password';
    row.appendChild(pw); row.appendChild(save); el.appendChild(row);
    var msg = document.createElement('p'); msg.className = 'sub'; msg.setAttribute('aria-live', 'polite'); el.appendChild(msg);
    var out = document.createElement('button'); out.type = 'button'; out.className = 'ffs-sec'; out.textContent = 'Sign out of this device';
    el.appendChild(out);
    var ver = document.createElement('p'); ver.className = 'sub'; ver.style.fontSize = '12px';
    ver.textContent = 'Version ' + (FF.version || '?');
    el.appendChild(ver);
    save.addEventListener('click', function () {
      var v = pw.value;
      // The server's rules: a capital, a small letter, a number and a symbol, and not a password that has leaked.
      var rules = 'Use a capital, a small letter, a number and a symbol, like Tiger-comet42.';
      if (v.length < 8 || !/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v) || !/[^A-Za-z0-9]/.test(v)) { msg.textContent = rules; return; }
      save.disabled = true; msg.textContent = 'Saving...';
      token().then(function (t) { return authCall('user', { password: v }, t); }).then(function (r) {
        save.disabled = false;
        if (r.status === 200) { pw.value = ''; msg.textContent = 'Password changed. Use the new one next time.'; }
        else if (r.body && r.body.error_code === 'weak_password') msg.textContent = 'That one is too easy to guess. ' + rules;
        else msg.textContent = 'That didn\'t work. ' + rules;
      }, function () { save.disabled = false; msg.textContent = 'No signal. Try again when you\'re online.'; });
    });
    out.addEventListener('click', function () {
      if (Object.keys(pending).length && !confirm('Some changes haven\'t reached Family Fit yet. Sign out anyway and lose them?')) return;
      signOut();
    });
  }

  // ---------- starting up ----------
  // holeshotReport: the boys' Holeshot results for the Boys page. The server answers a parent only.
  var FF = window.FF = { me: readJSON(ME_KEY), holeshotSync: holeshotSync, openHoleshot: openHoleshot, account: account, version: '', online: function () { return !!lastPull && Date.now() - lastPull < PULL_EVERY * 3; },
    holeshotReport: function (days) { return rpc('ff_holeshot_report', { p_days: days || 30 }); } };

  function bootMsg(t) { $('ff-boot-msg').textContent = t; }
  function showLogin(err) {
    $('ff-boot').hidden = true;
    $('ff-login').hidden = false;
    $('ff-err').textContent = err || '';
    var known = readJSON(NAMES_KEY) || [];
    var box = $('ff-known');
    box.innerHTML = '';
    box.hidden = !known.length;
    known.forEach(function (n) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = n;
      b.addEventListener('click', function () {
        $('ff-name').value = n;
        [].forEach.call(box.children, function (c) { c.setAttribute('aria-pressed', String(c === b)); });
        $('ff-pass').focus();
      });
      box.appendChild(b);
    });
    if (known.length === 1) $('ff-name').value = known[0];
  }
  $('ff-login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('ff-name').value.trim(), pass = $('ff-pass').value;
    if (!name || !pass) return;
    $('ff-go').disabled = true; $('ff-err').textContent = '';
    var before = session && session.user_id;
    signIn(name, pass).then(function () {
      if (before && before !== session.user_id) { pending = {}; kvSet('pending', undefined); }
      return rpc('ff_me', {});
    }).then(function (me) {
      $('ff-go').disabled = false;
      if (!me || !me.ok) { saveSession(null); showLogin('That login isn\'t part of Family Fit.'); return; }
      var nice = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      var known = (readJSON(NAMES_KEY) || []).filter(function (n) { return n.toLowerCase() !== nice.toLowerCase(); });
      known.unshift(nice);
      setLS(NAMES_KEY, JSON.stringify(known.slice(0, 4)));
      FF.me = { who: me.who, role: me.role };
      setLS(ME_KEY, JSON.stringify(FF.me));
      $('ff-pass').value = '';
      $('ff-login').hidden = true; $('ff-boot').hidden = false;
      start();
    }, function (err) {
      $('ff-go').disabled = false;
      showLogin(err && err.status === 400 ? 'That name and password don\'t match.' : 'Couldn\'t reach Family Fit. Check the signal and try again.');
    });
  });

  function signedOut() {
    // The login ran out and couldn't be renewed. The data stays on the device until someone signs in again.
    saveSession(null);
    location.reload();
  }
  function signOut() {
    var t = session && session.access_token;
    if (t) authCall('logout', {}, t).catch(function () {});
    saveSession(null);
    setLS(ME_KEY, null);
    // Clear this app's saved data from the device, but leave Holeshot's progress alone.
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('holeshot.') !== 0 && k !== NAMES_KEY) localStorage.removeItem(k); });
    } catch (e) { /* storage blocked */ }
    Promise.all([kvSet('mirror', undefined), kvSet('pending', undefined), kvSet('app', undefined)]).then(function () { location.replace(location.pathname); });
  }
  FF.signOut = signOut;

  // The app's screens arrive as one block of HTML. Styles go in the head, the rest in the body,
  // and each script is run in order, as the page would have run them.
  function runApp(app) {
    var doc = new DOMParser().parseFromString(app.code, 'text/html');
    FF.version = app.version.slice(0, 10);
    var t = doc.querySelector('title');
    if (t) document.title = t.textContent;
    [].forEach.call(doc.querySelectorAll('style, link[rel=stylesheet]'), function (n) { document.head.appendChild(document.importNode(n, true)); });
    $('ff-boot').remove();
    $('ff-login').remove();
    var kids = [].slice.call(doc.body.childNodes);
    kids.forEach(function (n) {
      if (n.nodeName === 'SCRIPT') {
        var s = document.createElement('script');
        s.textContent = n.textContent;
        document.body.appendChild(s);
      } else if (n.nodeName !== 'TITLE' && n.nodeName !== 'STYLE' && n.nodeName !== 'LINK') {
        document.body.appendChild(document.importNode(n, true));
      }
    });
  }

  function fetchApp() {
    return rpc('ff_app_code', {}).then(function (a) {
      if (!a || !a.code) throw new Error('no-app');
      return kvSet('app', a).then(function () { return a; });
    });
  }

  function start() {
    bootMsg('Opening…');
    if (!FF.me) {
      return rpc('ff_me', {}).then(function (me) {
        if (!me || !me.ok) { saveSession(null); return showLogin('That login isn\'t part of Family Fit.'); }
        FF.me = { who: me.who, role: me.role }; setLS(ME_KEY, JSON.stringify(FF.me));
        start();
      }, function (e) { if (e && e.signedOut) return showLogin(); bootMsg('Couldn\'t reach Family Fit. Check the signal.'); setTimeout(start, 5000); });
    }
    Promise.all([loadStore(), kvGet('app')]).then(function (v) {
      var app = v[1];
      if (app && app.code) return app;
      bootMsg('Fetching Family Fit for this device…');
      return fetchApp();
    }).then(function (app) {
      runApp(app);
      flushSoon(0);
      pull();
      // A newer version waits on the device and is used next time it opens, or now with a tap.
      rpc('ff_app_version', {}).then(function (v) {
        if (v && v !== app.version) return fetchApp().then(function () { toast('A new version of Family Fit is ready.', 'Update', function () { location.reload(); }); });
      }).catch(function () {});
      rpc('ff_me', {}).then(function (me) {
        if (me && me.ok && (me.who !== FF.me.who || me.role !== FF.me.role)) { setLS(ME_KEY, JSON.stringify({ who: me.who, role: me.role })); location.reload(); }
      }).catch(function () {});
    }).catch(function (e) {
      if (e && e.signedOut) return showLogin();
      bootMsg('Family Fit needs a signal the first time it opens on a device. Trying again…');
      setTimeout(start, 5000);
    });
  }

  if ('serviceWorker' in navigator && !DEV) addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  if (session) start(); else showLogin();
})();
