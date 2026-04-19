/* ============================================================
   ZOHIR — Multi-Factory Management App  |  app.js
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
let CURRENT_ROLE = null;  // 'owner' | 'worker'
let CURRENT_USER_NAME = '';
// Secret code that new owners must enter when registering
const ADMIN_SECRET_CODE = 'ZOHIR2025';

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
  const roleSelect = document.getElementById('reg-role');
  const adminCodeWrap = document.getElementById('reg-admin-code-wrap');
  if (!roleSelect) return;
  roleSelect.addEventListener('change', () => {
    adminCodeWrap.style.display = roleSelect.value === 'owner' ? 'flex' : 'none';
  });
  adminCodeWrap.style.display = 'none'; // default: worker selected initially shows nothing
  roleSelect.value = 'worker';          // default to worker for safety
}

/* ---------- REGISTER ---------- */
async function doRegister() {
  clearAuthErrors();
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const role     = document.getElementById('reg-role').value;
  const adminCode = document.getElementById('reg-admin-code').value.trim();

  if (!name)     return showAuthError('reg-error', '⚠️ يرجى إدخال الاسم الكامل');
  if (!email)    return showAuthError('reg-error', '⚠️ يرجى إدخال البريد الإلكتروني');
  if (password.length < 6) return showAuthError('reg-error', '⚠️ كلمة المرور يجب أن تكون 6 أحرف على الأقل');
  if (role === 'owner' && adminCode !== ADMIN_SECRET_CODE)
    return showAuthError('reg-error', '❌ رمز الإدارة غير صحيح');

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
  document.body.classList.remove('role-owner', 'role-worker');
  document.body.classList.add(role === 'owner' ? 'role-owner' : 'role-worker');

  // Sidebar user info
  const avatar = document.getElementById('sidebar-user-avatar');
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  if (avatar) avatar.textContent = (name || '?').charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = name || 'مستخدم';
  if (roleEl) roleEl.textContent = role === 'owner' ? '👔 صاحب العمل' : '👷 عامل';

  // Worker banner in daily page
  const banners = document.querySelectorAll('.worker-mode-banner');
  banners.forEach(b => b.textContent = `👷 أنت مسجل دخول كعامل (${name}) — يمكنك إدخال بيانات اليوم فقط`);
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
    const cred = await secondAuth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    await fs.collection('users').doc(cred.user.uid).set({
      name, email, role: 'worker', createdAt: new Date().toISOString()
    });
    await secondAuth.signOut();

    document.getElementById('wa-name').value = '';
    document.getElementById('wa-email').value = '';
    document.getElementById('wa-password').value = '';
    okEl.textContent = `✅ تم إنشاء حساب العامل "${name}" بنجاح! يمكنه الآن تسجيل الدخول.`;
    addActivity(`تم إنشاء حساب للعامل ${name}`, '👷');
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
  const keys = ['settings', 'workers', 'daily_logs', 'activities'];
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

  const keys = ['settings', 'workers', 'daily_logs', 'activities'];
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
    [`zohir_${fid}_activities`, JSON.stringify([])]
  ];
  keys.forEach(([k, v]) => {
    if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  });
}

