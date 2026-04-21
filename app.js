/* ============================================================
   deku — Multi-Factory Management App  |  app.js
   ============================================================ */
'use strict';

/* ===================== FIREBASE ===================== */
const firebaseConfig = {
  apiKey: "AIzaSyDYV6o5w35a4Cde4CVdgI8I-eeNr_yhI8U",
  authDomain: "zohir-farm-app.firebaseapp.com",
  projectId: "zohir-farm-app",
  storageBucket: "zohir-farm-app.firebasestorage.app",
  messagingSenderId: "904262267425",
  appId: "1:904262267425:web:31bb8f15b9aa10fe712960"
};
firebase.initializeApp(firebaseConfig);
const fs = firebase.firestore();
const auth = firebase.auth();

// Configure Firestore for better real-time performance
fs.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED });

// Enable multi-tab persistence — allows real-time sync across tabs/devices
fs.enablePersistence({ synchronizeTabs: true }).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('Persistence: multiple tabs detected, using memory cache');
  } else if (err.code === 'unimplemented') {
    console.warn('Persistence not supported on this browser');
  }
});

/* ===================== AUTH STATE ===================== */
let CURRENT_USER = null;  // Firebase user object
let CURRENT_ROLE = null;  // 'owner' | 'worker' | 'partner'
let CURRENT_USER_NAME = '';
// Secret code that new owners must enter when registering
const ADMIN_SECRET_CODE = 'ZOHIR2025';
// Developer secret — required to register a partner account
const DEV_SECRET_CODE = 'dekudeku1123';
// Tracks whether dev password was verified for the current partner account creation attempt
let _devPasswordVerified = false;

/* ---------- UI helpers ---------- */
function showAuthScreen() {
  document.getElementById('global-loader').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('factory-screen').style.display = 'none';
  document.getElementById('app-wrapper').style.display = 'none';
}

function hideAuthScreen() {
  document.getElementById('auth-screen').style.display = 'none';
}

function switchAuthTab(tab) {
  document.getElementById('form-login').style.display    = tab === 'login'    ? 'flex' : 'none';
  document.getElementById('form-register').style.display = tab === 'register' ? 'flex' : 'none';
  document.getElementById('tab-login').classList.toggle('active',    tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  clearAuthErrors();
}

function clearAuthErrors() {
  ['login-error','reg-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('visible'); el.textContent = ''; }
  });
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

function togglePassVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

function setAuthBtnLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? '⏳ جاري المعالجة...' : (btnId === 'btn-login' ? '🔑 دخول' : '✅ إنشاء الحساب');
}

/* ---------- Register role chooser ---------- */
function initRoleChooser() {
  const roleSelect   = document.getElementById('reg-role');
  const adminCodeWrap = document.getElementById('reg-admin-code-wrap');
  const devCodeWrap   = document.getElementById('reg-dev-code-wrap');
  if (!roleSelect) return;
  roleSelect.addEventListener('change', () => {
    const r = roleSelect.value;
    if (adminCodeWrap) adminCodeWrap.style.display = r === 'owner' ? 'flex' : 'none';
    if (devCodeWrap)   devCodeWrap.style.display   = r === 'partner' ? 'flex' : 'none';
  });
  if (adminCodeWrap) adminCodeWrap.style.display = 'none';
  if (devCodeWrap)   devCodeWrap.style.display   = 'none';
  roleSelect.value = 'worker';
}

/* ---------- REGISTER ---------- */
async function doRegister() {
  clearAuthErrors();
  const name      = document.getElementById('reg-name').value.trim();
  const email     = document.getElementById('reg-email').value.trim();
  const password  = document.getElementById('reg-password').value;
  const role      = document.getElementById('reg-role').value;
  const adminCode = document.getElementById('reg-admin-code').value.trim();
  const devCode   = document.getElementById('reg-dev-code')?.value.trim() || '';

  if (!name)     return showAuthError('reg-error', '⚠️ يرجى إدخال الاسم الكامل');
  if (!email)    return showAuthError('reg-error', '⚠️ يرجى إدخال البريد الإلكتروني');
  if (password.length < 6) return showAuthError('reg-error', '⚠️ كلمة المرور يجب أن تكون 6 أحرف على الأقل');
  if (role === 'owner' && adminCode !== ADMIN_SECRET_CODE)
    return showAuthError('reg-error', '❌ رمز الإدارة غير صحيح');
  if (role === 'partner' && devCode !== DEV_SECRET_CODE)
    return showAuthError('reg-error', '❌ رمز المطور غير صحيح');

  setAuthBtnLoading('btn-register', true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    // Save role + name in Firestore users collection
    await fs.collection('users').doc(cred.user.uid).set({
      name, email, role,
      createdAt: new Date().toISOString()
    });
    showToast(`✅ تم إنشاء الحساب — مرحباً ${name}!`);
    // onAuthStateChanged will fire and handle the rest
  } catch (e) {
    setAuthBtnLoading('btn-register', false);
    showAuthError('reg-error', translateAuthError(e.code));
  }
}

/* ---------- LOGIN ---------- */
async function doLogin() {
  clearAuthErrors();
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email)    return showAuthError('login-error', '⚠️ يرجى إدخال البريد الإلكتروني');
  if (!password) return showAuthError('login-error', '⚠️ يرجى إدخال كلمة المرور');

  setAuthBtnLoading('btn-login', true);
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged handles what happens next
  } catch (e) {
    setAuthBtnLoading('btn-login', false);
    showAuthError('login-error', translateAuthError(e.code));
  }
}

/* ---------- LOGOUT ---------- */
async function doLogout() {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  stopFactorySync();
  CURRENT_FACTORY = null;
  CURRENT_USER = null;
  CURRENT_ROLE = null;
  document.body.className = '';
  await auth.signOut();
  // onAuthStateChanged will show login screen
}

/* ---------- Error translator ---------- */
function translateAuthError(code) {
  const map = {
    'auth/email-already-in-use':    '❌ البريد الإلكتروني مستخدم بالفعل',
    'auth/invalid-email':           '❌ البريد الإلكتروني غير صالح',
    'auth/weak-password':           '❌ كلمة المرور ضعيفة جداً',
    'auth/user-not-found':          '❌ لا يوجد حساب بهذا البريد',
    'auth/wrong-password':          '❌ كلمة المرور غير صحيحة',
    'auth/invalid-credential':      '❌ البريد أو كلمة المرور غير صحيحة',
    'auth/too-many-requests':       '⚠️ محاولات كثيرة — حاول لاحقاً',
    'auth/network-request-failed':  '⚠️ لا يوجد اتصال بالإنترنت',
  };
  return map[code] || `❌ خطأ: ${code}`;
}

/* ---------- Apply role to UI ---------- */
function applyRoleToUI(role, name) {
  document.body.classList.remove('role-owner', 'role-worker', 'role-partner');
  if (role === 'owner') document.body.classList.add('role-owner');
  else if (role === 'partner') document.body.classList.add('role-partner');
  else document.body.classList.add('role-worker');

  // Sidebar user info
  const avatar = document.getElementById('sidebar-user-avatar');
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  if (avatar) avatar.textContent = (name || '?').charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = name || 'مستخدم';
  if (roleEl) {
    if (role === 'owner')   roleEl.textContent = '👔 صاحب العمل';
    else if (role === 'partner') roleEl.textContent = '🤝 شريك';
    else                    roleEl.textContent = '👷 عامل';
  }

  // Worker banner in daily page (green — full access)
  const banners = document.querySelectorAll('.worker-mode-banner');
  banners.forEach(b => {
    if (role === 'worker') {
      b.textContent = `👷 أنت مسجل دخول كعامل (${name}) — يمكنك إدخال بيانات اليوم`;
      b.style.display = 'block';
    } else {
      b.style.display = 'none';
    }
  });

  // Owner / Partner notice in daily page (orange — read-only)
  const isReadOnly = (role === 'owner' || role === 'partner');
  let ownerNotice = document.getElementById('entry-readonly-notice');
  if (isReadOnly) {
    if (!ownerNotice) {
      ownerNotice = document.createElement('div');
      ownerNotice.id = 'entry-readonly-notice';
      ownerNotice.className = 'owner-entry-notice';
      ownerNotice.innerHTML = '🔒 <span>وضع المشاهدة فقط — لا يمكنك إدخال بيانات اليوم</span>';
      const entryPage = document.getElementById('page-daily');
      if (entryPage) {
        const firstCard = entryPage.querySelector('.section-card, .form-grid, .worker-mode-banner');
        if (firstCard) firstCard.before(ownerNotice);
      }
    }
    ownerNotice.style.display = 'flex';
  } else if (ownerNotice) {
    ownerNotice.style.display = 'none';
  }
}

/* ---------- Auth State Listener — the master switch ---------- */
function initAuthListener() {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      // Not logged in → show login screen
      showAuthScreen();
      setAuthBtnLoading('btn-login', false);
      setAuthBtnLoading('btn-register', false);
      return;
    }

    // Logged in — fetch role from Firestore
    CURRENT_USER = user;
    try {
      const doc = await fs.collection('users').doc(user.uid).get();
      if (doc.exists) {
        CURRENT_ROLE = doc.data().role || 'worker';
        CURRENT_USER_NAME = doc.data().name || user.displayName || user.email;
      } else {
        // Fallback: treat as worker if no doc found
        CURRENT_ROLE = 'worker';
        CURRENT_USER_NAME = user.displayName || user.email;
        await fs.collection('users').doc(user.uid).set({
          name: CURRENT_USER_NAME, email: user.email,
          role: 'worker', createdAt: new Date().toISOString()
        });
      }
    } catch (e) {
      CURRENT_ROLE = 'worker';
      CURRENT_USER_NAME = user.displayName || user.email;
    }

    applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
    hideAuthScreen();
    // Now proceed to factory selection / global sync
    initGlobalSync();
  });
}

/* ---------- Create worker account (called by admin from settings) ---------- */
async function createWorkerAccount() {
  const name     = document.getElementById('wa-name').value.trim();
  const email    = document.getElementById('wa-email').value.trim();
  const password = document.getElementById('wa-password').value;
  const errEl    = document.getElementById('wa-error');
  const okEl     = document.getElementById('wa-success');
  errEl.classList.remove('visible'); errEl.textContent = '';
  okEl.textContent = '';

  if (!name)  return (errEl.textContent = '⚠️ أدخل اسم العامل', errEl.classList.add('visible'));
  if (!email) return (errEl.textContent = '⚠️ أدخل البريد الإلكتروني', errEl.classList.add('visible'));
  if (password.length < 6) return (errEl.textContent = '⚠️ كلمة المرور يجب 6 أحرف على الأقل', errEl.classList.add('visible'));

  const btn = document.getElementById('btn-create-worker-account');
  btn.disabled = true; btn.textContent = '⏳ جاري الإنشاء...';

  try {
    // Use a secondary Firebase App instance to avoid signing out current owner
    let secondApp;
    try {
      secondApp = firebase.app('workerCreation');
    } catch(_) {
      secondApp = firebase.initializeApp(firebaseConfig, 'workerCreation');
    }
    const secondAuth = secondApp.auth();
  const waRole = document.getElementById('wa-role')?.value || 'worker';

  // --- Safety gate: partner accounts require prior dev-password verification ---
  if (waRole === 'partner' && !_devPasswordVerified) {
    errEl.textContent = '⛔ يجب التحقق بكلمة مرور المطور أولاً — اختر دور "شريك" مجدداً';
    errEl.classList.add('visible');
    btn.disabled = false; btn.textContent = '➕ إنشاء حساب';
    showDevPasswordModal();
    return;
  }

  const cred = await secondAuth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    await fs.collection('users').doc(cred.user.uid).set({
      name, email, role: waRole, createdAt: new Date().toISOString()
    });
    await secondAuth.signOut();

    document.getElementById('wa-name').value = '';
    document.getElementById('wa-email').value = '';
    document.getElementById('wa-password').value = '';
    if (document.getElementById('wa-role')) document.getElementById('wa-role').value = 'worker';
    _devPasswordVerified = false; // reset after each successful creation
    const roleLabel = waRole === 'partner' ? 'الشريك' : 'العامل';
    okEl.textContent = `✅ تم إنشاء حساب ${roleLabel} "${name}" بنجاح! يمكنه الآن تسجيل الدخول.`;
    addActivity(`تم إنشاء حساب للـ${roleLabel} ${name}`, waRole === 'partner' ? '🤝' : '👷');
    showToast(`✅ حساب العامل ${name} جاهز`);
  } catch(e) {
    errEl.textContent = translateAuthError(e.code);
    errEl.classList.add('visible');
  }
  btn.disabled = false; btn.textContent = '➕ إنشاء حساب';
}

/* ===================== FACTORY STATE ===================== */
let CURRENT_FACTORY = null; // { id, name, icon, color }
let FACTORY_SYNC_UNSUBS = [];
let GLOBAL_SYNC_UNSUB = null;
let IS_INITIAL_CLOUD_LOAD = true;
let INITIAL_CLOUD_SYNC_DONE = false; // New: tracking for the first list load

