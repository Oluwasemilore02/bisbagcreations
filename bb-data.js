/* Bisbag Creations — shared data layer used by the store AND the admin.
   • Real mode: Firebase (Firestore + Auth), live-synced between store and admin.
   • Demo mode: if firebase-config.js still has placeholders (or the SDK can't load), everything works
     inside this browser only, so you can preview the site before connecting Firebase. */
(function () {
  'use strict';
  var cfg = window.FIREBASE_CONFIG || {};
  var hasSdk = typeof window.firebase !== 'undefined' && window.firebase && typeof window.firebase.initializeApp === 'function';
  var configured = hasSdk && !!(cfg.apiKey && cfg.projectId) && !/PASTE|YOUR_/i.test(String(cfg.apiKey) + String(cfg.projectId));
  var WRITE_TIMEOUT = window.BB_WRITE_TIMEOUT_MS || 5000;
  var HOLD = ['processing', 'shipped', 'delivered']; // order statuses that take stock off the shelf
  var DEFAULTS = {
    whatsapp: '2348023920709', announcement: '', freeShipping: 25000, deliveryFee: 3500,
    lagosDeliveryFee: 3500, otherStateDeliveryFee: 4500,
    areaDeliveryFees: [{ state: 'Lagos', area: 'Egbeda', label: 'Egbeda / Lagos axis', fee: 1200 }],
    couponCode: 'WELCOME10', couponPercent: 10, instagram: '', facebook: '', x: '', tiktok: ''
  };

  /* ---------- shared helpers ---------- */
  function rid(n) {
    var a = new Uint8Array(n);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
  }
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function isPermissionError(e) { return !!e && (e.code === 'permission-denied' || /missing or insufficient permissions/i.test(e.message || '')); }
  function byDateDesc(a, b) { return new Date(b.date) - new Date(a.date); }
  function applyStock(items, order, hold) {
    order.items.forEach(function (i) {
      var p = items.find(function (x) { return x.id === i.id; });
      if (p) p.stock = Math.max(0, (p.stock || 0) + (hold ? -i.qty : i.qty));
    });
  }

  var mem = {}, inflight = {};
  function cacheGet(k) { try { return localStorage.getItem('bb_img_' + k); } catch (e) { return null; } }
  function cacheSet(k, v) {
    try { localStorage.setItem('bb_img_' + k, v); }
    catch (e) {
      try {
        Object.keys(localStorage).filter(function (x) { return x.indexOf('bb_img_') === 0; }).forEach(function (x) { localStorage.removeItem(x); });
        localStorage.setItem('bb_img_' + k, v);
      } catch (e2) { /* storage full: skip caching */ }
    }
  }
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  function hydrateImages(root) {
    (root || document).querySelectorAll('img[data-fs]:not([data-hyd])').forEach(function (img) {
      img.setAttribute('data-hyd', '1');
      var go = function () {
        api.getImage(img.getAttribute('data-fs'), img.getAttribute('data-size') || 'thumb').then(function (url) {
          img.src = url; img.classList.add('loaded');
        }).catch(function () { img.classList.add('loaded'); img.classList.add('failed'); });
      };
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); go(); } }, { rootMargin: '300px' });
        io.observe(img);
      } else go();
    });
  }

  /* ---------- DEMO MODE (browser only) ---------- */
  function makeLocal() {
    var subs = {};
    function emit(k) { (subs[k] || []).slice().forEach(function (f) { f(); }); }
    function watch(k, f) { (subs[k] = subs[k] || []).push(f); return function () { subs[k] = (subs[k] || []).filter(function (x) { return x !== f; }); }; }
    function get(k, d) { try { var v = localStorage.getItem('bb_demo_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
    function set(k, v) {
      try { localStorage.setItem('bb_demo_' + k, JSON.stringify(v)); } catch (e) { throw new Error('Browser storage is full'); }
      emit(k);
    }
    window.addEventListener('storage', function (e) { if (e.key && e.key.indexOf('bb_demo_') === 0) emit(e.key.slice(8)); });
    function listOf() { var l = get('products', null); return l ? l.map(function (x) { return Object.assign({}, x); }) : null; }
    return {
      onProducts: function (cb) { var f = function () { cb(get('products', null), {}); }; setTimeout(f, 0); return watch('products', f); },
      onSettings: function (cb) { var f = function () { cb(get('settings', {})); }; setTimeout(f, 0); return watch('settings', f); },
      createOrder: function (o) {
        var list = get('orders', []); list.unshift(Object.assign({}, o, { date: new Date().toISOString() })); set('orders', list);
        return Promise.resolve({ id: o.id });
      },
      subscribe: function (email) { var s = get('subs', []); if (s.indexOf(email) < 0) s.push(email); set('subs', s); return Promise.resolve(); },
      getImage: function (id, size) {
        var v = get('img_' + (size === 'full' ? 'f_' : 't_') + id, null);
        return v ? Promise.resolve(v) : Promise.reject(new Error('missing'));
      },
      onAuth: function (cb) { var f = function () { cb(get('auth', null)); }; setTimeout(f, 0); return watch('auth', f); },
      signIn: function (email, pw) {
        if (!email || !pw) return Promise.reject({ code: 'auth/invalid-credential' });
        var u = { uid: 'demo-admin', email: email }; set('auth', u); return Promise.resolve(u);
      },
      signOut: function () { set('auth', null); return Promise.resolve(); },
      onOrders: function (cb) {
        var seen = null;
        var f = function () {
          var list = get('orders', []).slice().sort(byDateDesc), added = [];
          if (seen) list.forEach(function (o) { if (!seen[o.id] && o.source !== 'manual') added.push(o); });
          seen = {}; list.forEach(function (o) { seen[o.id] = 1; });
          cb(list, { newOrders: added });
        };
        setTimeout(f, 0); return watch('orders', f);
      },
      setOrderStatus: function (id, patch) {
        var list = get('orders', []), o = list.find(function (x) { return x.id === id; });
        if (!o) return Promise.reject(new Error('Order not found'));
        if (patch.payment !== undefined) o.payment = patch.payment;
        if (typeof patch.paid === 'boolean') o.paid = patch.paid;
        if (patch.status && patch.status !== o.status) {
          var hold = HOLD.indexOf(patch.status) > -1;
          if (hold !== !!o.stockReduced) {
            var items = listOf(); if (items) { applyStock(items, o, hold); set('products', items); }
            o.stockReduced = hold;
          }
          o.status = patch.status;
        }
        set('orders', list); return Promise.resolve();
      },
      deleteOrder: function (id) {
        var list = get('orders', []), o = list.find(function (x) { return x.id === id; });
        if (o && o.stockReduced) { var items = listOf(); if (items) { applyStock(items, o, false); set('products', items); } }
        set('orders', list.filter(function (x) { return x.id !== id; })); return Promise.resolve();
      },
      createManualOrder: function (o) {
        var hold = HOLD.indexOf(o.status) > -1, d = Object.assign({}, o, { date: new Date().toISOString(), stockReduced: hold });
        if (hold) { var items = listOf(); if (items) { applyStock(items, d, true); set('products', items); } }
        var list = get('orders', []); list.unshift(d); set('orders', list); return Promise.resolve({ id: o.id });
      },
      clearOrders: function () { set('orders', []); return Promise.resolve(); },
      restoreOrders: function (list) {
        var cur = get('orders', []), ids = {}; cur.forEach(function (o) { ids[o.id] = 1; });
        list.forEach(function (o) { if (!ids[o.id]) cur.push(o); }); set('orders', cur); return Promise.resolve();
      },
      replaceProducts: function (list) { set('products', list); return Promise.resolve(); },
      addProduct: function (data) {
        var l = listOf() || [], id = l.reduce(function (m, p) { return Math.max(m, p.id); }, 0) + 1;
        l.unshift(Object.assign({ id: id, active: true }, data)); set('products', l); return Promise.resolve(id);
      },
      patchProduct: function (id, patch) {
        var l = listOf(); if (!l) return Promise.reject(new Error('Set up your catalogue first'));
        var p = l.find(function (x) { return x.id === id; }); if (!p) return Promise.reject(new Error('Product not found'));
        Object.assign(p, patch); set('products', l); return Promise.resolve();
      },
      removeProduct: function (id) { var l = listOf() || []; set('products', l.filter(function (x) { return x.id !== id; })); return Promise.resolve(); },
      saveSettings: function (obj) { set('settings', Object.assign(get('settings', {}), obj)); return Promise.resolve(); },
      listSubscribers: function () { return Promise.resolve(get('subs', [])); },
      uploadImage: function (thumb, full) {
        var id = rid(12); set('img_t_' + id, thumb); set('img_f_' + id, full); return Promise.resolve('fs:' + id);
      },
      deleteImage: function (ref) {
        var id = String(ref || '').replace(/^fs:/, ''); try { localStorage.removeItem('bb_demo_img_t_' + id); localStorage.removeItem('bb_demo_img_f_' + id); } catch (e) {}
        return Promise.resolve();
      }
    };
  }

  /* ---------- FIREBASE ---------- */
  function makeFirebase() {
    var fb = window.firebase;
    if (!fb.apps || !fb.apps.length) fb.initializeApp(cfg);
    var db = fb.firestore();
    // Helps on flaky networks / ISPs that block Firestore's default streaming connection.
    try {
      if (typeof db.settings === "function")
        db.settings({ experimentalAutoDetectLongPolling: true, merge: true });
    } catch (e) {}
    var FV = fb.firestore.FieldValue,
      TS = fb.firestore.Timestamp;    var auth = typeof fb.auth === 'function' ? fb.auth() : null;
    var stamp = function () { return FV.serverTimestamp(); };
    var PROD = db.collection('catalog').doc('products'), SET = db.collection('catalog').doc('settings'), ORD = db.collection('orders');
    function needAuth() { if (!auth) throw new Error('Auth SDK is not loaded on this page'); return auth; }
    function itemsOf(snap) { return snap.exists && Array.isArray(snap.data().items) ? snap.data().items.map(function (x) { return Object.assign({}, x); }) : null; }
    function guardSize(list) { if (JSON.stringify(list).length > 900000) throw new Error('Catalogue is too large for one document (reduce product text).'); }
    function normOrder(d) {
      var o = d.data(); o.id = d.id;
      var t = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : new Date();
      o.date = t.toISOString(); delete o.createdAt; return o;
    }
    return {
      onProducts: function (cb, err) {
        return PROD.onSnapshot(function (s) { cb(itemsOf(s), { fromCache: !!(s.metadata && s.metadata.fromCache) }); }, err || function () {});
      },
      onSettings: function (cb, err) {
        return SET.onSnapshot(function (s) { cb(s.exists ? s.data() : {}); }, err || function () {});
      },
      createOrder: function (o) {
        var data = Object.assign({}, o); delete data.date; data.createdAt = stamp();
        return withTimeout(ORD.doc(o.id).set(data), WRITE_TIMEOUT).then(function () { return { id: o.id }; });
      },
      subscribe: function (email) {
        return withTimeout(db.collection('subscribers').doc(email).set({ email: email, createdAt: stamp() }), WRITE_TIMEOUT).catch(function (e) {
          if (isPermissionError(e)) return; // already subscribed (updates are blocked by the rules)
          throw e;
        });
      },
      getImage: function (id, size) {
        var key = (size === 'full' ? 'f_' : 't_') + id;
        if (mem[key]) return Promise.resolve(mem[key]);
        if (key[0] === 't') { var c = cacheGet(key); if (c) { mem[key] = c; return Promise.resolve(c); } }
        if (inflight[key]) return inflight[key];
        inflight[key] = db.collection('productImages').doc(key).get().then(function (s) {
          delete inflight[key];
          if (!s.exists) throw new Error('missing');
          var url = s.data().data; mem[key] = url; if (key[0] === 't') cacheSet(key, url); return url;
        }, function (e) { delete inflight[key]; throw e; });
        return inflight[key];
      },
      /* admin */
      onAuth: function (cb) { return needAuth().onAuthStateChanged(function (u) { cb(u ? { uid: u.uid, email: u.email } : null); }); },
      signIn: function (email, pw) { return needAuth().signInWithEmailAndPassword(email, pw).then(function (r) { return { uid: r.user.uid, email: r.user.email }; }); },
      signOut: function () { return needAuth().signOut(); },
      onOrders: function (cb, err) {
        var first = true;
        return ORD.orderBy('createdAt', 'desc').onSnapshot(function (snap) {
          var list = snap.docs.map(normOrder), added = [];
          if (!first && !(snap.metadata && snap.metadata.fromCache)) {
            snap.docChanges().forEach(function (c) { if (c.type === 'added' && !(c.doc.metadata && c.doc.metadata.hasPendingWrites)) added.push(normOrder(c.doc)); });
          }
          first = false; cb(list, { newOrders: added });
        }, err || function () {});
      },
      setOrderStatus: function (id, patch) {
        var oref = ORD.doc(id);
        return db.runTransaction(function (tx) {
          return tx.get(oref).then(function (os) {
            if (!os.exists) throw new Error('Order not found');
            var o = os.data(), upd = {};
            if (patch.payment !== undefined) upd.payment = patch.payment;
            if (typeof patch.paid === 'boolean') upd.paid = patch.paid;
            var finish = function () { tx.update(oref, upd); };
            if (patch.status && patch.status !== o.status) {
              upd.status = patch.status;
              var hold = HOLD.indexOf(patch.status) > -1;
              if (hold !== !!o.stockReduced) {
                return tx.get(PROD).then(function (ps) {
                  var items = itemsOf(ps);
                  if (items) { applyStock(items, o, hold); tx.set(PROD, { items: items, updatedAt: stamp() }, { merge: true }); }
                  upd.stockReduced = hold; finish();
                });
              }
            }
            finish();
          });
        });
      },
      deleteOrder: function (id) {
        var oref = ORD.doc(id);
        return db.runTransaction(function (tx) {
          return tx.get(oref).then(function (os) {
            if (!os.exists) return;
            var o = os.data();
            if (o.stockReduced) {
              return tx.get(PROD).then(function (ps) {
                var items = itemsOf(ps);
                if (items) { applyStock(items, o, false); tx.set(PROD, { items: items, updatedAt: stamp() }, { merge: true }); }
                tx.delete(oref);
              });
            }
            tx.delete(oref);
          });
        });
      },
      createManualOrder: function (o) {
        var oref = ORD.doc(o.id), hold = HOLD.indexOf(o.status) > -1;
        var data = Object.assign({}, o, { stockReduced: hold, createdAt: stamp() }); delete data.date;
        return db.runTransaction(function (tx) {
          if (!hold) { tx.set(oref, data); return Promise.resolve(); }
          return tx.get(PROD).then(function (ps) {
            var items = itemsOf(ps);
            if (items) { applyStock(items, o, true); tx.set(PROD, { items: items, updatedAt: stamp() }, { merge: true }); }
            tx.set(oref, data);
          });
        }).then(function () { return { id: o.id }; });
      },
      clearOrders: function () {
        return ORD.get().then(function (snap) {
          var docs = snap.docs, chain = Promise.resolve();
          for (var i = 0; i < docs.length; i += 400) (function (chunk) {
            chain = chain.then(function () { var b = db.batch(); chunk.forEach(function (d) { b.delete(d.ref); }); return b.commit(); });
          })(docs.slice(i, i + 400));
          return chain;
        });
      },
      restoreOrders: function (list) {
        var chain = Promise.resolve();
        for (var i = 0; i < list.length; i += 400) (function (chunk) {
          chain = chain.then(function () {
            var b = db.batch();
            chunk.forEach(function (o) {
              var d = Object.assign({}, o); var when = new Date(o.date); delete d.date;
              d.createdAt = isNaN(when) ? stamp() : TS.fromDate(when); b.set(ORD.doc(o.id), d);
            });
            return b.commit();
          });
        })(list.slice(i, i + 400));
        return chain;
      },
      replaceProducts: function (list) { guardSize(list); return PROD.set({ items: list, updatedAt: stamp() }); },
      addProduct: function (data) {
        return db.runTransaction(function (tx) {
          return tx.get(PROD).then(function (s) {
            var list = itemsOf(s) || [], id = list.reduce(function (m, p) { return Math.max(m, p.id); }, 0) + 1;
            list.unshift(Object.assign({ id: id, active: true }, data)); guardSize(list);
            tx.set(PROD, { items: list, updatedAt: stamp() }); return id;
          });
        });
      },
      patchProduct: function (id, patch) {
        return db.runTransaction(function (tx) {
          return tx.get(PROD).then(function (s) {
            var list = itemsOf(s); if (!list) throw new Error('Set up your catalogue first');
            var p = list.find(function (x) { return x.id === id; }); if (!p) throw new Error('Product not found');
            Object.assign(p, patch); guardSize(list); tx.set(PROD, { items: list, updatedAt: stamp() });
          });
        });
      },
      removeProduct: function (id) {
        return db.runTransaction(function (tx) {
          return tx.get(PROD).then(function (s) {
            var list = itemsOf(s) || []; tx.set(PROD, { items: list.filter(function (x) { return x.id !== id; }), updatedAt: stamp() });
          });
        });
      },
      saveSettings: function (obj) { return SET.set(Object.assign({}, obj, { updatedAt: stamp() }), { merge: true }); },
      listSubscribers: function () {
        return db.collection('subscribers').get().then(function (s) { return s.docs.map(function (d) { return d.data().email || d.id; }); });
      },
      uploadImage: function (thumb, full) {
        var id = rid(12), b = db.batch(), imgs = db.collection('productImages');
        b.set(imgs.doc('t_' + id), { data: thumb, createdAt: stamp() });
        b.set(imgs.doc('f_' + id), { data: full, createdAt: stamp() });
        return b.commit().then(function () { return 'fs:' + id; });
      },
      deleteImage: function (ref) {
        var id = String(ref || '').replace(/^fs:/, ''); if (!id) return Promise.resolve();
        var b = db.batch(), imgs = db.collection('productImages'); b.delete(imgs.doc('t_' + id)); b.delete(imgs.doc('f_' + id));
        return b.commit().catch(function () {});
      }
    };
  }

  var impl = configured ? makeFirebase() : makeLocal();
  var api = Object.assign({
    mode: configured ? 'firebase' : 'local',
    projectId: configured ? cfg.projectId : '',
    defaults: DEFAULTS, hold: HOLD, blank: BLANK,
    rid: rid, isPermissionError: isPermissionError, hydrateImages: hydrateImages
  }, impl);
  window.BBData = api;
})();