function defaultSettings() {
  return {
    farmName: CURRENT_FACTORY?.name || 'مصنع زهير',
    owner: '',
    initialChickens: 0,
    initialFeed: 0,
    chickenPrice: 0,
    feedPrice: 0,
    feedAlertThreshold: 100,
    brokenAlertPct: 5,
    deletePassword: '1234'
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
function renderCurrentPage() {
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;
  const pageId = activePage.id.replace('page-', '');
  const refreshers = {
    dashboard: renderDashboard,
    sales: renderSalesTable,
    feed: renderFeedPage,
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

    card.innerHTML = `
      <button class="factory-card-delete" data-id="${factory.id}" title="حذف المصنع">✕</button>
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

    // Delete button
    card.querySelector('.factory-card-delete').addEventListener('click', (e) => {
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
  document.getElementById('topbar-factory-name').textContent = `Zohir — ${factory.name}`;

  // Init local data safely (no cloud push)
  initFactoryData();

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

  // Add factory modal
  document.getElementById('btn-add-factory').addEventListener('click', () => {
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
    sales: renderSalesTable,
    feed: renderFeedPage,
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

  const calcFields = ['inp-produced', 'inp-broken', 'inp-price', 'inp-sold-total', 'inp-free-plates', 'inp-feed-in', 'inp-feed-price', 'inp-feed-used'];
  calcFields.forEach(id => {
    document.getElementById(id).addEventListener('input', updateDailyCalc);
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

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  const feedBal = getCurrentFeedBalance() + feedIn - feedUsed;
  const feedCost = feedIn * feedPrice;

  document.getElementById('prev-net').textContent = net >= 0 ? fmt(net) : '—';
  document.getElementById('prev-koliates').textContent = net >= 0 ? fmt(koliates) : '—';
  document.getElementById('prev-single').textContent = net >= 0 ? fmt(singleLeft) : '—';
  document.getElementById('prev-sold-groups').textContent = soldTotal > 0 ? fmt(soldGroups) + ' كرطون' : '—';
  document.getElementById('prev-sold-single').textContent = soldTotal > 0 ? fmt(soldSingle) + ' بلاكة' : '—';
  document.getElementById('prev-income').textContent = fmt(income, 'دج');
  document.getElementById('prev-feed').textContent = fmt(feedBal, 'كغ');
  document.getElementById('prev-feed-cost').textContent = feedPrice > 0 ? fmt(feedCost, 'دج') : '—';
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
  const notes = document.getElementById('inp-notes').value.trim();

  if (!date) { showToast('يرجى تحديد التاريخ', 'error'); return; }

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  const feedCost = feedIn * feedPrice;

  const log = {
    id: Date.now(),
    date, produced, broken, price,
    netEggs: net, koliates, singleLeft,
    soldTotal, soldGroups, soldSingle, freePlates, income,
    feedIn, feedPrice, feedCost, feedUsed, dead, waterCost, manureIncome, notes,
    enteredBy: CURRENT_USER_NAME || '',
    enteredByUid: CURRENT_USER ? CURRENT_USER.uid : ''
  };

  // Collect advances
  const advRows = document.querySelectorAll('.advance-row');
  const advancesThisDay = [];
  advRows.forEach(row => {
    const workerId = row.querySelector('.adv-worker-select').value;
    const amount = Number(row.querySelector('.adv-amount').value) || 0;
    if (workerId && amount > 0) advancesThisDay.push({ workerId, amount, date });
  });

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

  addActivity(`تم حفظ بيانات يوم ${fmtDate(date)} — مدخول: ${fmt(income, 'دج')}`, '📅');
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
        <div class="report-row" style="border-top:1px solid rgba(255,255,255,0.08);margin-top:6px;padding-top:8px">
          <span>💵 المدخول الإجمالي</span>
          <strong class="positive" style="font-size:1.1rem">${fmt(log.income, 'دج')}</strong>
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

function clearDailyForm() {
  ['inp-produced', 'inp-broken', 'inp-price', 'inp-sold-total', 'inp-free-plates',
    'inp-feed-in', 'inp-feed-price', 'inp-feed-used', 'inp-dead', 'inp-water-cost', 'inp-manure-income', 'inp-notes'].forEach(id => {
      document.getElementById(id).value = '';
    });
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

/* ===================== SALES TABLE ===================== */
function renderSalesTable() {
  const logs = DB.get('daily_logs') || [];
  const tbody = document.getElementById('sales-tbody');
  let totalIncome = 0;
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">لا توجد مبيعات مسجلة</td></tr>';
    document.getElementById('total-income-chip').textContent = '0 دج';
    return;
  }
  tbody.innerHTML = '';
  const sorted = [...logs].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach(log => {
    totalIncome += Number(log.income) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(log.date)}</td>
      <td>${fmt(log.soldGroups)}</td>
      <td>${fmt(log.soldSingle)}</td>
      <td>${fmt(log.price, 'دج')}</td>
      <td><strong style="color:var(--green)">${fmt(log.income, 'دج')}</strong></td>
      <td><button class="btn btn-danger btn-sm btn-delete-log" data-id="${log.id}">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('total-income-chip').textContent = fmt(totalIncome, 'دج');
  // Attach delete events
  tbody.querySelectorAll('.btn-delete-log').forEach(btn => {
    btn.addEventListener('click', () => {
      const logId = Number(btn.dataset.id);
      deleteLogById(logId);
    });
  });
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

/* ===================== WORKERS PAGE ===================== */
function renderWorkersPage() {
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
        <button class="btn btn-danger btn-sm" onclick="deleteWorker(${w.id})">حذف</button>
      </div>
      <div class="worker-stat"><span>الراتب الشهري</span><strong class="success">${fmt(w.salary, 'دج')}</strong></div>
      <div class="worker-stat"><span>إجمالي السلف</span><strong class="danger">${fmt(totalAdv, 'دج')}</strong></div>
      <div class="worker-stat"><span>الصافي المستحق</span><strong class="${netSalary < 0 ? 'danger' : 'success'}">${fmt(netSalary, 'دج')}</strong></div>
      <div class="adv-history">${advHtml}</div>
      <div class="worker-actions">
        <button class="btn btn-outline btn-sm" onclick="resetWorkerAdvances(${w.id})">🔄 تصفية السلف</button>
      </div>
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
  if (!confirm('هل تريد حذف هذا السجل نهائياً؟ ستفقد كافة بيانات هذا اليوم.')) return;
  let logs = DB.get('daily_logs') || [];
  logs = logs.filter(l => l.id !== logId);
  DB.set('daily_logs', logs);
  addActivity('تم حذف سجل يومي', '🗑');
  renderSalesTable();
  renderFeedPage();
  renderReportsPage();
  renderDashboard();
  showToast('تم حذف السجل', 'warning');
}

function deleteWorker(id) {
  if (!confirm('هل تريد بالتأكيد حذف هذا العامل؟')) return;
  let workers = DB.get('workers') || [];
  workers = workers.filter(w => w.id !== id);
  DB.set('workers', workers);
  addActivity('تم حذف عامل', '🗑');
  renderWorkersPage();
  showToast('تم حذف العامل', 'warning');
}

function resetWorkerAdvances(id) {
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
}

function saveSettings() {
  const existing = DB.get('settings') || defaultSettings();
  const s = {
    farmName: document.getElementById('farm-name').value || (CURRENT_FACTORY?.name || 'مصنع زهير'),
    owner: document.getElementById('farm-owner').value || '',
    initialChickens: Number(document.getElementById('farm-chickens').value) || 0,
    initialFeed: Number(document.getElementById('farm-feed-init').value) || 0,
    chickenPrice: Number(document.getElementById('farm-chicken-price').value) || 0,
    feedPrice: Number(document.getElementById('farm-feed-price').value) || 0,
    feedAlertThreshold: Number(document.getElementById('feed-alert-threshold').value) || 100,
    brokenAlertPct: Number(document.getElementById('broken-alert-pct').value) || 5,
    deletePassword: existing.deletePassword || '1234'
  };
  DB.set('settings', s);
  addActivity('تم تحديث إعدادات المصنع', '⚙️');
  showToast('✅ تم حفظ الإعدادات');
}

/* ===================== ADD WORKER ===================== */
function initWorkersPage() {
  document.getElementById('btn-add-worker').addEventListener('click', () => {
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
  if (!confirm(`⚠️ تحذير: سيتم حذف جميع سجلات مصنع "${CURRENT_FACTORY?.name}" بشكل نهائي لا يمكن التراجع عنه!\n\nهل تريد المتابعة؟`)) return;
  if (!confirm(`⛔ تأكيد أخير: كل البيانات (الإنتاج، المبيعات، الشعير، العمال) ستُمسح من السحابة نهائياً.\n\nاضغط موافق للتأكيد.`)) return;

  showGlobalLoader('جاري إعادة ضبط المصنع...');

  const keys = ['settings', 'workers', 'daily_logs', 'activities'];
  const emptyData = {
    settings:   defaultSettings(),
    workers:    [],
    daily_logs: [],
    activities: []
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