const CARD_COLORS = ['gold', 'blue', 'green', 'purple', 'teal', 'orange', 'red', 'pink'];

/* ===================== FACTORY DB ===================== */
const FactoryDB = {
  listKey: 'zohir_factories',

  getFactories() {
    try { return JSON.parse(localStorage.getItem(this.listKey)) || []; }
    catch { return []; }
  },

  saveFactories(list) {
    localStorage.setItem(this.listKey, JSON.stringify(list));
    // Sync list to cloud — use safe document ID (no underscores prefix/suffix)
    try {
      fs.collection('app_data').doc('factories_list').set({
        data: list, lastUpdated: new Date().toISOString()
      });
    } catch (e) { console.error('Cloud factory list sync error:', e); }
  },

  addFactory(name, icon, color) {
    const list = this.getFactories();
    const id = 'f_' + Date.now();
    const factory = { id, name, icon, color, createdAt: new Date().toISOString() };
    list.push(factory);
    this.saveFactories(list);
    return factory;
  },

  deleteFactory(id) {
    let list = this.getFactories().filter(f => f.id !== id);
    this.saveFactories(list);
    // Clear local data for this factory
    ['settings', 'workers', 'daily_logs', 'activities'].forEach(k => {
      localStorage.removeItem(`zohir_${id}_${k}`);
    });
    // Remove from cloud — batch delete
    try {
      const bch = fs.batch();
      ['settings', 'workers', 'daily_logs', 'activities'].forEach(k => {
        bch.delete(fs.collection('app_data').doc(`${id}_${k}`));
      });
      bch.commit().catch(e => console.error('Cloud delete error:', e));
    } catch (e) { console.error(e); }
  }
};

/* ===================== PER-FACTORY DATA STORE ===================== */
const DB = {
  get(key) {
    if (!CURRENT_FACTORY) return null;
    try { return JSON.parse(localStorage.getItem(`zohir_${CURRENT_FACTORY.id}_${key}`)); }
    catch { return null; }
  },

  set(key, val) {
    if (!CURRENT_FACTORY) return;
    // 1. Save locally for instant UI
    localStorage.setItem(`zohir_${CURRENT_FACTORY.id}_${key}`, JSON.stringify(val));
    // 2. Push to Firestore — track the promise for error handling
    const docRef = fs.collection('app_data').doc(`${CURRENT_FACTORY.id}_${key}`);
    docRef.set({ data: val, lastUpdated: new Date().toISOString() })
      .then(() => {
        setSyncStatus('online');
      })
      .catch(e => {
        console.error('Cloud write error:', e);
        setSyncStatus('offline');
      });
  }
};

/* ===================== CLOUD SYNC ===================== */
function setSyncStatus(status) {
  const dot = document.getElementById('sync-badge')?.querySelector('.sync-dot');
  const txt = document.getElementById('sync-badge')?.querySelector('.sync-text');
  if (!dot || !txt) return;
  dot.className = 'sync-dot' + (status === 'syncing' ? ' syncing' : status === 'offline' ? ' offline' : '');
  txt.textContent = status === 'syncing' ? 'جاري المزامنة...' : status === 'offline' ? 'غير متصل' : 'متزامن';
}

function stopFactorySync() {
  FACTORY_SYNC_UNSUBS.forEach(unsub => { try { unsub(); } catch (e) { } });
  FACTORY_SYNC_UNSUBS = [];
}

/* Force a direct server read (ignores cache) — called when app comes back to foreground */
function forceRefreshFromCloud() {
  if (!CURRENT_FACTORY) {
    fs.collection('app_data').doc('factories_list').get({ source: 'server' })
      .then(doc => {
        if (doc.exists) {
          const cloudList = doc.data().data;
          if (cloudList && Array.isArray(cloudList)) {
            localStorage.setItem(FactoryDB.listKey, JSON.stringify(cloudList));
            renderFactoryScreen();
          }
        }
      }).catch(() => { });
    return;
  }

  setSyncStatus('syncing');
  const keys = ['settings', 'workers', 'daily_logs', 'activities', 'credits'];
  let done = 0;

  keys.forEach(key => {
    fs.collection('app_data').doc(`${CURRENT_FACTORY.id}_${key}`).get({ source: 'server' })
      .then(doc => {
        done++;
        if (doc.exists) {
          const cloudData = doc.data().data;
          localStorage.setItem(`zohir_${CURRENT_FACTORY.id}_${key}`, JSON.stringify(cloudData));
          renderCurrentPage();
        }
        if (done >= keys.length) setSyncStatus('online');
      })
      .catch(() => {
        done++;
        if (done >= keys.length) setSyncStatus('offline');
      });
  });
}

function initCloudSync() {
  if (!CURRENT_FACTORY) return;
  stopFactorySync();
  setSyncStatus('syncing');

  const keys = ['settings', 'workers', 'daily_logs', 'activities', 'credits'];
  const initialLoaded = new Set();

  // 1. Force fetch from server FIRST to guarantee fresh data
  let fetchDone = 0;
  keys.forEach(key => {
    fs.collection('app_data').doc(`${CURRENT_FACTORY.id}_${key}`).get({ source: 'server' })
      .then(doc => {
        fetchDone++;
        if (doc.exists) {
          const cloudData = doc.data().data;
          localStorage.setItem(`zohir_${CURRENT_FACTORY.id}_${key}`, JSON.stringify(cloudData));
        }
        if (fetchDone >= keys.length) {
          renderCurrentPage();
          setSyncStatus('online');
          hideGlobalLoader();
        }
      })
      .catch((e) => {
        console.warn('Initial server fetch failed for', key, e);
        fetchDone++;
        if (fetchDone >= keys.length) hideGlobalLoader();
      });
  });

  // 2. Set up snapshot listeners for real-time changes
  keys.forEach(key => {
    const docId = `${CURRENT_FACTORY.id}_${key}`;
    const docRef = fs.collection('app_data').doc(docId);

    const unsub = docRef.onSnapshot({ includeMetadataChanges: true }, doc => {
      // Ignore initial cache hits if we have pending writes or it's purely from cache
      if (doc.metadata.fromCache) return;

      if (doc.exists) {
        const cloudData = doc.data().data;
        const localData = DB.get(key);
        if (JSON.stringify(localData) !== JSON.stringify(cloudData)) {
          localStorage.setItem(`zohir_${CURRENT_FACTORY.id}_${key}`, JSON.stringify(cloudData));
          renderCurrentPage();
        }
      } else {
        const localData = DB.get(key);
        if (localData !== null && (!Array.isArray(localData) || localData.length > 0)) {
          DB.set(key, localData);
        }
      }
    }, err => {
      console.error('Sync Error for', key, ':', err);
    });
    FACTORY_SYNC_UNSUBS.push(unsub);
  });

  // Also listen to factory list updates from any device
  const fUnsub = fs.collection('app_data').doc('factories_list').onSnapshot({ includeMetadataChanges: false }, doc => {
    if (doc.exists) {
      const cloudList = doc.data().data;
      const localList = FactoryDB.getFactories();
      if (cloudList && JSON.stringify(localList) !== JSON.stringify(cloudList)) {
        localStorage.setItem(FactoryDB.listKey, JSON.stringify(cloudList));
        if (!CURRENT_FACTORY) renderFactoryScreen();
      }
    }
  }, () => { });
  FACTORY_SYNC_UNSUBS.push(fUnsub);

  // Failsafe: hide loader after 6 seconds max
  setTimeout(() => hideGlobalLoader(), 6000);
}

/* ===================== GLOBAL CLOUD SYNC ===================== */
function initGlobalSync() {
  // STEP 1: Fetch directly from server (bypasses cache) — guarantees fresh data on every device
  fs.collection('app_data').doc('factories_list').get({ source: 'server' })
    .then(doc => {
      IS_INITIAL_CLOUD_LOAD = false;
      INITIAL_CLOUD_SYNC_DONE = true;

      if (doc.exists) {
        const cloudList = doc.data().data;
        if (cloudList && Array.isArray(cloudList)) {
          // Always overwrite local with server data — server is the single source of truth
          localStorage.setItem(FactoryDB.listKey, JSON.stringify(cloudList));
        }
      }

      hideGlobalLoader();

      if (!CURRENT_FACTORY) {
        renderFactoryScreen();
        checkAutoEnter();
      }
    })
    .catch(() => {
      // Offline or network error — fall back to localStorage cache
      console.warn('[Sync] Cannot reach server, using local cache');
      IS_INITIAL_CLOUD_LOAD = false;
      INITIAL_CLOUD_SYNC_DONE = true;
      hideGlobalLoader();
      if (!CURRENT_FACTORY) {
        renderFactoryScreen();
        checkAutoEnter();
      }
    });

  // STEP 2: Set up real-time listener for ongoing changes from any device
  GLOBAL_SYNC_UNSUB = fs.collection('app_data').doc('factories_list')
    .onSnapshot({ includeMetadataChanges: false }, doc => {
      if (doc.exists) {
        const cloudList = doc.data().data;
        const localList = FactoryDB.getFactories();
        if (cloudList && Array.isArray(cloudList) && JSON.stringify(localList) !== JSON.stringify(cloudList)) {
          localStorage.setItem(FactoryDB.listKey, JSON.stringify(cloudList));
          if (!CURRENT_FACTORY) {
            renderFactoryScreen();
          }
        }
      }
    }, () => { /* ignore errors — step 1 already handled initial load */ });
}

function hideGlobalLoader() {
  const loader = document.getElementById('global-loader');
  if (loader) {
    loader.classList.add('hidden');
    setTimeout(() => {
      if (loader.classList.contains('hidden')) {
        loader.style.display = 'none';
      }
    }, 600);
  }
}

function showGlobalLoader(msg) {
  const loader = document.getElementById('global-loader');
  const status = document.getElementById('loader-status');
  if (loader) {
    if (status && msg) status.textContent = msg;
    loader.style.display = 'flex';
    loader.classList.remove('hidden');
  }
}

function checkAutoEnter() {
  const factories = FactoryDB.getFactories();
  if (factories.length === 1 && !CURRENT_FACTORY) {
    enterFactory(factories[0]);
  } else if (factories.length === 0 && !CURRENT_FACTORY) {
    setTimeout(() => openAddFactoryModal(), 500);
  }
}

/* ===================== FACTORY INIT DATA (safe — no cloud push) ===================== */
function initFactoryData() {
  const fid = CURRENT_FACTORY.id;
  const keys = [
    [`zohir_${fid}_settings`, JSON.stringify(defaultSettings())],
    [`zohir_${fid}_workers`, JSON.stringify([])],
    [`zohir_${fid}_daily_logs`, JSON.stringify([])],
    [`zohir_${fid}_activities`, JSON.stringify([])],
    [`zohir_${fid}_credits`, JSON.stringify([])]
  ];
  keys.forEach(([k, v]) => {
    if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  });
}

function defaultSettings() {
  return {
    farmName: CURRENT_FACTORY?.name || 'deku',
    owner: '',
    initialChickens: 0,
    initialFeed: 0,
    chickenPrice: 0,
    feedPrice: 0,
    feedAlertThreshold: 100,
    brokenAlertPct: 5,
    deletePassword: '1234',
    loyer: 0,
    electricity: 0,
    repairLoyer: 0,
    repairTotal: 0,
    partners: []  // [{id, name, sharePercent}]
  };
}

/* ===================== PASSWORD MODAL ===================== */
let _pendingDeleteCallback = null;

function showPasswordModal(callback) {
  _pendingDeleteCallback = callback;
  const modal = document.getElementById('modal-delete-password');
  const input = document.getElementById('delete-password-input');
  if (!modal) return;
  input.value = '';
  modal.classList.add('open');
  setTimeout(() => input.focus(), 300);
}

function closePasswordModal() {
  const modal = document.getElementById('modal-delete-password');
  if (modal) modal.classList.remove('open');
  _pendingDeleteCallback = null;
}

function confirmDeletePassword() {
  const input = document.getElementById('delete-password-input');
  const enteredPass = input.value;
  const settings = DB.get('settings') || defaultSettings();
  const correctPass = settings.deletePassword || '1234';
  if (enteredPass === correctPass) {
    closePasswordModal();
    if (_pendingDeleteCallback) _pendingDeleteCallback();
  } else {
    input.value = '';
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 500);
    showToast('كلمة السر غير صحيحة', 'error');
  }
}

/* ===================== DEV PASSWORD MODAL (Partner Gate) ===================== */

/** Called when the wa-role select changes in the account creation form */
function onWaRoleChange() {
  const select = document.getElementById('wa-role');
  if (!select) return;
  if (select.value === 'partner') {
    // Must verify dev password each time partner is selected
    _devPasswordVerified = false;
    showDevPasswordModal();
  } else {
    _devPasswordVerified = false;
  }
}

function showDevPasswordModal() {
  const modal  = document.getElementById('modal-dev-password');
  const input  = document.getElementById('dev-password-input');
  const errEl  = document.getElementById('dev-password-error');
  if (!modal) return;
  if (input)  input.value = '';
  if (errEl)  { errEl.classList.remove('visible'); errEl.textContent = ''; }
  modal.classList.add('open');
  setTimeout(() => { if (input) input.focus(); }, 300);
}

function confirmDevPassword() {
  const input = document.getElementById('dev-password-input');
  const errEl = document.getElementById('dev-password-error');
  if (!input) return;

  if (input.value === DEV_SECRET_CODE) {
    _devPasswordVerified = true;
    const modal = document.getElementById('modal-dev-password');
    if (modal) modal.classList.remove('open');
    showToast('✅ تم التحقق — يمكنك الآن إنشاء حساب شريك', 'success');
  } else {
    input.value = '';
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 500);
    if (errEl) {
      errEl.textContent = '❌ كلمة المرور غير صحيحة';
      errEl.classList.add('visible');
    }
  }
}

function cancelDevPassword() {
  const modal  = document.getElementById('modal-dev-password');
  const select = document.getElementById('wa-role');
  if (modal)  modal.classList.remove('open');
  if (select) select.value = 'worker';   // revert selection
  _devPasswordVerified = false;
}

/* ===================== HELPERS ===================== */
function fmt(num, suffix = '') {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return Number(num).toLocaleString('ar-DZ') + (suffix ? ' ' + suffix : '');
}
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ar-DZ', { year: 'numeric', month: 'short', day: 'numeric' });
}
function todayStr() {
  return new Date().toISOString().split('T')[0];
}
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast'; }, 3000);
}
function addActivity(text, icon = '📌') {
  const acts = DB.get('activities') || [];
  acts.unshift({ icon, text, ts: new Date().toISOString() });
  if (acts.length > 50) acts.length = 50;
  DB.set('activities', acts);
  renderActivities();
}
function getCurrentFeedBalance() {
  const settings = DB.get('settings') || defaultSettings();
  const logs = DB.get('daily_logs') || [];
  let bal = Number(settings.initialFeed) || 0;
  logs.forEach(log => {
    bal += Number(log.feedIn) || 0;
    bal -= Number(log.feedUsed) || 0;
  });
  return bal;
}
function getTotalDeadThisMonth() {
  const logs = DB.get('daily_logs') || [];
  const now = new Date();
  return logs
    .filter(l => { const d = new Date(l.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
    .reduce((s, l) => s + (Number(l.dead) || 0), 0);
}
function getTotalBrokenLossThisMonth() {
  const logs = DB.get('daily_logs') || [];
  const now = new Date();
  return logs
    .filter(l => { const d = new Date(l.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
    .reduce((s, l) => s + ((Number(l.broken) || 0) * (Number(l.price) || 0)), 0);
}
function getTotalAdvances() {
  const workers = DB.get('workers') || [];
  let total = 0;
  workers.forEach(w => { (w.advances || []).forEach(a => total += Number(a.amount) || 0); });
  return total;
}
function getTotalNetProfit() {
  const logs = DB.get('daily_logs') || [];
  const settings = DB.get('settings') || defaultSettings();

  // Sum all daily BASE profits (before partner expenses)
  const totalDailyProfit = logs.reduce((s, l) => s + (Number(l.baseProfit ?? l.profit) || 0), 0);

  // One-time initial costs
  const chickensCost = (Number(settings.initialChickens) || 0) * (Number(settings.chickenPrice) || 0);
  const feedCost     = (Number(settings.initialFeed)     || 0) * (Number(settings.feedPrice)     || 0);
  const loyer        = Number(settings.loyer)        || 0;
  const repairLoyer  = Number(settings.repairLoyer)  || 0;
  const repairTotal  = Number(settings.repairTotal)  || 0;
  const effectiveLoyer = Math.max(0, loyer - repairLoyer);

  // Monthly electricity
  const electricity = Number(settings.electricity) || 0;
  let monthsDiff = 1;
  if (logs.length > 0) {
    const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = new Date(sorted[0].date);
    const now = new Date();
    monthsDiff = Math.max(1, (now.getFullYear() - firstDate.getFullYear()) * 12 + (now.getMonth() - firstDate.getMonth()) + 1);
  }
  const totalElectricity = electricity * monthsDiff;

  // Total partner expenses across all logs
  const totalPartnerExp = logs.reduce((s, l) => {
    if (!l.partnerExpenses) return s;
    return s + l.partnerExpenses.reduce((ps, pe) => ps + (Number(pe.amount) || 0), 0);
  }, 0);

  // Credits (debts) reduce profit
  const credits = DB.get('credits') || [];
  const totalCredits = credits.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  return totalDailyProfit - chickensCost - feedCost - effectiveLoyer - totalElectricity - repairTotal - totalPartnerExp - totalCredits;
}

function getTotalCredits() {
  const credits = DB.get('credits') || [];
  return credits.reduce((s, c) => s + (Number(c.amount) || 0), 0);
}
function renderCurrentPage() {
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;
  const pageId = activePage.id.replace('page-', '');
  const refreshers = {
    dashboard: renderDashboard,
    sales: renderSalesFeedPage,
    workers: renderWorkersPage,
    reports: renderReportsPage,
    settings: loadSettingsForm
  };
  if (refreshers[pageId]) refreshers[pageId]();
}

/* ===================== FACTORY SELECTION SCREEN ===================== */
function renderFactoryScreen() {
  const grid = document.getElementById('factory-cards-grid');
  const factories = FactoryDB.getFactories();
  grid.innerHTML = '';

  if (!factories.length) {
    if (IS_INITIAL_CLOUD_LOAD) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:100px 0;color:var(--text-muted)">
          <div class="loader" style="margin: 0 auto 20px;"></div>
          <p style="font-size:1rem; animation: pulse 1.5s infinite">جاري البحث عن مصانعك في السحابة...</p>
        </div>`;
    } else {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:100px 0;color:var(--text-muted)">
          <div style="font-size:3.5rem;margin-bottom:20px; filter: grayscale(1); opacity: 0.5;">🏭</div>
          <p style="font-size:1.1rem; color: var(--text-primary)">لا توجد مصانع للآن</p>
          <p style="font-size:0.9rem; margin-top:8px">ابدأ بإضافة مصنعك الأول لتنظيم أعمالك</p>
        </div>`;
    }
    return;
  }

  factories.forEach((factory, idx) => {
    // Get today's income from local data for quick stats
    const logs = (() => {
      try { return JSON.parse(localStorage.getItem(`zohir_${factory.id}_daily_logs`)) || []; }
      catch { return []; }
    })();
    const today = todayStr();
    const todayLog = logs.find(l => l.date === today);

    const card = document.createElement('div');
    card.className = 'factory-card';
    card.setAttribute('data-color', factory.color || 'gold');
    card.setAttribute('data-id', factory.id);
    card.style.animationDelay = `${idx * 0.07}s`;

    // Only workers can delete factories
    const canDelete = (CURRENT_ROLE !== 'owner' && CURRENT_ROLE !== 'partner');
    card.innerHTML = `
      ${canDelete ? `<button class="factory-card-delete" data-id="${factory.id}" title="حذف المصنع">✕</button>` : ''}
      <span class="factory-card-icon">${factory.icon || '🐔'}</span>
      <div class="factory-card-name">${factory.name}</div>
      <div class="factory-card-meta">منذ ${fmtDate(factory.createdAt?.split('T')[0] || today)}</div>
      <div class="factory-card-stat">
        <span class="label">اليوم</span>
        <span class="value">${todayLog ? fmt(todayLog.income, 'دج') : '—'}</span>
      </div>
    `;

    // Main card click → enter factory
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('factory-card-delete') || e.target.closest('.factory-card-delete')) return;
      enterFactory(factory);
    });

    // Delete button (only rendered for workers)
    const delBtn = card.querySelector('.factory-card-delete');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fname = factory.name;
        if (!confirm('هل تريد حذف مصنع "' + fname + '"؟')) return;
        if (!confirm('تأكيد نهائي: سيتم حذف جميع بيانات "' + fname + '" من السحابة بشكل دائم. متأكد؟')) return;
        // Stop global listener first to prevent re-sync of deleted data
        if (GLOBAL_SYNC_UNSUB) { try { GLOBAL_SYNC_UNSUB(); GLOBAL_SYNC_UNSUB = null; } catch(er) {} }
        FactoryDB.deleteFactory(factory.id);
        renderFactoryScreen();
        showToast('✅ تم حذف المصنع نهائياً', 'warning');
        // Restart global listener for remaining factories
        setTimeout(() => initGlobalSync(), 800);
      });
    }

    grid.appendChild(card);
  });
}

function enterFactory(factory) {
  CURRENT_FACTORY = factory;

  // Show loader while switching data
  showGlobalLoader(`جاري تحميل بيانات "${factory.name}"...`);

  // Update sidebar UI
  document.getElementById('sidebar-factory-icon').textContent = factory.icon || '🐔';
  document.getElementById('sidebar-factory-name').textContent = factory.name;
  document.getElementById('sidebar-factory-sub').textContent = 'مصنع الدواجن';
  document.getElementById('topbar-factory-name').textContent = `deku — ${factory.name}`;

  // Init local data safely (no cloud push)
  initFactoryData();

  // Render partner expense fields in daily form
  renderPartnerExpensesInForm();

  // Show app, hide selection screen
  document.getElementById('factory-screen').style.display = 'none';
  const appWrapper = document.getElementById('app-wrapper');
  appWrapper.style.display = 'flex';

  // Reset to dashboard
  showPage('dashboard');
  updateLiveDate();

  // Start sync
  initCloudSync();

  // Populate worker selects
  populateWorkerSelects();
}

function exitToFactoryScreen() {
  stopFactorySync();
  CURRENT_FACTORY = null;

  document.getElementById('app-wrapper').style.display = 'none';
  const screen = document.getElementById('factory-screen');
  screen.style.display = 'flex';

  // Refresh the screen to show latest stats
  renderFactoryScreen();

  // Close mobile sidebar if open
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

function initFactoryScreen() {
  renderFactoryScreen();

  // Add factory modal — only workers can add factories
  document.getElementById('btn-add-factory').addEventListener('click', () => {
    if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
      showToast('🔒 وضع المشاهدة فقط — لا يمكنك إضافة مصنع', 'error');
      return;
    }
    openAddFactoryModal();
  });

  document.getElementById('btn-confirm-add-factory').addEventListener('click', () => {
    const name = document.getElementById('new-factory-name').value.trim();
    if (!name) { showToast('يرجى إدخال اسم المصنع', 'error'); return; }
    const selectedIcon = document.querySelector('.icon-opt.selected');
    const icon = selectedIcon ? selectedIcon.dataset.icon : '🐔';
    const usedColors = FactoryDB.getFactories().map(f => f.color);
    const color = CARD_COLORS.find(c => !usedColors.includes(c)) || CARD_COLORS[FactoryDB.getFactories().length % CARD_COLORS.length];
    const factory = FactoryDB.addFactory(name, icon, color);
    closeAddFactoryModal();
    document.getElementById('new-factory-name').value = '';
    renderFactoryScreen();
    showToast(`✅ تمت إضافة ${name}`);
  });

  document.getElementById('btn-cancel-add-factory').addEventListener('click', closeAddFactoryModal);
  document.getElementById('modal-add-factory').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-add-factory')) closeAddFactoryModal();
  });

  // Icon picker
  document.querySelectorAll('.icon-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.icon-opt').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // Factory switcher buttons
  document.getElementById('btn-switch-factory').addEventListener('click', exitToFactoryScreen);
  document.getElementById('topbar-switch-btn').addEventListener('click', exitToFactoryScreen);
}

function openAddFactoryModal() {
  document.getElementById('modal-add-factory').classList.add('open');
  setTimeout(() => document.getElementById('new-factory-name').focus(), 300);
}
function closeAddFactoryModal() {
  document.getElementById('modal-add-factory').classList.remove('open');
}

/* ===================== NAVIGATION ===================== */
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.bottom-nav-item').forEach(n => n.classList.remove('active'));

  const page = document.getElementById('page-' + pageId);
  const nav = document.getElementById('nav-' + pageId);
  const bn = document.querySelector(`.bottom-nav-item[data-page="${pageId}"]`);

  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
  if (bn) bn.classList.add('active');
  const refreshers = {
    dashboard: renderDashboard,
    sales: renderSalesFeedPage,
    workers: renderWorkersPage,
    reports: renderReportsPage,
    settings: loadSettingsForm
  };
  if (refreshers[pageId]) refreshers[pageId]();
  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

/* ===================== LIVE DATE ===================== */
function updateLiveDate() {
  const el = document.getElementById('live-date');
  if (!el) return;
  const d = new Date();
  el.textContent = d.toLocaleDateString('ar-DZ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/* ===================== DASHBOARD ===================== */
function renderDashboard() {
  const logs = DB.get('daily_logs') || [];
  const settings = DB.get('settings') || defaultSettings();

  const today = todayStr();
  const todayLogs = logs.filter(l => l.date === today);

  // Aggregate today's data for combined KPIs
  const todaySummary = todayLogs.reduce((acc, l) => {
    acc.produced += Number(l.produced) || 0;
    acc.broken += Number(l.broken) || 0;
    acc.netEggs += Number(l.netEggs) || 0;
    acc.income += Number(l.income) || 0;
    acc.dead += Number(l.dead) || 0;
    acc.feedIn += Number(l.feedIn) || 0;
    acc.feedUsed += Number(l.feedUsed) || 0;
    acc.koliates += Number(l.koliates) || 0;
    acc.singleLeft += Number(l.singleLeft) || 0;
    acc.soldGroups += Number(l.soldGroups) || 0;
    acc.soldSingle += Number(l.soldSingle) || 0;
    if (l.price > 0) acc.price = l.price; // Keep latest price
    return acc;
  }, {
    date: today, produced: 0, broken: 0, netEggs: 0, income: 0, dead: 0,
    feedIn: 0, feedUsed: 0, price: 0, koliates: 0, singleLeft: 0, soldGroups: 0, soldSingle: 0
  });

  const feedBal = getCurrentFeedBalance();
  const deadMonth = getTotalDeadThisMonth();
  const brokenLoss = getTotalBrokenLossThisMonth();
  const totalAdv = getTotalAdvances();

  document.getElementById('kpi-eggs').textContent = todayLogs.length ? fmt(todaySummary.netEggs) : '0';
  document.getElementById('kpi-income').textContent = todayLogs.length ? fmt(todaySummary.income, 'دج') : '0 دج';
  document.getElementById('kpi-feed').textContent = fmt(feedBal, 'كغ');
  document.getElementById('kpi-dead').textContent = deadMonth;
  document.getElementById('kpi-broken').textContent = fmt(brokenLoss, 'دج');
  document.getElementById('kpi-advances').textContent = fmt(totalAdv, 'دج');

  // Total net profit KPI
  const netProfit = getTotalNetProfit();
  const netProfitEl = document.getElementById('kpi-net-profit');
  if (netProfitEl) {
    netProfitEl.textContent = fmt(netProfit, 'دج');
    netProfitEl.style.color = netProfit >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const feedKpi = document.querySelector('.kpi-feed');
  if (feedBal < (Number(settings.feedAlertThreshold) || 100)) {
    feedKpi.style.borderColor = 'rgba(246,173,85,0.4)';
  } else {
    feedKpi.style.borderColor = '';
  }

  // Show summary of today if logs exist, otherwise show last record from history
  if (todayLogs.length > 0) {
    renderLastReport(todaySummary, `📊 ملخص اليوم (${todayLogs.length} سجلات)`);
  } else {
    const lastLog = logs.length ? logs[logs.length - 1] : null;
    renderLastReport(lastLog);
  }

  renderActivities();
}

function renderLastReport(log, customTitle = null) {
  const el = document.getElementById('last-report-content');
  if (!log) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🐣</div>
      <p>المصنع جديد! لم يتم إدخال أي بيانات بعد.</p>
      <button class="btn btn-primary" onclick="showPage('daily')">ابدأ بإدخال بيانات اليوم</button>
    </div>`;
    return;
  }
  const settings = DB.get('settings') || defaultSettings();
  const brokenPct = log.produced > 0 ? ((log.broken / log.produced) * 100).toFixed(1) : '0.0';
  const brokenWarn = Number(brokenPct) > (Number(settings.brokenAlertPct) || 5);

  el.innerHTML = `
    <div class="report-block">
      <div class="report-block-title">${customTitle || '📅 ' + fmtDate(log.date)}</div>
      <div class="report-row"><span>إجمالي البلاكات</span><strong>${fmt(log.produced)}</strong></div>
      <div class="report-row"><span>المكسور</span><strong class="${log.broken > 0 ? 'negative' : ''}">${fmt(log.broken)}</strong></div>
      <div class="report-row"><span>الصافي</span><strong class="positive">${fmt(log.netEggs)}</strong></div>
      <div class="report-row"><span>الكرطونات</span><strong>${fmt(log.koliates)}</strong></div>
      <div class="report-row"><span>الفردي المتبقي</span><strong>${fmt(log.singleLeft)}</strong></div>
    </div>
    <div class="report-block">
      <div class="report-block-title">💰 المبيعات والمدخول</div>
      <div class="report-row"><span>سعر البلاكة</span><strong>${fmt(log.price, 'دج')}</strong></div>
      <div class="report-row"><span>الكرطونات المباعة</span><strong>${fmt(log.soldGroups)}</strong></div>
      <div class="report-row"><span>الفردي المباع</span><strong>${fmt(log.soldSingle)}</strong></div>
      <div class="report-row"><span>المدخول الإجمالي</span><strong class="positive">${fmt(log.income, 'دج')}</strong></div>
    </div>
    <div class="accountant-note">
      <strong>💼 ملاحظة المحاسب:</strong>
      ${generateAccountantNote(log, brokenPct, brokenWarn)}
    </div>
  `;
}

function generateAccountantNote(log, brokenPct, brokenWarn) {
  const notes = [];
  if (brokenWarn) notes.push(`⚠️ نسبة الكسر مرتفعة (${brokenPct}%) — تحتاج إلى مراجعة أسباب الكسر وتوعية العمال.`);
  if (log.dead > 3) notes.push(`⚠️ وفاة ${log.dead} دجاجة في يوم واحد — تحقق من الصحة العامة للقطيع.`);
  if (log.feedUsed > 0 && log.netEggs > 0) {
    const ratio = (log.feedUsed / log.netEggs).toFixed(2);
    if (ratio > 0.3) notes.push(`📊 نسبة العلف لكل بلاكة = ${ratio} كغ — اتجه نحو تحسين الكفاءة الغذائية.`);
  }
  if (log.income > 0) notes.push(`✅ مدخول اليوم ${fmt(log.income, 'دج')} — أداء مقبول.`);
  if (notes.length === 0) notes.push('✅ كل شيء يسير بشكل طبيعي. استمر في المراقبة اليومية.');
  return notes.join('<br>');
}

function renderActivities() {
  const el = document.getElementById('activity-feed');
  const acts = DB.get('activities') || [];
  if (!acts.length) {
    el.innerHTML = '<div class="empty-state"><p>لا توجد أنشطة مسجلة بعد.</p></div>';
    return;
  }
  el.innerHTML = acts.slice(0, 10).map(a => `
    <div class="report-row">
      <span>${a.icon} ${a.text}</span>
      <span style="font-size:0.75rem;color:var(--text-muted)">${fmtDate(a.ts.split('T')[0])}</span>
    </div>`).join('');
}

/* ===================== DAILY INPUT ===================== */
function initDailyForm() {
  document.getElementById('inp-date').value = todayStr();

  const calcFields = ['inp-produced', 'inp-broken', 'inp-price', 'inp-sold-total', 'inp-free-plates', 'inp-feed-in', 'inp-feed-price', 'inp-feed-used', 'inp-expenses', 'inp-owner-advance', 'inp-water-cost', 'inp-manure-income', 'inp-special-plates', 'inp-special-singles', 'inp-special-price'];
  calcFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDailyCalc);
  });

  document.getElementById('advance-entries').addEventListener('input', updateDailyCalc);
  document.getElementById('advance-entries').addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-remove-adv')) setTimeout(updateDailyCalc, 50);
  });

  document.getElementById('btn-save-day').addEventListener('click', saveDayData);
  document.getElementById('btn-clear-form').addEventListener('click', clearDailyForm);
  document.getElementById('add-advance-row').addEventListener('click', addAdvanceRow);
}

function updateDailyCalc() {
  const produced = Number(document.getElementById('inp-produced').value) || 0;
  const broken = Number(document.getElementById('inp-broken').value) || 0;
  const price = Number(document.getElementById('inp-price').value) || 0;
  const soldTotal = Number(document.getElementById('inp-sold-total').value) || 0;
  const feedIn = Number(document.getElementById('inp-feed-in').value) || 0;
  const feedPrice = Number(document.getElementById('inp-feed-price').value) || 0;
  const feedUsed = Number(document.getElementById('inp-feed-used').value) || 0;
  const expenses = Number(document.getElementById('inp-expenses')?.value) || 0;
  const manureIncome = Number(document.getElementById('inp-manure-income')?.value) || 0;
  const waterCost = Number(document.getElementById('inp-water-cost')?.value) || 0;
  const specialPlates = Number(document.getElementById('inp-special-plates')?.value) || 0;
  const specialSingles = Number(document.getElementById('inp-special-singles')?.value) || 0;
  const specialPrice = Number(document.getElementById('inp-special-price')?.value) || 0;

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  const feedBal = getCurrentFeedBalance() + feedIn - feedUsed;
  const feedCost = feedIn * feedPrice;
  const specialIncome = specialPlates * specialPrice + specialSingles * (specialPrice / 12);

  const settings = DB.get('settings') || defaultSettings();
  const baseFeedPrice = Number(settings.feedPrice) || 0;
  const consumedFeedCost = feedUsed * (feedPrice > 0 ? feedPrice : baseFeedPrice);

  let workerAdvancesTotal = 0;
  document.querySelectorAll('.advance-row').forEach(row => {
    workerAdvancesTotal += Number(row.querySelector('.adv-amount').value) || 0;
  });

  const ownerAdvance = Number(document.getElementById('inp-owner-advance')?.value) || 0;

  // Base profit before partner expenses and owner advance
  const baseProfit = income + manureIncome + specialIncome - consumedFeedCost - waterCost - workerAdvancesTotal;

  // Collect partner expenses
  const partners = settings.partners || [];
  let totalPartnerExpenses = 0;
  partners.forEach(p => {
    totalPartnerExpenses += Number(document.getElementById(`inp-pexp-${p.id}`)?.value) || 0;
  });

  const profit = baseProfit - totalPartnerExpenses - ownerAdvance;

  document.getElementById('prev-net').textContent = net >= 0 ? fmt(net) : '—';
  document.getElementById('prev-koliates').textContent = net >= 0 ? fmt(koliates) : '—';
  document.getElementById('prev-single').textContent = net >= 0 ? fmt(singleLeft) : '—';
  document.getElementById('prev-sold-groups').textContent = soldTotal > 0 ? fmt(soldGroups) + ' كرطون' : '—';
  document.getElementById('prev-sold-single').textContent = soldTotal > 0 ? fmt(soldSingle) + ' بلاكة' : '—';
  document.getElementById('prev-income').textContent = fmt(income, 'دج');
  document.getElementById('prev-feed').textContent = fmt(feedBal, 'كغ');
  document.getElementById('prev-feed-cost').textContent = feedPrice > 0 ? fmt(feedCost, 'دج') : '—';

  const specialIncomeEl = document.getElementById('prev-special-income');
  if (specialIncomeEl) specialIncomeEl.textContent = (specialPlates > 0 || specialSingles > 0) ? fmt(specialIncome, 'دج') : '—';

  // Base profit preview
  const baseProfitEl = document.getElementById('prev-base-profit');
  if (baseProfitEl) {
    baseProfitEl.textContent = fmt(baseProfit, 'دج');
    baseProfitEl.style.color = baseProfit >= 0 ? 'var(--blue)' : 'var(--red)';
  }

  // Partner shares preview
  const sharesEl = document.getElementById('prev-partner-shares');
  if (sharesEl && partners.length > 0) {
    let html = '';
    partners.forEach(p => {
      const partnerExp = Number(document.getElementById(`inp-pexp-${p.id}`)?.value) || 0;
      const partnerShare = (baseProfit * (Number(p.sharePercent) || 0) / 100) - partnerExp;
      html += `<div class="calc-row" style="font-size:0.85rem;padding:3px 0">
        <span>🤝 ${p.name} (${p.sharePercent}%)</span>
        <strong style="color:${partnerShare >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(partnerShare, 'دج')}</strong>
      </div>`;
    });
    if (ownerAdvance > 0) {
      html += `<div class="calc-row" style="font-size:0.85rem;padding:3px 0">
        <span>👔 سلفيات صاحب العمل</span>
        <strong style="color:var(--orange)">-${fmt(ownerAdvance, 'دج')}</strong>
      </div>`;
    }
    sharesEl.innerHTML = html;
  } else if (sharesEl) {
    sharesEl.innerHTML = '';
  }

  // Final profit preview
  const profitEl = document.getElementById('prev-profit');
  if (profitEl) {
    profitEl.textContent = fmt(profit, 'دج');
    profitEl.style.color = profit >= 0 ? 'var(--green)' : 'var(--red)';
  }
}

function addAdvanceRow() {
  const container = document.getElementById('advance-entries');
  const div = document.createElement('div');
  div.className = 'advance-row';
  div.innerHTML = `
    <select class="adv-worker-select">${workerOptions()}</select>
    <input type="number" class="adv-amount" placeholder="المبلغ (دج)" min="0" />
    <button class="btn-remove-adv" title="حذف">✕</button>
  `;
  div.querySelector('.btn-remove-adv').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

function workerOptions() {
  const workers = DB.get('workers') || [];
  let opts = '<option value="">— اختر عاملاً —</option>';
  workers.forEach(w => { opts += `<option value="${w.id}">${w.name}</option>`; });
  return opts;
}

function populateWorkerSelects() {
  document.querySelectorAll('.adv-worker-select').forEach(sel => {
    const cur = sel.value;
    sel.innerHTML = workerOptions();
    sel.value = cur;
  });
}

function saveDayData() {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error');
    return;
  }
  const date = document.getElementById('inp-date').value;
  const produced = Number(document.getElementById('inp-produced').value) || 0;
  const broken = Number(document.getElementById('inp-broken').value) || 0;
  const price = Number(document.getElementById('inp-price').value) || 0;
  const soldTotal = Number(document.getElementById('inp-sold-total').value) || 0;
  const freePlates = Number(document.getElementById('inp-free-plates').value) || 0;
  const feedIn = Number(document.getElementById('inp-feed-in').value) || 0;
  const feedPrice = Number(document.getElementById('inp-feed-price').value) || 0;
  const feedUsed = Number(document.getElementById('inp-feed-used').value) || 0;
  const dead = Number(document.getElementById('inp-dead').value) || 0;
  const waterCost = Number(document.getElementById('inp-water-cost').value) || 0;
  const manureIncome = Number(document.getElementById('inp-manure-income').value) || 0;
  const expenses = 0; // ملغى — أصبحت مصاريف منفصلة لكل شريك
  const ownerAdvance = Number(document.getElementById('inp-owner-advance')?.value) || 0;
  const notes = document.getElementById('inp-notes').value.trim();
  const specialPlates = Number(document.getElementById('inp-special-plates')?.value) || 0;
  const specialSingles = Number(document.getElementById('inp-special-singles')?.value) || 0;
  const specialPrice = Number(document.getElementById('inp-special-price')?.value) || 0;
  const specialIncome = specialPlates * specialPrice + specialSingles * (specialPrice / 12);

  if (!date) { showToast('يرجى تحديد التاريخ', 'error'); return; }

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  const feedCost = feedIn * feedPrice;

  // Collect advances
  const advRows = document.querySelectorAll('.advance-row');
  const advancesThisDay = [];
  let workerAdvancesTotal = 0;
  advRows.forEach(row => {
    const workerId = row.querySelector('.adv-worker-select').value;
    const amount = Number(row.querySelector('.adv-amount').value) || 0;
    if (workerId && amount > 0) {
      advancesThisDay.push({ workerId, amount, date });
      workerAdvancesTotal += amount;
    }
  });

  const settings = DB.get('settings') || defaultSettings();
  const baseFeedPrice = Number(settings.feedPrice) || 0;
  const consumedFeedCost = feedUsed * (feedPrice > 0 ? feedPrice : baseFeedPrice);

  // Collect partner expenses
  const partners = settings.partners || [];
  const partnerExpenses = [];
  let totalPartnerExpenses = 0;
  partners.forEach(p => {
    const val = Number(document.getElementById(`inp-pexp-${p.id}`)?.value) || 0;
    partnerExpenses.push({ partnerId: p.id, name: p.name, amount: val });
    totalPartnerExpenses += val;
  });

  // Base profit = income before any partner/owner personal expenses
  const baseProfit = income + manureIncome + specialIncome - consumedFeedCost - waterCost - workerAdvancesTotal;

  // Each partner net = baseProfit * sharePercent% - their own expenses
  // (stored; not deducted globally here)
  const profit = baseProfit - totalPartnerExpenses - ownerAdvance;

  const log = {
    id: Date.now(),
    date, produced, broken, price,
    netEggs: net, koliates, singleLeft,
    soldTotal, soldGroups, soldSingle, freePlates, income,
    feedIn, feedPrice, feedCost, feedUsed, dead, waterCost, manureIncome, notes,
    expenses: 0, ownerAdvance, baseProfit, profit, partnerExpenses,
    specialPlates, specialSingles, specialPrice, specialIncome,
    enteredBy: CURRENT_USER_NAME || '',
    enteredByUid: CURRENT_USER ? CURRENT_USER.uid : ''
  };

  const logs = DB.get('daily_logs') || [];
  logs.push(log);
  DB.set('daily_logs', logs);

  if (advancesThisDay.length) {
    const workers = DB.get('workers') || [];
    advancesThisDay.forEach(adv => {
      const w = workers.find(wk => String(wk.id) === String(adv.workerId));
      if (w) {
        if (!w.advances) w.advances = [];
        w.advances.push({ amount: adv.amount, date: adv.date, id: Date.now() + Math.random() });
      }
    });
    DB.set('workers', workers);
  }

  const totalDayIncome = income + specialIncome;
  addActivity(`تم حفظ بيانات يوم ${fmtDate(date)} — مدخول: ${fmt(income, 'دج')}${specialIncome > 0 ? ' + خاص: '+fmt(specialIncome, 'دج') : ''} — فائدة: ${fmt(log.profit, 'دج')}`, '📅');
  showToast('✅ تم حفظ بيانات اليوم بنجاح!');
  renderDailyReportOutput(log);
  updateDailyCalc();
}

function renderDailyReportOutput(log) {
  const container = document.getElementById('daily-report-output');
  const content = document.getElementById('daily-report-content');
  const settings = DB.get('settings') || defaultSettings();
  const brokenPct = log.produced > 0 ? ((log.broken / log.produced) * 100).toFixed(1) : '0.0';
  const brokenWarn = Number(brokenPct) > (Number(settings.brokenAlertPct) || 5);
  const feedBal = getCurrentFeedBalance();
  const feedWarn = feedBal < (Number(settings.feedAlertThreshold) || 100);

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
      <div class="report-block">
        <div class="report-block-title">🥚 جدول الإنتاج والمبيعات</div>
        <div class="report-row"><span>إجمالي المنتج</span><strong>${fmt(log.produced)} بلاكة</strong></div>
        <div class="report-row"><span>المكسور</span><strong class="negative">${fmt(log.broken)} بلاكة</strong></div>
        <div class="report-row"><span>الصافي</span><strong class="positive">${fmt(log.netEggs)} بلاكة</strong></div>
        <div class="report-row"><span>الكرطونات (12×)</span><strong>${fmt(log.koliates)} كرطون</strong></div>
        <div class="report-row"><span>الفردي المتبقي</span><strong>${fmt(log.singleLeft)} بلاكة</strong></div>
        <div class="report-row"><span>سعر البلاكة</span><strong>${fmt(log.price, 'دج')}</strong></div>
        <div class="report-row"><span>الكرطونات المباعة</span><strong>${fmt(log.soldGroups)}</strong></div>
        <div class="report-row"><span>الفردي المباع</span><strong>${fmt(log.soldSingle)}</strong></div>
        <div class="report-row"><span>مجاني/استهلاك</span><strong>${fmt(log.freePlates || 0)} بلاكة</strong></div>
        <div class="report-row"><span>💧 سعر الماء</span><strong class="negative">${log.waterCost > 0 ? fmt(log.waterCost, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>💩 سعر الغبار</span><strong class="positive">${log.manureIncome > 0 ? fmt(log.manureIncome, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>💸 المصاريف اليومية</span><strong class="negative">${log.expenses > 0 ? fmt(log.expenses, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>👔 سلفيات صاحب العمل</span><strong class="negative">${log.ownerAdvance > 0 ? fmt(log.ownerAdvance, 'دج') : '—'}</strong></div>
        <div class="report-row" style="border-top:1px solid rgba(255,255,255,0.08);margin-top:6px;padding-top:8px">
          <span>💵 المدخول الإجمالي</span>
          <strong class="positive" style="font-size:1.1rem">${fmt(log.income, 'دج')}</strong>
        </div>
        <div class="report-row">
          <span>📊 الربح الأساسي</span>
          <strong style="color:var(--blue);font-size:1.05rem">${fmt(log.baseProfit, 'دج')}</strong>
        </div>
        ${(log.partnerExpenses && log.partnerExpenses.length > 0) ? log.partnerExpenses.map(pe => {
          const pSettings = (settings.partners || []).find(pp => pp.id === pe.partnerId);
          const share = pSettings ? (Number(log.baseProfit) || 0) * (Number(pSettings.sharePercent) || 0) / 100 : 0;
          const net = share - (Number(pe.amount) || 0);
          return `<div class="report-row" style="font-size:0.88rem">
            <span>🤝 ${pe.name} (${pSettings ? pSettings.sharePercent + '%' : '—'})</span>
            <strong style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(net, 'دج')}${pe.amount > 0 ? ' <small style="color:var(--orange)">(مصاريف: '+fmt(pe.amount,'دج')+')</small>' : ''}</strong>
          </div>`;
        }).join('') : ''}
        <div class="report-row">
          <span>💰 الصافي (الفائدة)</span>
          <strong class="${log.profit >= 0 ? 'positive' : 'negative'}" style="font-size:1.1rem">${fmt(log.profit, 'دج')}</strong>
        </div>
      </div>
      <div class="report-block">
        <div class="report-block-title">🌾 جدول المخزون</div>
        <div class="report-row"><span>شعير داخل اليوم</span><strong>${fmt(log.feedIn, 'كغ')}</strong></div>
        <div class="report-row"><span>سعر الشراء</span><strong>${log.feedPrice > 0 ? fmt(log.feedPrice, 'دج/كغ') : '—'}</strong></div>
        <div class="report-row"><span>تكلفة الشراء</span><strong class="${log.feedCost > 0 ? 'negative' : ''}">${log.feedCost > 0 ? fmt(log.feedCost, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>شعير مستهلك</span><strong>${fmt(log.feedUsed, 'كغ')}</strong></div>
        <div class="report-row">
          <span>الرصيد الحالي</span>
          <strong class="${feedWarn ? 'warn' : 'positive'}">${fmt(feedBal, 'كغ')} ${feedWarn ? '⚠️' : ''}</strong>
        </div>
        <div class="report-block-title" style="margin-top:14px">⚠️ مؤشرات الأداء</div>
        <div class="report-row"><span>نسبة الكسر</span>
          <strong class="${brokenWarn ? 'negative' : 'positive'}">${brokenPct}% ${brokenWarn ? '⚠️' : '✓'}</strong>
        </div>
        <div class="report-row"><span>قيمة الكسر الضائعة</span>
          <strong class="negative">${fmt(log.broken * log.price, 'دج')}</strong>
        </div>
        <div class="report-row"><span>الدجاج النافق اليوم</span>
          <strong class="${log.dead > 0 ? 'negative' : ''}">
            ${log.dead > 0 ? '💀 ' : '✓ '}${fmt(log.dead)} دجاجة
          </strong>
        </div>
      </div>
    </div>
    <div class="accountant-note">
      <strong>💼 خلاصة المحاسب:</strong>
      ${generateAccountantNote(log, brokenPct, brokenWarn)}
    </div>
    ${log.notes ? `<div class="report-block" style="margin-top:12px"><div class="report-block-title">📝 الملاحظات</div><p style="color:var(--text-secondary);font-size:0.88rem">${log.notes}</p></div>` : ''}
  `;
  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showDailyLogDetails(id) {
  const logs = DB.get('daily_logs') || [];
  const log = logs.find(l => l.id === id);
  if (!log) return;
  const modal = document.getElementById('daily-details-modal');
  const modalBody = document.getElementById('details-modal-body');
  document.getElementById('details-modal-title').textContent = `تفاصيل يوم ${fmtDate(log.date)}`;
  const settings = DB.get('settings') || defaultSettings();
  const brokenPct = log.produced > 0 ? ((log.broken / log.produced) * 100).toFixed(1) : '0.0';
  const brokenWarn = Number(brokenPct) > (Number(settings.brokenAlertPct) || 5);
  const feedBal = getCurrentFeedBalance();
  const feedWarn = feedBal < (Number(settings.feedAlertThreshold) || 100);
  modalBody.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
      <div class="report-block">
        <div class="report-block-title">🥚 جدول الإنتاج والمبيعات</div>
        <div class="report-row"><span>إجمالي المنتج</span><strong>${fmt(log.produced)} بلاكة</strong></div>
        <div class="report-row"><span>المكسور</span><strong class="negative">${fmt(log.broken)} بلاكة</strong></div>
        <div class="report-row"><span>الصافي</span><strong class="positive">${fmt(log.netEggs)} بلاكة</strong></div>
        <div class="report-row"><span>الكرطونات (12×)</span><strong>${fmt(log.koliates)} كرطون</strong></div>
        <div class="report-row"><span>الفردي المتبقي</span><strong>${fmt(log.singleLeft)} بلاكة</strong></div>
        <div class="report-row"><span>سعر البلاكة</span><strong>${fmt(log.price, 'دج')}</strong></div>
        <div class="report-row"><span>الكرطونات المباعة</span><strong>${fmt(log.soldGroups)}</strong></div>
        <div class="report-row"><span>الفردي المباع</span><strong>${fmt(log.soldSingle)}</strong></div>
        <div class="report-row"><span>مجاني/استهلاك</span><strong>${fmt(log.freePlates || 0)} بلاكة</strong></div>
        <div class="report-row"><span>💧 سعر الماء</span><strong class="negative">${log.waterCost > 0 ? fmt(log.waterCost, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>💩 سعر الغبار</span><strong class="positive">${log.manureIncome > 0 ? fmt(log.manureIncome, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>💸 المصاريف اليومية</span><strong class="negative">${log.expenses > 0 ? fmt(log.expenses, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>👔 سلفيات صاحب العمل</span><strong class="negative">${log.ownerAdvance > 0 ? fmt(log.ownerAdvance, 'دج') : '—'}</strong></div>
        <div class="report-row" style="border-top:1px solid rgba(255,255,255,0.08);margin-top:6px;padding-top:8px">
          <span>💵 المدخول الإجمالي</span>
          <strong class="positive" style="font-size:1.1rem">${fmt(log.income, 'دج')}</strong>
        </div>
        <div class="report-row">
          <span>📊 الربح الأساسي</span>
          <strong style="color:var(--blue);font-size:1.05rem">${fmt(log.baseProfit, 'دج')}</strong>
        </div>
        ${(log.partnerExpenses && log.partnerExpenses.length > 0) ? log.partnerExpenses.map(pe => {
          const pSettings = (settings.partners || []).find(pp => pp.id === pe.partnerId);
          const share = pSettings ? (Number(log.baseProfit) || 0) * (Number(pSettings.sharePercent) || 0) / 100 : 0;
          const net = share - (Number(pe.amount) || 0);
          return `<div class="report-row" style="font-size:0.88rem">
            <span>🤝 ${pe.name} (${pSettings ? pSettings.sharePercent + '%' : '—'})</span>
            <strong style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(net, 'دج')}${pe.amount > 0 ? ' <small style="color:var(--orange)">(مصاريف: '+fmt(pe.amount,'دج')+')</small>' : ''}</strong>
          </div>`;
        }).join('') : ''}
        <div class="report-row">
          <span>💰 الصافي (الفائدة)</span>
          <strong class="${log.profit >= 0 ? 'positive' : 'negative'}" style="font-size:1.1rem">${fmt(log.profit, 'دج')}</strong>
        </div>
      </div>
      <div class="report-block">
        <div class="report-block-title">🌾 جدول المخزون</div>
        <div class="report-row"><span>شعير داخل اليوم</span><strong>${fmt(log.feedIn, 'كغ')}</strong></div>
        <div class="report-row"><span>سعر الشراء</span><strong>${log.feedPrice > 0 ? fmt(log.feedPrice, 'دج/كغ') : '—'}</strong></div>
        <div class="report-row"><span>تكلفة الشراء</span><strong class="${log.feedCost > 0 ? 'negative' : ''}">${log.feedCost > 0 ? fmt(log.feedCost, 'دج') : '—'}</strong></div>
        <div class="report-row"><span>شعير مستهلك</span><strong>${fmt(log.feedUsed, 'كغ')}</strong></div>
        <div class="report-row">
          <span>الرصيد الحالي</span>
          <strong class="${feedWarn ? 'warn' : 'positive'}">${fmt(feedBal, 'كغ')} ${feedWarn ? '⚠️' : ''}</strong>
        </div>
        <div class="report-block-title" style="margin-top:14px">⚠️ مؤشرات الأداء</div>
        <div class="report-row"><span>نسبة الكسر</span>
          <strong class="${brokenWarn ? 'negative' : 'positive'}">${brokenPct}% ${brokenWarn ? '⚠️' : '✓'}</strong>
        </div>
        <div class="report-row"><span>قيمة الكسر الضائعة</span>
          <strong class="negative">${fmt(log.broken * log.price, 'دج')}</strong>
        </div>
        <div class="report-row"><span>الدجاج النافق اليوم</span>
          <strong class="${log.dead > 0 ? 'negative' : ''}">
            ${log.dead > 0 ? '💀 ' : '✓ '}${fmt(log.dead)} دجاجة
          </strong>
        </div>
      </div>
    </div>
    <div class="accountant-note">
      <strong>💼 خلاصة المحاسب:</strong>
      ${generateAccountantNote(log, brokenPct, brokenWarn)}
    </div>
    ${log.notes ? `<div class="report-block" style="margin-top:12px"><div class="report-block-title">📝 الملاحظات</div><p style="color:var(--text-secondary);font-size:0.88rem">${log.notes}</p></div>` : ''}
  `;
  modal.style.display = 'flex';
}

document.getElementById('btn-close-details')?.addEventListener('click', () => {
  document.getElementById('daily-details-modal').style.display = 'none';
});
window.addEventListener('click', (e) => {
  const modal = document.getElementById('daily-details-modal');
  if (e.target === modal) modal.style.display = 'none';
});

function clearDailyForm() {
  ['inp-produced', 'inp-broken', 'inp-price', 'inp-sold-total', 'inp-free-plates',
    'inp-feed-in', 'inp-feed-price', 'inp-feed-used', 'inp-dead', 'inp-water-cost', 'inp-manure-income',
    'inp-owner-advance', 'inp-notes', 'inp-special-plates', 'inp-special-singles', 'inp-special-price'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  // clear partner expense fields
  document.querySelectorAll('[id^="inp-pexp-"]').forEach(el => el.value = '');
  document.getElementById('inp-date').value = todayStr();
  document.getElementById('advance-entries').innerHTML = `
    <div class="advance-row">
      <select class="adv-worker-select">${workerOptions()}</select>
      <input type="number" class="adv-amount" placeholder="المبلغ (دج)" min="0" />
      <button class="btn-remove-adv" title="حذف">✕</button>
    </div>`;
  document.querySelector('.btn-remove-adv')?.addEventListener('click', (e) => e.target.closest('.advance-row')?.remove());
  document.getElementById('daily-report-output').style.display = 'none';
  updateDailyCalc();
}

/* ===================== SALES + FEED + CREDITS PAGE ===================== */
function switchSalesTab(tabId, btn) {
  document.querySelectorAll('#sales-page-tabs .page-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#page-sales .tab-panel').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('active');
  // Re-render the active tab's content
  if (tabId === 'tab-feed') renderFeedPage();
  else if (tabId === 'tab-credits') renderCreditsTable();
  else renderSalesTable();
}

function renderSalesFeedPage() {
  renderSalesTable();
  renderFeedPage();
  renderCreditsTable();
}

/* ===================== SALES TABLE ===================== */
function renderSalesTable() {
  const logs = DB.get('daily_logs') || [];
  const tbody = document.getElementById('sales-tbody');
  let totalIncome = 0;
  let totalSpecialIncome = 0;
  let totalProfit = 0;
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">لا توجد مبيعات مسجلة</td></tr>';
    document.getElementById('total-income-chip').textContent = '0 دج';
    const profitChip = document.getElementById('total-profit-chip');
    if (profitChip) profitChip.textContent = '0 دج';
    return;
  }
  tbody.innerHTML = '';
  const sorted = [...logs].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach(log => {
    totalIncome += Number(log.income) || 0;
    totalSpecialIncome += Number(log.specialIncome) || 0;
    totalProfit += Number(log.profit) || 0;
    const sp = (log.specialPlates > 0 || log.specialSingles > 0)
      ? `<span style="color:var(--gold);font-size:0.8rem">★${log.specialPlates > 0 ? fmt(log.specialPlates)+'بلاكة' : ''} ${log.specialSingles > 0 ? '+'+log.specialSingles+'بيضة' : ''}<br>${fmt(log.specialIncome, 'دج')}</span>`
      : '<span style="color:var(--text-muted)">—</span>';
    const profit = Number(log.profit) || 0;
    const profitColor = profit >= 0 ? 'var(--green)' : 'var(--red)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(log.date)}</td>
      <td>${fmt(log.soldGroups)}</td>
      <td>${fmt(log.soldSingle)}</td>
      <td>${fmt(log.price, 'دج')}</td>
      <td><strong style="color:var(--green)">${fmt(log.income, 'دج')}</strong></td>
      <td>${sp}</td>
      <td><strong style="color:var(--blue)">${fmt((Number(log.income)||0)+(Number(log.specialIncome)||0), 'دج')}</strong></td>
      <td><strong style="color:${profitColor};font-size:1rem">${fmt(profit, 'دج')}</strong></td>
      <td>
        <button class="btn btn-outline btn-sm btn-view-log" data-id="${log.id}" style="margin-left:4px">👁تفصيل</button>
        <button class="btn btn-danger btn-sm btn-delete-log" data-id="${log.id}">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('total-income-chip').textContent = fmt(totalIncome + totalSpecialIncome, 'دج');
  const profitChip = document.getElementById('total-profit-chip');
  if (profitChip) {
    profitChip.textContent = fmt(totalProfit, 'دج');
    profitChip.style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  }
  // Update credits chip
  const totalCred = getTotalCredits();
  const credChip = document.getElementById('total-credits-chip');
  if (credChip) { credChip.textContent = fmt(totalCred, 'دج'); credChip.style.color = totalCred > 0 ? 'var(--red)' : ''; }
  // Attach events
  tbody.querySelectorAll('.btn-view-log').forEach(btn => {
    btn.addEventListener('click', () => {
      showDailyLogDetails(Number(btn.dataset.id));
    });
  });
  tbody.querySelectorAll('.btn-delete-log').forEach(btn => {
    btn.addEventListener('click', () => {
      const logId = Number(btn.dataset.id);
      deleteLogById(logId);
    });
  });
}

/* ===================== CREDITS (DEBTS) ===================== */
function renderCreditsTable() {
  const credits = DB.get('credits') || [];
  const tbody = document.getElementById('credits-tbody');
  if (!tbody) return;
  if (!credits.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">لا توجد كريديتات مسجلة</td></tr>';
    document.getElementById('total-credits-chip')?.parentElement && (document.getElementById('total-credits-chip').textContent = '0 دج');
    return;
  }
  tbody.innerHTML = '';
  let total = 0;
  const sorted = [...credits].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach(c => {
    total += Number(c.amount) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(c.date)}</td>
      <td><strong>${c.clientName || '—'}</strong></td>
      <td>${c.description || '—'}</td>
      <td><strong style="color:var(--red)">${fmt(c.amount, 'دج')}</strong></td>
      <td>
        <button class="btn btn-danger btn-sm btn-delete-credit" data-id="${c.id}">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  const credChip = document.getElementById('total-credits-chip');
  if (credChip) { credChip.textContent = fmt(total, 'دج'); credChip.style.color = total > 0 ? 'var(--red)' : ''; }

  tbody.querySelectorAll('.btn-delete-credit').forEach(btn => {
    btn.addEventListener('click', () => deleteCredit(Number(btn.dataset.id)));
  });
}

function addCredit() {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط (الراية)', 'error'); return;
  }
  const date   = document.getElementById('inp-credit-date')?.value || todayStr();
  const client = document.getElementById('inp-credit-client')?.value.trim() || '';
  const desc   = document.getElementById('inp-credit-desc')?.value.trim() || '';
  const amount = Number(document.getElementById('inp-credit-amount')?.value) || 0;
  if (!client) { showToast('يرجى إدخال اسم العميل', 'error'); return; }
  if (!amount) { showToast('يرجى إدخال المبلغ', 'error'); return; }
  const credits = DB.get('credits') || [];
  credits.push({ id: Date.now(), date, clientName: client, description: desc, amount });
  DB.set('credits', credits);
  document.getElementById('inp-credit-client').value = '';
  document.getElementById('inp-credit-desc').value = '';
  document.getElementById('inp-credit-amount').value = '';
  document.getElementById('inp-credit-date').value = todayStr();
  addActivity(`تم تسجيل كريديت لـ ${client}: ${fmt(amount, 'دج')}`, '💳');
  renderCreditsTable();
  showToast('✅ تم تسجيل الكريديت');
}

function deleteCredit(id) {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط (الراية)', 'error'); return;
  }
  if (!confirm('حذف هذا الكريديت نهائياً؟')) return;
  let credits = DB.get('credits') || [];
  credits = credits.filter(c => c.id !== id);
  DB.set('credits', credits);
  renderCreditsTable();
  showToast('تم حذف الكريديت', 'warning');
}

/* ===================== PARTNERS MANAGEMENT ===================== */
function renderPartnersSettings() {
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const container = document.getElementById('partners-list');
  if (!container) return;
  if (!partners.length) {
    container.innerHTML = '<div class="empty-state" style="padding:20px 0"><p>لا يوجد شركاء بعد.</p></div>';
    return;
  }
  container.innerHTML = '';
  partners.forEach(p => {
    const div = document.createElement('div');
    div.className = 'partner-row';
    div.innerHTML = `
      <div class="partner-info">
        <span class="partner-avatar">${p.name.charAt(0)}</span>
        <span class="partner-name">${p.name}</span>
        <span class="partner-share-badge">${p.sharePercent}%</span>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deletePartner(${p.id})">&#x2715; حذف</button>
    `;
    container.appendChild(div);
  });
}

function addPartner() {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error'); return;
  }
  // This can be called from Settings or the new Team page
  const nameFromSettings = document.getElementById('new-partner-name')?.value.trim();
  const shareFromSettings = Number(document.getElementById('new-partner-share')?.value) || 0;
  const nameFromTeam = document.getElementById('new-team-partner-name')?.value.trim();
  const shareFromTeam = Number(document.getElementById('new-team-partner-share')?.value) || 0;

  const name = nameFromSettings || nameFromTeam;
  const share = shareFromSettings || shareFromTeam;

  if (!name) { showToast('يرجى إدخال اسم الشريك', 'error'); return; }
  if (share <= 0 || share > 100) { showToast('نسبة غير صحيحة (1-100)', 'error'); return; }
  
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  partners.push({ id: Date.now(), name, sharePercent: share });
  settings.partners = partners;
  DB.set('settings', settings);
  
  if (document.getElementById('new-partner-name')) document.getElementById('new-partner-name').value = '';
  if (document.getElementById('new-partner-share')) document.getElementById('new-partner-share').value = '';
  if (document.getElementById('new-team-partner-name')) document.getElementById('new-team-partner-name').value = '';
  if (document.getElementById('new-team-partner-share')) document.getElementById('new-team-partner-share').value = '';

  renderPartnersSettings();
  renderWorkersPage(); // Refresh team page too
  renderPartnerExpensesInForm();
  addActivity(`تم إضافة الشريك ${name} (حصة ${share}%)`, '🤝');
  showToast(`✅ تمت إضافة ${name}`);
}

function deletePartner(id) {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error'); return;
  }
  if (!confirm('هل تريد حذف هذا الشريك؟')) return;
  const settings = DB.get('settings') || defaultSettings();
  const partners = (settings.partners || []).filter(p => p.id !== id);
  settings.partners = partners;
  DB.set('settings', settings);
  renderPartnersSettings();
  renderWorkersPage();
  renderPartnerExpensesInForm();
  showToast('تم حذف الشريك', 'warning');
}

function renderPartnerExpensesInForm() {
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const container = document.getElementById('partner-expenses-section');
  if (!container) return;
  if (!partners.length) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="section-divider">مصاريف الشركاء</div>
    ${partners.map(p => `
      <div class="form-group">
        <label for="inp-pexp-${p.id}">🤝 مصاريف ${p.name} (دج)</label>
        <input type="number" id="inp-pexp-${p.id}" placeholder="0" min="0"
          oninput="updateDailyCalc()" />
      </div>
    `).join('')}
  `;
}

/* ===================== FEED PAGE ===================== */
function renderFeedPage() {
  const logs = DB.get('daily_logs') || [];
  const settings = DB.get('settings') || defaultSettings();
  const tbody = document.getElementById('feed-tbody');
  const threshold = Number(settings.feedAlertThreshold) || 100;

  let runningBal = Number(settings.initialFeed) || 0;
  let totalIn = 0, totalUsed = 0, totalCost = 0;

  tbody.innerHTML = '';
  const sorted = [...logs].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">لا توجد حركات مسجلة</td></tr>';
  } else {
    sorted.forEach(log => {
      const feedIn = Number(log.feedIn) || 0;
      const feedUsed = Number(log.feedUsed) || 0;
      const feedPr = Number(log.feedPrice) || 0;
      const feedCstDay = Number(log.feedCost) || 0;
      runningBal += feedIn - feedUsed;
      totalIn += feedIn;
      totalUsed += feedUsed;
      totalCost += feedCstDay;
      const warn = runningBal < threshold;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDate(log.date)}</td>
        <td><span style="color:var(--green)">+${fmt(feedIn)}</span></td>
        <td>${feedPr > 0 ? fmt(feedPr, 'دج') : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td>${feedCstDay > 0 ? '<span style="color:var(--orange)">' + fmt(feedCstDay, 'دج') + '</span>' : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td><span style="color:var(--red)">-${fmt(feedUsed)}</span></td>
        <td><strong style="color:${warn ? 'var(--orange)' : 'var(--text-primary)'}">${fmt(runningBal)}</strong></td>
        <td>${warn ? '<span class="badge badge-orange">⚠️ منخفض</span>' : '<span class="badge badge-green">✓ جيد</span>'}</td>
        <td class="admin-only">
          <button class="btn-delete-log-feed" data-id="${log.id}" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:1.1rem; padding:4px;">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  const finalBal = getCurrentFeedBalance();
  document.getElementById('feed-balance-big').textContent = fmt(finalBal, 'كغ');
  document.getElementById('feed-total-in').textContent = fmt(totalIn, 'كغ');
  document.getElementById('feed-total-used').textContent = fmt(totalUsed, 'كغ');
  document.getElementById("feed-total-cost").textContent = fmt(totalCost, "دج");

    // Attach delete events for feed table
    tbody.querySelectorAll(".btn-delete-log-feed").forEach((btn) => {
      btn.addEventListener("click", () => {
        const logId = Number(btn.dataset.id);
        deleteLogById(logId);
      });
    });
}

/* ===================== TEAM (WORKERS + PARTNERS) ===================== */
function switchTeamTab(tabId, btn) {
  document.querySelectorAll('#team-page-tabs .page-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#page-workers .tab-panel').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const panel = document.getElementById(tabId);
  if (panel) panel.classList.add('active');
  renderWorkersPage();
}

function renderWorkersPage() {
  // Only owner and partner get read-only view — worker has full access
  const isRestricted = (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner');
  
  // Hide add forms for restricted roles
  document.querySelectorAll('#page-workers .restricted-edit').forEach(el => {
    el.style.display = isRestricted ? 'none' : 'block';
  });

  renderWorkersList(isRestricted);
  renderPartnersList(isRestricted);
}

function renderWorkersList(isRestricted) {
  const workers = DB.get('workers') || [];
  const container = document.getElementById('workers-list-container');
  if (!workers.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><p>لم يتم إضافة أي عمال بعد.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="workers-grid" id="workers-grid"></div>`;
  const grid = document.getElementById('workers-grid');
  workers.forEach(w => {
    const totalAdv = (w.advances || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const netSalary = (Number(w.salary) || 0) - totalAdv;
    const advHtml = (w.advances || []).slice(-5).reverse().map(a =>
      `<div class="adv-entry"><span>${fmtDate(a.date)}</span><span class="amt">${fmt(a.amount, 'دج')}</span></div>`
    ).join('') || '<div style="color:var(--text-muted);font-size:0.8rem;padding:6px 0">لا توجد سلفيات</div>';

    const card = document.createElement('div');
    card.className = 'worker-card';
    card.innerHTML = `
      <div class="worker-header">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="worker-avatar">${w.name.charAt(0)}</div>
          <div><div class="worker-name">${w.name}</div><div class="worker-id">#${w.id}</div></div>
        </div>
        ${!isRestricted ? `<button class="btn btn-danger btn-sm" onclick="deleteWorker(${w.id})">حذف</button>` : ''}
      </div>
      <div class="worker-stat"><span>الراتب الشهري</span><strong class="success">${fmt(w.salary, 'دج')}</strong></div>
      <div class="worker-stat"><span>إجمالي السلف</span><strong class="danger">${fmt(totalAdv, 'دج')}</strong></div>
      <div class="worker-stat"><span>الصافي المستحق</span><strong class="${netSalary < 0 ? 'danger' : 'success'}">${fmt(netSalary, 'دج')}</strong></div>
      <div class="adv-history">${advHtml}</div>
      <div class="worker-actions">
        ${!isRestricted ? `<button class="btn btn-outline btn-sm" onclick="resetWorkerAdvances(${w.id})">🔄 تصفية السلف</button>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

function renderPartnersList(isRestricted) {
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const container = document.getElementById('partners-list-container');
  if (!container) return;
  
  if (!partners.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🤝</div><p>لم يتم إضافة أي شركاء بعد.</p></div>`;
    return;
  }

  container.innerHTML = `<div class="workers-grid" id="partners-grid-team"></div>`;
  const grid = document.getElementById('partners-grid-team');
  
  partners.forEach(p => {
    const card = document.createElement('div');
    card.className = 'worker-card';
    card.style.borderTop = '3px solid var(--blue)';
    card.innerHTML = `
      <div class="worker-header">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="worker-avatar" style="background:var(--blue-gradient);color:white">${p.name.charAt(0)}</div>
          <div><div class="worker-name">${p.name}</div><div class="worker-id">شريك 🤝</div></div>
        </div>
        ${!isRestricted ? `<button class="btn btn-danger btn-sm" onclick="deletePartner(${p.id})">حذف</button>` : ''}
      </div>
      <div class="worker-stat"><span>نسبة المشاركة</span><strong class="success">${p.sharePercent}%</strong></div>
      <div class="worker-stat"><span>الحصة التقديرية</span><strong class="success">تلقائي</strong></div>
    `;
    grid.appendChild(card);
  });
}

document.addEventListener('click', function (e) {
  if (e.target.classList.contains('btn-remove-adv')) {
    e.target.closest('.advance-row')?.remove();
  }
});

function deleteLogById(logId) {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط (الراية)', 'error');
    return;
  }
  if (!confirm('هل تريد حذف هذا السجل نهائياً؟ ستفقد كافة بيانات هذا اليوم.')) return;
  let logs = DB.get('daily_logs') || [];
  const logToDelete = logs.find(l => l.id === logId);
  const detailInfo = logToDelete ? `(يوم ${logToDelete.date} المدخول: ${fmt(logToDelete.income, 'دج')} والكرطونات: ${logToDelete.koliates})` : '';

  logs = logs.filter(l => l.id !== logId);
  DB.set('daily_logs', logs);
  addActivity(`قام العامل بحذف سجل ${detailInfo}`, '🗑');
  renderSalesTable();
  renderFeedPage();
  renderReportsPage();
  renderDashboard();
  showToast('تم حذف السجل', 'warning');
}

function deleteWorker(id) {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error');
    return;
  }
  if (!confirm('هل تريد بالتأكيد حذف هذا العامل؟')) return;
  let workers = DB.get('workers') || [];
  const w = workers.find(wk => wk.id === id);
  const detail = w ? `(${w.name})` : '';
  workers = workers.filter(wk => wk.id !== id);
  DB.set('workers', workers);
  addActivity(`قام العامل بحذف العامل ${detail}`, '🗑');
  renderWorkersPage();
  showToast('تم حذف العامل', 'warning');
}

function resetWorkerAdvances(id) {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error');
    return;
  }
  if (!confirm('تصفية جميع السلفيات لهذا العامل؟ (بعد الخصم من الراتب)')) return;
  const workers = DB.get('workers') || [];
  const w = workers.find(wk => wk.id === id);
  if (w) {
    w.advances = [];
    DB.set('workers', workers);
    addActivity(`تم تصفية سلف العامل ${w.name}`, '✅');
    renderWorkersPage();
    showToast('تم تصفية السلفيات');
  }
}

/* ===================== REPORTS PAGE ===================== */
function renderReportsPage() {
  const logs = DB.get('daily_logs') || [];
  const now = new Date();
  const monthLogs = logs.filter(l => {
    const d = new Date(l.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const totalIncome = monthLogs.reduce((s, l) => s + (Number(l.income) || 0), 0);
  const totalProd = monthLogs.reduce((s, l) => s + (Number(l.produced) || 0), 0);
  const totalNet = monthLogs.reduce((s, l) => s + (Number(l.netEggs) || 0), 0);
  const totalBroken = monthLogs.reduce((s, l) => s + (Number(l.broken) || 0), 0);
  const totalDead = monthLogs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
  const brokenLoss = getTotalBrokenLossThisMonth();
  const totalAdv = getTotalAdvances();
  const totalKartons = monthLogs.reduce((s, l) => s + (Number(l.koliates) || 0), 0);
  const totalFeedCost = logs.reduce((s, l) => s + (Number(l.feedCost) || 0), 0);

  const summary = document.getElementById('monthly-summary');
  summary.innerHTML = `
    <div class="report-stat"><div class="rs-val">${fmt(totalIncome, 'دج')}</div><div class="rs-lbl">إجمالي المداخيل</div></div>
    <div class="report-stat"><div class="rs-val">${fmt(totalProd)}</div><div class="rs-lbl">إجمالي المنتج (بلاكة)</div></div>
    <div class="report-stat"><div class="rs-val">${fmt(totalNet)}</div><div class="rs-lbl">إجمالي الصافي</div></div>
    <div class="report-stat"><div class="rs-val">${fmt(totalKartons)}</div><div class="rs-lbl">إجمالي الكرطونات</div></div>
    <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalFeedCost, 'دج')}</div><div class="rs-lbl">تكلفة الشعير الكلية</div></div>
    <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalBroken)}</div><div class="rs-lbl">إجمالي المكسور</div></div>
    <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(brokenLoss, 'دج')}</div><div class="rs-lbl">خسارة الكسر</div></div>
    <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalDead)}</div><div class="rs-lbl">إجمالي النفوق</div></div>
    <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalAdv, 'دج')}</div><div class="rs-lbl">إجمالي السلف</div></div>
  `;

  const tbody = document.getElementById('prod-tbody');
  const sorted = [...logs].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">لا توجد سجلات</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  sorted.forEach(log => {
    const tr = document.createElement('tr');
    const enteredBadge = log.enteredBy
      ? `<span class="entered-by-badge">👷 ${log.enteredBy}</span>` : '';
    tr.innerHTML = `
      <td>${fmtDate(log.date)}</td>
      <td>${fmt(log.produced)}</td>
      <td><span style="color:var(--red)">${fmt(log.broken)}</span></td>
      <td><strong style="color:var(--green)">${fmt(log.netEggs)}</strong></td>
      <td>${fmt(log.koliates)}</td>
      <td>${fmt(log.singleLeft)}</td>
      <td>${log.dead > 0 ? `<span style="color:var(--red)">💀 ${log.dead}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-size:0.8rem">${enteredBadge}</td>
      <td style="color:var(--text-secondary);font-size:0.8rem">${log.notes || '—'}</td>
      <td class="admin-only"><button class="btn btn-danger btn-sm btn-delete-log-rep" data-id="${log.id}">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-delete-log-rep').forEach(btn => {
    btn.addEventListener('click', () => deleteLogById(Number(btn.dataset.id)));
  });
}

/* ===================== SETTINGS ===================== */
function loadSettingsForm() {
  const s = DB.get('settings') || defaultSettings();
  document.getElementById('farm-name').value = s.farmName || '';
  document.getElementById('farm-owner').value = s.owner || '';
  document.getElementById('farm-chickens').value = s.initialChickens || '';
  document.getElementById('farm-feed-init').value = s.initialFeed || '';
  document.getElementById('farm-chicken-price').value = s.chickenPrice || '';
  document.getElementById('farm-feed-price').value = s.feedPrice || '';
  document.getElementById('feed-alert-threshold').value = s.feedAlertThreshold || 100;
  document.getElementById('broken-alert-pct').value = s.brokenAlertPct || 5;
  const loyerEl = document.getElementById('farm-loyer');
  const elecEl  = document.getElementById('farm-electricity');
  if (loyerEl) loyerEl.value = s.loyer || '';
  if (elecEl)  elecEl.value  = s.electricity || '';
  const repLoyerEl = document.getElementById('farm-repair-loyer');
  const repTotalEl = document.getElementById('farm-repair-total');
  if (repLoyerEl) repLoyerEl.value = s.repairLoyer || '';
  if (repTotalEl) repTotalEl.value  = s.repairTotal || '';
  // Render partners list
  renderPartnersSettings();

  // Lock settings for owner/partner (read-only) — worker has full access
  const isReadOnly = (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner');
  const settingsInputs = document.querySelectorAll('#page-settings input, #page-settings textarea, #page-settings select');
  settingsInputs.forEach(el => {
    el.disabled = isReadOnly;
    el.style.opacity = isReadOnly ? '0.7' : '1';
    el.style.cursor = isReadOnly ? 'not-allowed' : '';
  });
  // Hide save/action buttons for restricted roles
  // Note: we keep the cards visible (admin-only-card) for workers but in read-only mode
  // Only hide the interactive action buttons/forms, not the info cards themselves
  const settingsActionBtns = document.querySelectorAll(
    '#btn-save-settings, #btn-save-general-settings, #btn-reset-all, #btn-add-partner, #partner-add-form, #btn-create-worker-account'
  );
  settingsActionBtns.forEach(el => {
    if (el) el.style.display = isReadOnly ? 'none' : '';
  });
  // Show worker-accounts-card and partners-settings-card but disable all inputs inside them
  const adminCards = document.querySelectorAll('#worker-accounts-card, #partners-settings-card');
  adminCards.forEach(card => {
    if (card) {
      card.style.display = '';  // always visible
      card.querySelectorAll('input, select, textarea, button:not(.btn-danger)').forEach(el => {
        el.disabled = isReadOnly;
        el.style.opacity = isReadOnly ? '0.6' : '1';
        el.style.cursor = isReadOnly ? 'not-allowed' : '';
      });
    }
  });
  // Show a read-only notice
  let notice = document.getElementById('settings-readonly-notice');
  if (isReadOnly) {
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'settings-readonly-notice';
      notice.style.cssText = 'background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.3);border-radius:10px;padding:12px 16px;margin-bottom:16px;color:#f6ad55;font-size:0.88rem;display:flex;align-items:center;gap:10px;';
      notice.innerHTML = '🔒 <span>وضع المشاهدة فقط — لا يمكنك تعديل الإعدادات</span>';
      const settingsPage = document.getElementById('page-settings');
      const firstCard = settingsPage?.querySelector('.form-grid');
      if (firstCard) settingsPage.querySelector('.page-header')?.after(notice);
    }
    notice.style.display = 'flex';
  } else if (notice) {
    notice.style.display = 'none';
  }
}

function saveSettings() {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
    showToast('صلاحية محظورة: المشاهدة فقط', 'error');
    return;
  }
  const existing = DB.get('settings') || defaultSettings();
  const s = {
    farmName: document.getElementById('farm-name').value || (CURRENT_FACTORY?.name || 'deku'),
    owner: document.getElementById('farm-owner').value || '',
    initialChickens: Number(document.getElementById('farm-chickens').value) || 0,
    initialFeed: Number(document.getElementById('farm-feed-init').value) || 0,
    chickenPrice: Number(document.getElementById('farm-chicken-price').value) || 0,
    feedPrice: Number(document.getElementById('farm-feed-price').value) || 0,
    feedAlertThreshold: Number(document.getElementById('feed-alert-threshold').value) || 100,
    brokenAlertPct: Number(document.getElementById('broken-alert-pct').value) || 5,
    deletePassword: existing.deletePassword || '1234',
    loyer: Number(document.getElementById('farm-loyer')?.value) || 0,
    electricity: Number(document.getElementById('farm-electricity')?.value) || 0,
    repairLoyer: Number(document.getElementById('farm-repair-loyer')?.value) || 0,
    repairTotal: Number(document.getElementById('farm-repair-total')?.value) || 0,
    partners: existing.partners || []  // preserve partners
  };
  DB.set('settings', s);
  addActivity('تم تحديث إعدادات المصنع', '⚙️');
  showToast('✅ تم حفظ الإعدادات');
}

/* ===================== ADD WORKER ===================== */
function initWorkersPage() {
  document.getElementById('btn-add-worker')?.addEventListener('click', () => {
    if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') {
      showToast('صلاحية محظورة: المشاهدة فقط', 'error'); return;
    }
    const name = document.getElementById('new-worker-name').value.trim();
    const salary = Number(document.getElementById('new-worker-salary').value) || 0;
    if (!name) { showToast('يرجى إدخال اسم العامل', 'error'); return; }
    const workers = DB.get('workers') || [];
    const newWorker = { id: Date.now(), name, salary, advances: [] };
    workers.push(newWorker);
    DB.set('workers', workers);
    document.getElementById('new-worker-name').value = '';
    document.getElementById('new-worker-salary').value = '';
    addActivity(`تم إضافة العامل ${name}`, '👷');
    renderWorkersPage();
    populateWorkerSelects();
    showToast(`✅ تمت إضافة ${name}`);
  });

  document.getElementById('btn-add-team-partner')?.addEventListener('click', addPartner);
}

/* ===================== MOBILE SIDEBAR ===================== */
function initMobileSidebar() {
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  hamburger.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
}

/* ===================== RESET ===================== */
function resetAllData() {
  if (CURRENT_ROLE === 'owner' || CURRENT_ROLE === 'partner') { 
    showToast('صلاحية محظورة: لا يمكنك إعادة تعيين بيانات المصنع', 'error');
    return; 
  }
  if (!confirm(`⚠️ تحذير: سيتم حذف جميع سجلات مصنع "${CURRENT_FACTORY?.name}" بشكل نهائي لا يمكن التراجع عنه!\n\nهل تريد المتابعة؟`)) return;
  if (!confirm(`⛔ تأكيد أخير: كل البيانات (الإنتاج، المبيعات، الشعير، العمال) ستُمسح من السحابة نهائياً.\n\nاضغط موافق للتأكيد.`)) return;

  showGlobalLoader('جاري إعادة ضبط المصنع...');

  const keys = ['settings', 'workers', 'daily_logs', 'activities', 'credits'];
  const emptyData = {
    settings:   defaultSettings(),
    workers:    [],
    daily_logs: [],
    activities: [],
    credits:    []
  };

  // 1. وقف مستمعات المزامنة أولاً لمنع استرجاع البيانات القديمة
  stopFactorySync();

  // 2. مسح localStorage
  keys.forEach(k => localStorage.removeItem(`zohir_${CURRENT_FACTORY.id}_${k}`));

  // 3. إعادة تهيئة البيانات المحلية بالقيم الافتراضية
  initFactoryData();

  // 4. الكتابة الفورية إلى Firestore حتى لا يستعيد المزامن البيانات القديمة
  const batch = fs.batch();
  keys.forEach(k => {
    const ref = fs.collection('app_data').doc(`${CURRENT_FACTORY.id}_${k}`);
    batch.set(ref, { data: emptyData[k], lastUpdated: new Date().toISOString() });
  });

  batch.commit()
    .then(() => {
      setSyncStatus('online');
      // 5. إعادة تشغيل المزامنة مع البيانات الجديدة الفارغة
      initCloudSync();
      hideGlobalLoader();
      showToast('✅ تم إعادة تعيين بيانات المصنع بالكامل', 'success');
      showPage('dashboard');
      renderCurrentPage();
    })
    .catch(e => {
      console.error('Reset cloud error:', e);
      hideGlobalLoader();
      showToast('⚠️ تعذّر المسح من السحابة — تحقق من الاتصال', 'error');
      initCloudSync();
    });
}

/* ===================== BOOTSTRAP ===================== */
document.addEventListener('DOMContentLoaded', () => {
  // Init password modal listeners
  const passModal = document.getElementById('modal-delete-password');
  if (passModal) {
    document.getElementById('btn-confirm-delete-password').addEventListener('click', confirmDeletePassword);
    document.getElementById('btn-cancel-delete-password').addEventListener('click', closePasswordModal);
    passModal.addEventListener('click', (e) => { if (e.target === passModal) closePasswordModal(); });
    document.getElementById('delete-password-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmDeletePassword();
    });
  }
  // Show global loader until sync confirms if we have factories or not
  // initGlobalSync is called inside, which will eventually hide it
  updateLiveDate();
  setInterval(updateLiveDate, 60000);

  // Initialize UI components but don't show factory screen logic yet
  initFactoryScreen();
  initDailyForm();
  initWorkersPage();
  initMobileSidebar();

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  document.querySelectorAll('.bottom-nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  document.getElementById('bn-more')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('open');
  });

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-general-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-reset-all').addEventListener('click', resetAllData);

  // Credits tab events
  document.getElementById('btn-add-credit')?.addEventListener('click', addCredit);

  // Partners settings events
  document.getElementById('btn-add-partner')?.addEventListener('click', addPartner);

  // Sales page tabs
  document.querySelectorAll('#sales-page-tabs .page-tab').forEach(btn => {
    btn.addEventListener('click', () => switchSalesTab(btn.dataset.tab, btn));
  });

  // Daily Form listeners are already attached in initDailyForm()

  // Add direct refresh functionality to sync badge
  const syncBadge = document.getElementById('sync-badge');
  if (syncBadge) {
    syncBadge.classList.add('clickable');
    syncBadge.title = "اضغط للتحديث اليدوي من السحابة";
    syncBadge.addEventListener('click', () => {
      showToast('جاري تحديث البيانات...');
      initCloudSync();
    });
  }

  // START AUTH — this is now the app entry point
  initAuthListener();
  initRoleChooser();

  // ── Re-sync when app comes back from background (phone screen lock / tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.log('[Sync] App visible — forcing refresh from server...');
      forceRefreshFromCloud();
      // Also restart listeners in case they dropped
      if (CURRENT_FACTORY) {
        initCloudSync();
      } else {
        // Re-trigger global sync to pick up factory list changes
        if (GLOBAL_SYNC_UNSUB) { try { GLOBAL_SYNC_UNSUB(); } catch (e) { } }
        initGlobalSync();
      }
    }
  });

  // ── Re-sync when internet connection is restored
  window.addEventListener('online', () => {
    console.log('[Sync] Network restored — re-syncing...');
    showToast('📶 تم استعادة الاتصال — جاري المزامنة...', 'success');
    if (CURRENT_FACTORY) {
      initCloudSync();
    } else {
      if (GLOBAL_SYNC_UNSUB) { try { GLOBAL_SYNC_UNSUB(); } catch (e) { } }
      initGlobalSync();
    }
  });

  window.addEventListener('offline', () => {
    setSyncStatus('offline');
    showToast('⚠️ انقطع الاتصال بالإنترنت', 'error');
  });
});


// PWA Install Prompt Logic
let deferredPrompt;
const installBtn = document.getElementById('btn-install-app');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) {
    installBtn.style.display = 'flex';
    installBtn.style.alignItems = 'center';
    installBtn.style.gap = '10px';
  }
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      installBtn.style.display = 'none';
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('User accepted the install prompt');
      } else {
        console.log('User dismissed the install prompt');
      }
      deferredPrompt = null;
    }
  });
}
