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
let _paymentStatus = 'paid'; // 'paid' | 'unpaid' — tracks daily form payment toggle
let _dailyWizardStep = 0;
// Hashed versions of the secret codes
const ADMIN_SECRET_HASH = '2cad27b2e9406f8248c1806c048b3c51671db8e65888f418e93c74e185553686';
const DEV_SECRET_HASH = 'f2eb032f911a094ab44ac20b7603f57ef37523c3b96a49c4d0b3496595c8b0ad';

async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
// Tracks whether dev password was verified for the current partner account creation attempt
let _devPasswordVerified = false;
// Flag to prevent onAuthStateChanged from race-conditioning during registration
let _isRegistering = false;

/* ===================== PERMISSION HELPER ===================== */
/**
 * Returns true for users who cannot edit ANYTHING in the current factory:
 *   - 'partner' role (always)
 *   - 'owner' viewing another owner's factory (acting as partner)
 *
 * NOTE: Owners WITH workers can still manage partners, factories, settings,
 * and other administrative tasks. Only the daily data entry form is
 * restricted for them — that restriction is enforced by CSS
 * (body.has-workers.role-owner hides the form controls), and by an explicit
 * check inside saveDayData().
 */
function isReadOnlyUser() {
  if (CURRENT_ROLE === 'partner') return true;
  if (CURRENT_ROLE === 'worker')  return false;
  if (CURRENT_ROLE === 'owner') {
    // Owner is read-only when viewing a factory owned by someone else (as a partner)
    if (EFFECTIVE_OWNER_UID && CURRENT_USER && EFFECTIVE_OWNER_UID !== CURRENT_USER.uid) return true;
    return false;
  }
  return false;
}

/** Owner with workers cannot enter daily data — workers handle that. */
function cannotDoDailyEntry() {
  if (isReadOnlyUser()) return true;
  const btnSave = document.getElementById('btn-save-day');
  if (btnSave && btnSave.dataset.editMode === 'true') return false; // Allow owner to edit existing records
  
  if (CURRENT_ROLE === 'owner') {
    const workers = DB.get('workers') || [];
    if (workers.length > 0) return true;
  }
  return false;
}

function syncDailyReadOnlyState() {
  const locked = cannotDoDailyEntry();
  document.body.classList.toggle('daily-readonly', locked);
  const selector = [
    '#page-daily input',
    '#page-daily select',
    '#page-daily textarea',
    '#btn-save-day',
    '#btn-clear-form',
    '#add-advance-row',
    '#btn-save-broiler-day',
    '#btn-clear-broiler-form',
    '#broiler-add-advance-row',
    '#page-daily .btn-remove-adv'
  ].join(',');

  document.querySelectorAll(selector).forEach(el => {
    el.disabled = locked;
    if (locked) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  });
}

/* ---------- UI helpers ---------- */
function showAuthScreen() {
  document.getElementById('global-loader').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('factory-screen').style.display = 'none';
  document.getElementById('app-wrapper').style.display = 'none';
  // Always start on login tab
  if (typeof switchAuthTab === 'function') switchAuthTab('login');
}

function hideAuthScreen() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('factory-screen').style.display = 'flex';
  // The loader is opaque and sits above everything: if the cloud fetch that
  // normally hides it never resolves (slow mobile data), the user is left
  // staring at a black screen. The factory screen is up, so take it down.
  hideGlobalLoader();
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
function switchAuthTab(tab) {
  const loginForm    = document.getElementById('form-login');
  const registerForm = document.getElementById('form-register');
  const tabLogin     = document.getElementById('tab-login');
  const tabReg       = document.getElementById('tab-register');
  const tabsContainer = document.getElementById('auth-tabs-container');
  clearAuthErrors();
  if (tab === 'login') {
    if (tabsContainer) tabsContainer.classList.remove('is-register');
    loginForm.style.display    = '';
    registerForm.style.display = 'none';
    tabLogin.classList.add('active');
    tabReg.classList.remove('active');
  } else {
    if (tabsContainer) tabsContainer.classList.add('is-register');
    loginForm.style.display    = 'none';
    registerForm.style.display = '';
    tabLogin.classList.remove('active');
    tabReg.classList.add('active');
    // Trigger role chooser to show correct code field
    initRoleChooser();
  }
}

function initRoleChooser() {
  const roleSelect       = document.getElementById('reg-role');
  const adminCodeWrap    = document.getElementById('reg-admin-code-wrap');
  const devCodeWrap      = document.getElementById('reg-dev-code-wrap');
  const devCodeOwnerWrap = document.getElementById('reg-dev-code-owner-wrap');
  const roleNote         = document.getElementById('reg-role-note');
  if (!roleSelect) return;

  const notes = {
    owner:   'صاحب عمل: تُنشئ مصانعك الخاصة وتدير عمالك بحرية كاملة.',
  };

  const applyRole = (r) => {
    if (adminCodeWrap)    adminCodeWrap.style.display    = 'none';
    if (devCodeWrap)      devCodeWrap.style.display      = 'none'; // Partner logic removed
    if (devCodeOwnerWrap) devCodeOwnerWrap.style.display = r === 'owner'   ? '' : 'none';
    if (roleNote)         roleNote.textContent           = notes[r] || '';
  };

  // Attach change listener only once
  if (!roleSelect.dataset.listenerAttached) {
    roleSelect.addEventListener('change', () => applyRole(roleSelect.value));
    roleSelect.dataset.listenerAttached = 'true';
  }
  applyRole(roleSelect.value);
}

/* ---------- REGISTER ---------- */
async function doRegister() {
  clearAuthErrors();
  const name      = document.getElementById('reg-name').value.trim();
  const email     = document.getElementById('reg-email').value.trim();
  const password  = document.getElementById('reg-password').value;
  const role      = document.getElementById('reg-role').value;
  const adminCode    = document.getElementById('reg-admin-code')?.value.trim() || '';
  const devCode      = document.getElementById('reg-dev-code')?.value.trim() || '';
  const devCodeOwner = document.getElementById('reg-dev-code-owner')?.value.trim() || '';
  // Accept either the admin code or dev code for owner registration
  const ownerCode = adminCode || devCodeOwner || devCode;

  if (!name)     return showAuthError('reg-error', '⚠️ يرجى إدخال الاسم الكامل');
  if (!email)    return showAuthError('reg-error', '⚠️ يرجى إدخال البريد الإلكتروني');
  if (password.length < 6) return showAuthError('reg-error', '⚠️ كلمة المرور يجب أن تكون 6 أحرف على الأقل');
  if (role === 'owner') {
    const hashedOwnerCode = await hashString(ownerCode);
    if (hashedOwnerCode !== ADMIN_SECRET_HASH && hashedOwnerCode !== DEV_SECRET_HASH) {
      return showAuthError('reg-error', '❌ رمز المطور غير صحيح — تواصل مع المطور للحصول على الرمز');
    }
  }

  setAuthBtnLoading('btn-register', true);
  _isRegistering = true;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    // Save role + name in Firestore users collection — store lowercased email for reliable lookup
    const emailLc = (email || '').toLowerCase();
    await fs.collection('users').doc(cred.user.uid).set({
      name, email: emailLc, emailLower: emailLc, role,
      createdAt: new Date().toISOString(),
      migrationDone: true   // new accounts have no legacy data to migrate
    });
    
    // Manually initialize the session data for the new account
    CURRENT_USER = cred.user;
    CURRENT_ROLE = role;
    CURRENT_USER_NAME = name;
    EFFECTIVE_OWNER_UID = cred.user.uid;
    CURRENT_LINKED_OWNERS = [];
    
    // Process any pending partner invitations for this email BEFORE syncing
    try {
      const regInviteRes = await fs.collection('app_data')
        .where('email', '==', email.toLowerCase())
        .get();
      
      const inviteDocs = regInviteRes.docs.filter(d => d.data().type === 'partner_invite');

      if (inviteDocs.length > 0) {
        console.log('[Register] Found', inviteDocs.length, 'pending partner invitations');
        for (const invDoc of inviteDocs) {
          const inv = invDoc.data();
          if (!CURRENT_LINKED_OWNERS.includes(inv.ownerUid)) {
            CURRENT_LINKED_OWNERS.push(inv.ownerUid);
          }
          
          // Add this new user's UID to the owner's factory partnerUids
          try {
            const fListDocId = `factories_list_${inv.ownerUid}`;
            const fListDoc = await fs.collection('app_data').doc(fListDocId).get();
            if (fListDoc.exists) {
              const list = fListDoc.data().data || [];
              let listUpdated = false;
              list.forEach(factory => {
                if (!inv.factoryId || factory.id === inv.factoryId) {
                  factory.partnerUids = factory.partnerUids || [];
                  if (!factory.partnerUids.includes(cred.user.uid)) {
                    factory.partnerUids.push(cred.user.uid);
                    listUpdated = true;
                  }
                  if (inv.sharePercent) {
                    factory.partnerShares = factory.partnerShares || {};
                    factory.partnerShares[cred.user.uid] = inv.sharePercent;
                  }
                }
              });
              if (listUpdated) {
                await fs.collection('app_data').doc(fListDocId).update({ data: list });
                console.log('[Register] Updated factory list for owner', inv.ownerUid);
              }
            }
          } catch (fErr) { console.error('[Register] Factory link error:', fErr); }
          
          // Delete the processed invitation
          await fs.collection('app_data').doc(invDoc.id).delete();
        }
        
        // Update user doc with linked owners
        if (CURRENT_LINKED_OWNERS.length > 0) {
          await fs.collection('users').doc(cred.user.uid).update({ linkedOwners: CURRENT_LINKED_OWNERS });
          console.log('[Register] Linked to owners:', CURRENT_LINKED_OWNERS);
        }
      }
    } catch (invErr) { console.error('[Register] Invitation processing error:', invErr); }
    
    showToast(`✅ تم إنشاء الحساب — مرحباً ${name}!`);
    
    // Trigger UI update and sync
    applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
    hideAuthScreen();
    showGlobalLoader('جاري تهيئة حسابك الجديد...');
    await migrateFactoriesIfNeeded();
    initGlobalSync();

    _isRegistering = false;
  } catch (e) {
    _isRegistering = false;
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
  stopGlobalSync();
  CURRENT_FACTORY = null;
  CURRENT_USER = null;
  CURRENT_ROLE = null;
  CURRENT_LINKED_OWNERS = [];
  EFFECTIVE_OWNER_UID = null;
  WORKER_OWNER_UID = null;
  IS_INITIAL_CLOUD_LOAD = true;
  INITIAL_CLOUD_SYNC_DONE = false;
  document.body.className = '';
  
  // Clear auth forms so credentials aren't exposed
  const inputsToClear = [
    'login-email', 'login-password',
    'reg-name', 'reg-email', 'reg-password', 
    'reg-dev-code-owner', 'reg-admin-code'
  ];
  inputsToClear.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

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

  const workers = DB.get('workers') || [];
  if (workers.length > 0) document.body.classList.add('has-workers');
  else document.body.classList.remove('has-workers');

  // Sidebar user info
  const avatar = document.getElementById('sidebar-user-avatar');
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  if (avatar) avatar.textContent = (name || '?').charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = name || 'مستخدم';
  if (roleEl) {
    if (role === 'owner')   roleEl.textContent = '👔 صاحب العمل';
    else if (role === 'partner') roleEl.textContent = '🤝 شريك';
    else                    roleEl.textContent = '✍️ كاتب';
  }

  // Banner in daily page
  const banners = document.querySelectorAll('.worker-mode-banner');
  const hasWriter = workers.length > 0;
  banners.forEach(b => {
    if (role === 'worker') {
      b.textContent = `✍️ أنت مسجل دخول ككاتب (${name}) — يمكنك إدخال بيانات اليوم`;
      b.style.cssText = 'display:block;background:rgba(72,187,120,0.1);border:1px solid rgba(72,187,120,0.3);border-radius:8px;padding:10px 14px;margin-bottom:12px;color:#68d391;font-size:0.88rem';
    } else if (role === 'owner' && hasWriter) {
      b.textContent = `👁️ وضع المراقبة — الكاتب يتولى إدخال البيانات (${name})`;
      b.style.cssText = 'display:block;background:rgba(212,160,23,0.1);border:1px solid rgba(212,160,23,0.3);border-radius:8px;padding:10px 14px;margin-bottom:12px;color:#d4a017;font-size:0.88rem';
    } else {
      b.style.display = 'none';
    }
  });

  // Owner / Partner notice in daily page (orange — read-only)
  const isReadOnly = cannotDoDailyEntry();
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
  syncDailyReadOnlyState();
}

let CURRENT_LINKED_OWNERS = [];
let _factoryOrbitIntroLastAt = 0;

/* ---------- Auth State Listener — the master switch ---------- */
function initAuthListener() {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      showAuthScreen();
      setAuthBtnLoading('btn-login', false);
      setAuthBtnLoading('btn-register', false);
      
      // Critical: Clear global session state
      CURRENT_USER = null;
      CURRENT_ROLE = null;
      CURRENT_USER_NAME = '';
      CURRENT_LINKED_OWNERS = [];
      EFFECTIVE_OWNER_UID = null;
      WORKER_OWNER_UID = null;
      CURRENT_FACTORY = null;
      IS_INITIAL_CLOUD_LOAD = true;
      INITIAL_CLOUD_SYNC_DONE = false;
      stopGlobalSync();
      return;
    }

    CURRENT_USER = user;
    const userEmail = (user.email || '').toLowerCase();

    // 1. Setup real-time listener for user profile
    const userDocRef = fs.collection('users').doc(user.uid);
    const unsub = userDocRef.onSnapshot(async (doc) => {
      if (!doc.exists) {
        if (!_isRegistering) {
          console.warn(`[Auth] No profile for ${user.uid}`);
          CURRENT_ROLE = 'worker';
          CURRENT_USER_NAME = user.displayName || user.email;
          EFFECTIVE_OWNER_UID = user.uid;
          CURRENT_LINKED_OWNERS = [];
          applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
        }
        return;
      }

      const data = doc.data();
      const oldLinkedStr = JSON.stringify(CURRENT_LINKED_OWNERS);
      
      CURRENT_ROLE = data.role || 'worker';
      CURRENT_USER_NAME = data.name || user.displayName || user.email;
      CURRENT_LINKED_OWNERS = data.linkedOwners || [];

      // 2a. Self-process queued partner_link docs (cross-user-safe path)
      // Single-field query (partnerUid only) — avoids needing a composite index.
      // Filter `type === 'partner_link'` in code.
      try {
        const linkRes = await fs.collection('app_data')
          .where('partnerUid', '==', user.uid)
          .get();

        const linkDocs = linkRes.docs.filter(d => d.data().type === 'partner_link');
        cachePartnerLinks(linkDocs.map(d => {
          const data = d.data();
          return {
            id: d.id,
            ownerUid: data.ownerUid || null,
            factoryId: data.factoryId || null,
            partnerUid: data.partnerUid || null,
            sharePercent: data.sharePercent || 0
          };
        }), user.uid);
        if (linkDocs.length > 0) {
          console.log('[Auth] Found', linkDocs.length, 'pending partner_link docs');
          let linkAdded = false;
          for (const lDoc of linkDocs) {
            const ln = lDoc.data();
            if (ln.ownerUid && !CURRENT_LINKED_OWNERS.includes(ln.ownerUid)) {
              CURRENT_LINKED_OWNERS.push(ln.ownerUid);
              linkAdded = true;
            }
            // Also ensure the factory list contains me in partnerUids
            try {
              const fListDocId = `factories_list_${ln.ownerUid}`;
              const fListDoc = await fs.collection('app_data').doc(fListDocId).get();
              if (fListDoc.exists) {
                const list = fListDoc.data().data || [];
                let listUpdated = false;
                list.forEach(factory => {
                  if (!ln.factoryId || factory.id === ln.factoryId) {
                    factory.partnerUids = factory.partnerUids || [];
                    if (!factory.partnerUids.includes(user.uid)) {
                      factory.partnerUids.push(user.uid);
                      listUpdated = true;
                    }
                    if (ln.sharePercent) {
                      factory.partnerShares = factory.partnerShares || {};
                      factory.partnerShares[user.uid] = ln.sharePercent;
                      listUpdated = true;
                    }
                  }
                });
                if (listUpdated) {
                  await fs.collection('app_data').doc(fListDocId).update({ data: list });
                  console.log('[Auth] partner_link processed: factory list updated for owner', ln.ownerUid);
                }
              }
            } catch (fErr) {
              console.warn('[Auth] partner_link factory update failed:', fErr);
            }
            // Delete only if we are an owner (rules allow), else leave it (no harm — it's idempotent)
            try { await fs.collection('app_data').doc(lDoc.id).delete(); } catch(_) {}
          }
          if (linkAdded) {
            try { await userDocRef.update({ linkedOwners: CURRENT_LINKED_OWNERS }); }
            catch (e) { console.warn('[Auth] Could not persist linkedOwners (will retry next session):', e); }
          }
        }
      } catch (e) { console.error('[Auth] partner_link observer error:', e); }

      // 2b. Check for partner_invite (legacy + new-account path)
      try {
        const inviteRes = await fs.collection('app_data')
          .where('email', '==', userEmail)
          .get();

        const inviteDocs = inviteRes.docs.filter(d => d.data().type === 'partner_invite');

        if (inviteDocs.length > 0) {
          let hasNewLink = false;
          for (const invDoc of inviteDocs) {
            const inv = invDoc.data();
            if (!CURRENT_LINKED_OWNERS.includes(inv.ownerUid)) {
              CURRENT_LINKED_OWNERS.push(inv.ownerUid);
              hasNewLink = true;
            }
            
            // Link current UID to the owner's factory list (all factories of that owner)
            try {
              const fListDocId = `factories_list_${inv.ownerUid}`;
              const fListDoc = await fs.collection('app_data').doc(fListDocId).get();
              if (fListDoc.exists) {
                const list = fListDoc.data().data || [];
                let listUpdated = false;
                // If specific factoryId given, add to that factory only; else add to all
                list.forEach(factory => {
                  if (!inv.factoryId || factory.id === inv.factoryId) {
                    factory.partnerUids = factory.partnerUids || [];
                    if (!factory.partnerUids.includes(user.uid)) {
                      factory.partnerUids.push(user.uid);
                      listUpdated = true;
                    }
                    if (inv.sharePercent) {
                      factory.partnerShares = factory.partnerShares || {};
                      factory.partnerShares[user.uid] = inv.sharePercent;
                    }
                  }
                });
                
                // [FIX] Also attach the new UID to the settings.partners array
                if (inv.factoryId) {
                  try {
                    const sDocId = `${inv.factoryId}_settings`;
                    const sDoc = await fs.collection('app_data').doc(sDocId).get();
                    if (sDoc.exists) {
                      const sData = sDoc.data().data || {};
                      const partners = sData.partners || [];
                      let sUpdated = false;
                      partners.forEach(p => {
                        if (p.email && p.email.toLowerCase() === inv.email && !p.uid) {
                          p.uid = user.uid;
                          sUpdated = true;
                        }
                      });
                      if (sUpdated) {
                        await fs.collection('app_data').doc(sDocId).update({ data: sData });
                      }
                    }
                  } catch (e) {
                    console.warn('Could not inject partner uid into settings:', e);
                  }
                }

                if (listUpdated) {
                  await fs.collection('app_data').doc(fListDocId).update({ data: list });
                }
              }
            } catch (fErr) { console.error('Link list error:', fErr); }
            
            await fs.collection('app_data').doc(invDoc.id).delete();
          }
          if (hasNewLink) {
            await userDocRef.update({ linkedOwners: CURRENT_LINKED_OWNERS });
            console.log('[Auth] New partner links processed, linkedOwners updated:', CURRENT_LINKED_OWNERS);
            // Don't return — let code continue to apply UI and trigger initGlobalSync
          }
        }
      } catch (e) { console.error('Inv observer error:', e); }

      // 3. Set effective owner for data scoping
      // For owners acting as partners in other factories: EFFECTIVE_OWNER_UID = their own UID
      // (enterFactory will override it per-factory when needed)
      if ((CURRENT_ROLE === 'worker' || CURRENT_ROLE === 'partner') && data.ownerUid) {
        EFFECTIVE_OWNER_UID = data.ownerUid;
        WORKER_OWNER_UID = data.ownerUid;
      } else {
        EFFECTIVE_OWNER_UID = user.uid;
        WORKER_OWNER_UID = null;
      }

      applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
      hideAuthScreen();

      // 4. ALWAYS trigger global sync on first load or when linkedOwners changed
      const linkedChanged = oldLinkedStr !== JSON.stringify(CURRENT_LINKED_OWNERS);
      if (linkedChanged || IS_INITIAL_CLOUD_LOAD) {
        console.log('[Auth] Triggering global sync. linkedChanged:', linkedChanged, 'isInitial:', IS_INITIAL_CLOUD_LOAD);
        initGlobalSync();
      }

      // 5. Owners: silently repair any broken partner links in background
      if (CURRENT_ROLE === 'owner' && IS_INITIAL_CLOUD_LOAD) {
        setTimeout(() => repairPartnerLinks(), 3000);
      }
    });

    GLOBAL_SYNC_UNSUBS.push(unsub);
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

  let secondApp = null;
  try {
    // Delete any lingering instance first so state never carries over
    try { await firebase.app('workerCreation').delete(); } catch(_) {}
    secondApp = firebase.initializeApp(firebaseConfig, 'workerCreation');
    const secondAuth = secondApp.auth();

    const cred = await secondAuth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    const emailLc = (email || '').toLowerCase();
    const userDoc = { name, email: emailLc, emailLower: emailLc, role: 'worker', createdAt: new Date().toISOString(), migrationDone: true, ownerUid: CURRENT_USER.uid };
    await fs.collection('users').doc(cred.user.uid).set(userDoc);
    await secondAuth.signOut();

    document.getElementById('wa-name').value = '';
    document.getElementById('wa-email').value = '';
    document.getElementById('wa-password').value = '';

    okEl.textContent = `✅ تم إنشاء حساب العامل "${name}" بنجاح! يمكنه الآن تسجيل الدخول.`;
    addActivity(`تم إنشاء حساب للكاتب ${name}`, '✍️');
    showToast(`✅ حساب العامل ${name} جاهز`);
  } catch(e) {
    errEl.textContent = translateAuthError(e.code);
    errEl.classList.add('visible');
  } finally {
    if (secondApp) { try { await secondApp.delete(); } catch(_) {} }
    btn.disabled = false; btn.textContent = '➕ إنشاء حساب كاتب';
  }
}




/* ===================== FACTORY STATE ===================== */
let CURRENT_FACTORY = null; // { id, name, icon, color }
let FACTORY_SYNC_UNSUBS = [];
let GLOBAL_SYNC_UNSUB = null;
let IS_INITIAL_CLOUD_LOAD = true;
let INITIAL_CLOUD_SYNC_DONE = false;

// UID of the "owning" user — equals current user for owners, equals assigned owner for workers/partners
let EFFECTIVE_OWNER_UID = null;
let WORKER_OWNER_UID = null;  // owner UID for workers/partner-role users — persists across factory enter/exit

const CARD_COLORS = ['gold', 'blue', 'green', 'purple', 'teal', 'orange', 'red', 'pink'];

function getPartnerLinksCacheKey(uid = CURRENT_USER?.uid) {
  return `zohir_partner_links_${uid || 'default'}`;
}

function getCachedPartnerLinks(uid = CURRENT_USER?.uid) {
  try { return JSON.parse(localStorage.getItem(getPartnerLinksCacheKey(uid))) || []; }
  catch { return []; }
}

function cachePartnerLinks(links, uid = CURRENT_USER?.uid) {
  if (!uid) return;
  try { localStorage.setItem(getPartnerLinksCacheKey(uid), JSON.stringify(links || [])); }
  catch (_) {}
}

function hasDirectPartnerLink(ownerUid, factoryId, partnerUid = CURRENT_USER?.uid) {
  if (!ownerUid || !partnerUid) return false;
  return getCachedPartnerLinks(partnerUid).some(link =>
    link.ownerUid === ownerUid && (!link.factoryId || link.factoryId === factoryId)
  );
}

async function upsertPartnerInvite({ email, name, sharePercent, ownerUid, factoryId }) {
  const emailLc = (email || '').trim().toLowerCase();
  if (!emailLc || !ownerUid || !factoryId) return null;
  const inviteId = `invite_${emailLc.replace(/[^a-zA-Z0-9]/g, '_')}_${ownerUid}_${factoryId}`;
  await fs.collection('app_data').doc(inviteId).set({
    type: 'partner_invite',
    email: emailLc,
    name: name || '',
    sharePercent: Number(sharePercent) || 0,
    ownerUid,
    factoryId,
    timestamp: Date.now()
  });
  return inviteId;
}

/* ===================== FACTORY DB ===================== */
const FactoryDB = {
  // Per-owner local storage key
  get listKey() { return `zohir_factories_${EFFECTIVE_OWNER_UID || 'default'}`; },
  // Per-owner Firestore document
  get cloudDocId() { return `factories_list_${EFFECTIVE_OWNER_UID || 'default'}`; },

  getFactories() {
    try { return JSON.parse(localStorage.getItem(this.listKey)) || []; }
    catch { return []; }
  },

  saveFactories(list) {
    localStorage.setItem(this.listKey, JSON.stringify(list));
    try {
      fs.collection('app_data').doc(this.cloudDocId).set({
        data: list, lastUpdated: new Date().toISOString()
      });
    } catch (e) { console.error('Cloud factory list sync error:', e); }
  },

  addFactory(name, icon, color, type = 'layer') {
    const list = this.getFactories();
    const id = 'f_' + Date.now();
    // Carry existing partner UIDs into the new factory so they see it immediately
    const partnerUids = [...new Set(list.flatMap(f => f.partnerUids || []))];
    const factory = { id, name, icon, color, type, ownerUid: EFFECTIVE_OWNER_UID, createdAt: new Date().toISOString(), partnerUids };
    list.push(factory);
    this.saveFactories(list);
    return factory;
  },

  deleteFactory(id) {
    const oldList = this.getFactories();
    const deletedFactory = oldList.find(f => f.id === id);
    let list = oldList.filter(f => f.id !== id);
    this.saveFactories(list);
    getFactorySyncKeys(deletedFactory).forEach(k => {
      localStorage.removeItem(`zohir_${id}_${k}`);
    });
    try {
      const bch = fs.batch();
      getFactorySyncKeys(deletedFactory).forEach(k => {
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
function getFactorySyncKeys(factory = CURRENT_FACTORY) {
  const baseKeys = ['settings', 'workers', 'daily_logs', 'activities', 'credits', 'broiler_cycles', 'broiler_logs'];
  if (factory?.type !== 'broiler') return baseKeys;
  return [...new Set([...baseKeys, 'broiler_partners', 'broiler_partner_txs', 'broiler_settings', 'broiler_slaughter'])];
}

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
    fs.collection('app_data').doc(FactoryDB.cloudDocId).get({ source: 'server' })
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
  const keys = getFactorySyncKeys();
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

  const keys = getFactorySyncKeys();
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
          // Re-update UI permissions based on synced data (e.g. workers list)
          applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
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
  const fUnsub = fs.collection('app_data').doc(FactoryDB.cloudDocId).onSnapshot({ includeMetadataChanges: false }, doc => {
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

/**
 * Re-creates partner_link docs and updates linkedOwners for every partner in every factory.
 * Runs silently in background on owner login to repair broken/missing links.
 */
async function repairPartnerLinks() {
  if (!CURRENT_USER || CURRENT_ROLE !== 'owner') return;
  try {
    const factories = FactoryDB.getFactories();
    if (!factories.length) return;

    for (const factory of factories) {
      const partnerUids = factory.partnerUids || [];
      if (!partnerUids.length) continue;

      for (const partnerUid of partnerUids) {
        if (!partnerUid || partnerUid === CURRENT_USER.uid) continue;

        // Ensure partner_link doc exists (idempotent set)
        try {
          const linkDocId = `link_${partnerUid}_${CURRENT_USER.uid}_${factory.id}`;
          const sharePercent = (factory.partnerShares || {})[partnerUid] || 0;
          await fs.collection('app_data').doc(linkDocId).set({
            type: 'partner_link',
            partnerUid: partnerUid,
            ownerUid: CURRENT_USER.uid,
            factoryId: factory.id,
            sharePercent: sharePercent,
            timestamp: Date.now()
          }, { merge: true });
        } catch (e) {
          console.warn('[RepairLinks] Could not write partner_link for', partnerUid, ':', e?.message);
        }

        // Ensure factory ownerUid is set
        if (!factory.ownerUid) {
          factory.ownerUid = CURRENT_USER.uid;
        }

        // Fast-path: update partner's linkedOwners
        try {
          const partnerDoc = await fs.collection('users').doc(partnerUid).get();
          if (partnerDoc.exists) {
            const linked = partnerDoc.data().linkedOwners || [];
            if (!linked.includes(CURRENT_USER.uid)) {
              linked.push(CURRENT_USER.uid);
              await fs.collection('users').doc(partnerUid).update({ linkedOwners: linked });
              console.log('[RepairLinks] Fixed linkedOwners for partner', partnerUid);
            }
          }
        } catch (e) {
          // Rules may block cross-user write — partner_link doc is the fallback
          console.warn('[RepairLinks] linkedOwners update blocked (fallback ok):', e?.message);
        }
      }
    }

    // Save factories back if ownerUid was missing on any
    const needsSave = factories.some(f => !f.ownerUid);
    if (needsSave) {
      factories.forEach(f => { if (!f.ownerUid) f.ownerUid = CURRENT_USER.uid; });
      FactoryDB.saveFactories(factories);
    }
    console.log('[RepairLinks] Done.');
  } catch (e) {
    console.warn('[RepairLinks] Error:', e);
  }
}

/* One-time migration: copy old global factories_list → per-owner doc (original owner only) */
async function migrateFactoriesIfNeeded() {
  if (!EFFECTIVE_OWNER_UID || !CURRENT_USER) return;
  try {
    // Check if this account is already marked as migrated
    const userDoc = await fs.collection('users').doc(CURRENT_USER.uid).get({ source: 'server' });
    if (userDoc.exists && userDoc.data().migrationDone) return;

    // Only migrate if the per-owner doc has no data yet
    const myDoc = await fs.collection('app_data').doc(FactoryDB.cloudDocId).get({ source: 'server' });
    const alreadyHasData = myDoc.exists && Array.isArray(myDoc.data()?.data) && myDoc.data().data.length > 0;
    if (!alreadyHasData) {
      // Copy from old global doc (original pre-multi-tenant data)
      const oldDoc = await fs.collection('app_data').doc('factories_list').get({ source: 'server' });
      if (oldDoc.exists && Array.isArray(oldDoc.data()?.data) && oldDoc.data().data.length > 0) {
        const oldList = oldDoc.data().data;
        await fs.collection('app_data').doc(FactoryDB.cloudDocId).set({
          data: oldList, lastUpdated: new Date().toISOString()
        });
        localStorage.setItem(FactoryDB.listKey, JSON.stringify(oldList));
        console.log('[Migration] Factories moved to per-owner doc:', FactoryDB.cloudDocId);
      }
    }

    // Mark migration done so it never runs again for this user
    await fs.collection('users').doc(CURRENT_USER.uid).update({ migrationDone: true });
  } catch (e) {
    console.warn('[Migration] Could not migrate factories:', e);
  }
}



let GLOBAL_SYNC_UNSUBS = [];
function stopGlobalSync() {
  GLOBAL_SYNC_UNSUBS.forEach(unsub => { try { unsub(); } catch(e){} });
  GLOBAL_SYNC_UNSUBS = [];
}

/* Account-level collections: they belong to the user, not to a factory, and
   are therefore never covered by initCloudSync(). */
const GLOBAL_LEDGER_COLLS = [
  'supplier_list', 'supplier_tx', 'supplier_invoices',
  'worker_types', 'worker_months', 'worker_draws',
  'plaka_suppliers', 'plaka_locations', 'plaka_tx',
  'vet_accounts', 'vet_tx',
  'raha_accounts', 'raha_tx'
];

function refreshGlobalLedgerUI() {
  const vis = id => {
    const el = document.getElementById(id);
    return el && el.style.display && el.style.display !== 'none';
  };
  try { if (vis('global-credits-popup') && typeof renderSuppliersList === 'function') renderSuppliersList(); } catch (e) {}
  try { if (vis('global-workers-panel') && typeof renderWorkerTypes === 'function') renderWorkerTypes(); } catch (e) {}
  try { if (vis('plaka-panel') && typeof renderPlakaPanel === 'function') renderPlakaPanel(); } catch (e) {}
  try { if (vis('vet-panel') && typeof renderVetPanel === 'function') renderVetPanel(); } catch (e) {}
  try { if (vis('raha-panel') && typeof renderRahaPanel === 'function') renderRahaPanel(); } catch (e) {}
}

/* Anything saved before signing in lands under the "default" uid. Adopt it
   once, so work done while logged out is not stranded. */
function adoptAnonymousLedgers(uid) {
  if (!uid || uid === 'default') return;
  GLOBAL_LEDGER_COLLS.forEach(coll => {
    try {
      const anonKey = `zohir_${coll}_default`;
      const ownKey = `zohir_${coll}_${uid}`;
      const anon = JSON.parse(localStorage.getItem(anonKey) || '[]');
      const own = JSON.parse(localStorage.getItem(ownKey) || '[]');
      if (anon.length && !own.length) {
        localStorage.setItem(ownKey, JSON.stringify(anon));
        localStorage.removeItem(anonKey);
        fs.collection('app_data').doc(`${coll}_${uid}`)
          .set({ data: anon, lastUpdated: new Date().toISOString() })
          .catch(() => {});
        console.log('[ledgers] adopted', anon.length, 'rows of', coll, 'from the signed-out session');
      }
    } catch (e) {}
  });
}

function syncGlobalLedgers(ownerUids) {
  if (!CURRENT_USER) return;
  adoptAnonymousLedgers(CURRENT_USER.uid);

  const uids = [...new Set(ownerUids && ownerUids.length ? ownerUids : [CURRENT_USER.uid])];

  uids.forEach(uid => {
    GLOBAL_LEDGER_COLLS.forEach(coll => {
      const docId = `${coll}_${uid}`;
      const lsKey = `zohir_${coll}_${uid}`;
      const ref = fs.collection('app_data').doc(docId);

      // pull whatever the account already has on the server
      fetchDocResilient(ref)
        .then(doc => {
          if (doc.exists) {
            const cloud = doc.data().data || [];
            if (localStorage.getItem(lsKey) !== JSON.stringify(cloud)) {
              localStorage.setItem(lsKey, JSON.stringify(cloud));
              refreshGlobalLedgerUI();
            }
          } else {
            // first run on the cloud: push whatever this device holds
            const local = JSON.parse(localStorage.getItem(lsKey) || '[]');
            if (local.length) {
              ref.set({ data: local, lastUpdated: new Date().toISOString() }).catch(() => {});
            }
          }
        })
        .catch(e => console.warn('[ledgers] initial fetch failed for', coll, e && e.code));

      // keep it live across devices
      const unsub = ref.onSnapshot({ includeMetadataChanges: false }, doc => {
        if (!doc.exists) return;
        const cloud = doc.data().data || [];
        if (localStorage.getItem(lsKey) !== JSON.stringify(cloud)) {
          localStorage.setItem(lsKey, JSON.stringify(cloud));
          refreshGlobalLedgerUI();
        }
      }, () => {});
      GLOBAL_SYNC_UNSUBS.push(unsub);
    });
  });
}

/* Server-first, but never blocking: after FIRESTORE_FETCH_MS fall back to
   the local cache so a slow phone still gets a usable screen. */
const FIRESTORE_FETCH_MS = 5000;
function fetchDocResilient(ref) {
  const server = ref.get({ source: 'server' });
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), FIRESTORE_FETCH_MS));
  return Promise.race([server.catch(() => null), timeout]).then(doc => {
    if (doc) return doc;
    console.warn('[sync] server fetch slow/failed for', ref.id, '— using cache');
    return ref.get().catch(() => ({ exists: false, data: () => ({}) }));
  });
}

async function initGlobalSync() {
  if (!CURRENT_USER) return;
  stopGlobalSync();

  // Owners to sync: self + anyone who added me as a partner
  // Also include WORKER_OWNER_UID for workers/partner-role users so their employer's factory list is fetched
  const ownersSet = new Set([CURRENT_USER.uid, ...CURRENT_LINKED_OWNERS]);
  if (WORKER_OWNER_UID && WORKER_OWNER_UID !== CURRENT_USER.uid) {
    ownersSet.add(WORKER_OWNER_UID);
  }
  const ownersToSync = [...ownersSet];
  
  IS_INITIAL_CLOUD_LOAD = true;
  let loadedCount = 0;

  ownersToSync.forEach(uid => {
    const docId = `factories_list_${uid}`;
    
    // STEP 1: Direct fetch for initial load.
    // {source:'server'} needs the network; on flaky mobile data it can hang
    // long enough that the UI never appears. Race it, and fall back to the
    // cached copy so the app still opens offline.
    fetchDocResilient(fs.collection('app_data').doc(docId))
      .then(doc => {
        loadedCount++;
        if (doc.exists) {
          const cloudList = doc.data().data || [];
          localStorage.setItem(`zohir_factories_${uid}`, JSON.stringify(cloudList));
        }
        if (loadedCount >= ownersToSync.length) {
          IS_INITIAL_CLOUD_LOAD = false;
          INITIAL_CLOUD_SYNC_DONE = true;
          hideGlobalLoader();
          if (!CURRENT_FACTORY) {
            renderFactoryScreen();
            checkAutoEnter();
          }
        }
      })
      .catch(() => {
        loadedCount++;
        if (loadedCount >= ownersToSync.length) {
          IS_INITIAL_CLOUD_LOAD = false;
          hideGlobalLoader();
        }
      });

    // STEP 2: Snapshot listener for real-time changes
    const unsub = fs.collection('app_data').doc(docId)
      .onSnapshot({ includeMetadataChanges: false }, doc => {
        if (doc.exists) {
          const cloudList = doc.data().data || [];
          localStorage.setItem(`zohir_factories_${uid}`, JSON.stringify(cloudList));
          if (!CURRENT_FACTORY) renderFactoryScreen();
        }
      }, () => {});
    GLOBAL_SYNC_UNSUBS.push(unsub);
  });

  // STEP 2b: the account-level ledgers (suppliers, workers, بلاكة) live outside
  // any factory, so initCloudSync() never touches them. Without this they only
  // ever existed in localStorage — invisible on another origin or device.
  syncGlobalLedgers(ownersToSync);

  // STEP 3: Live listener on partner_link queue — picks up brand-new partnerships
  // added by an owner while this partner is currently online. When triggered, we
  // self-process the link (add ownerUid to linkedOwners + ensure factory list contains us)
  // and re-run initGlobalSync so the factory appears immediately.
  // Single-field where() avoids needing a composite Firestore index — filter type in code.
  try {
    const linkUnsub = fs.collection('app_data')
      .where('partnerUid', '==', CURRENT_USER.uid)
      .onSnapshot(async (snap) => {
        cachePartnerLinks(
          snap.docs
            .filter(d => d.data().type === 'partner_link')
            .map(d => {
              const data = d.data();
              return {
                id: d.id,
                ownerUid: data.ownerUid || null,
                factoryId: data.factoryId || null,
                partnerUid: data.partnerUid || null,
                sharePercent: data.sharePercent || 0
              };
            })
        );
        if (snap.empty) return;
        let needsResync = false;
        for (const lDoc of snap.docs) {
          const ln = lDoc.data();
          if (ln.type !== 'partner_link') continue;
          if (ln.ownerUid && !CURRENT_LINKED_OWNERS.includes(ln.ownerUid)) {
            CURRENT_LINKED_OWNERS.push(ln.ownerUid);
            needsResync = true;
          }
          // Make sure factory list contains us in partnerUids
          try {
            const fListDocId = `factories_list_${ln.ownerUid}`;
            const fListDoc = await fs.collection('app_data').doc(fListDocId).get();
            if (fListDoc.exists) {
              const list = fListDoc.data().data || [];
              let listUpdated = false;
              list.forEach(factory => {
                if (!ln.factoryId || factory.id === ln.factoryId) {
                  factory.partnerUids = factory.partnerUids || [];
                  if (!factory.partnerUids.includes(CURRENT_USER.uid)) {
                    factory.partnerUids.push(CURRENT_USER.uid);
                    listUpdated = true;
                  }
                  if (ln.sharePercent) {
                    factory.partnerShares = factory.partnerShares || {};
                    factory.partnerShares[CURRENT_USER.uid] = ln.sharePercent;
                    listUpdated = true;
                  }
                }
              });
              if (listUpdated) {
                await fs.collection('app_data').doc(fListDocId).update({ data: list });
                needsResync = true;
              }
            }
          } catch (e) { console.warn('[LiveLink] factory update failed:', e); }
        }
        if (needsResync) {
          // Persist linkedOwners and re-run sync so new factory appears
          try {
            await fs.collection('users').doc(CURRENT_USER.uid).update({ linkedOwners: CURRENT_LINKED_OWNERS });
          } catch (e) { console.warn('[LiveLink] Could not persist linkedOwners:', e); }
          showToast('🤝 تمت إضافتك كشريك في مصنع جديد', 'info');
          initGlobalSync();
        }
      }, (err) => console.warn('[LiveLink] listener error:', err));
    GLOBAL_SYNC_UNSUBS.push(linkUnsub);
  } catch (e) {
    console.warn('[LiveLink] could not subscribe to partner_link queue:', e);
  }
}

function hideGlobalLoader() {
  clearTimeout(_loaderWatchdog);
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

let _loaderWatchdog = null;
const LOADER_MAX_MS = 8000;

function showGlobalLoader(msg) {
  const loader = document.getElementById('global-loader');
  const status = document.getElementById('loader-status');
  if (loader) {
    if (status && msg) status.textContent = msg;
    loader.style.display = 'flex';
    loader.classList.remove('hidden');
  }
  // Never let the overlay outlive its welcome — on a phone a hanging
  // Firestore request used to leave it up permanently.
  clearTimeout(_loaderWatchdog);
  _loaderWatchdog = setTimeout(() => {
    console.warn('[loader] watchdog fired after ' + LOADER_MAX_MS + 'ms — forcing the UI to show');
    hideGlobalLoader();
    revealBestScreen();
  }, LOADER_MAX_MS);
}

/* Whatever went wrong, put SOMETHING usable on screen. */
function revealBestScreen() {
  const auth = document.getElementById('auth-screen');
  const factory = document.getElementById('factory-screen');
  const app = document.getElementById('app-wrapper');
  const shown = el => el && getComputedStyle(el).display !== 'none';
  if (shown(app) || shown(factory) || shown(auth)) return;
  if (CURRENT_USER) {
    if (factory) factory.style.display = 'flex';
    if (typeof renderFactoryScreen === 'function') { try { renderFactoryScreen(); } catch (e) {} }
  } else if (auth) {
    auth.style.display = 'flex';
  }
}

function checkAutoEnter() {
  const ownFactories = (() => {
    try { return JSON.parse(localStorage.getItem(`zohir_factories_${CURRENT_USER?.uid}`)) || []; }
    catch { return []; }
  })();
  const accessibleFactories = [...ownFactories];
  const seenIds = new Set(accessibleFactories.map(f => f.id));
  const linkedOwnerUids = [...new Set([...(CURRENT_LINKED_OWNERS || []), WORKER_OWNER_UID].filter(Boolean))];

  linkedOwnerUids.forEach(uid => {
    if (uid === CURRENT_USER?.uid) return;
    try {
      const list = JSON.parse(localStorage.getItem(`zohir_factories_${uid}`)) || [];
      list.forEach(factory => {
        const isSharedWithMe =
          (factory.partnerUids || []).includes(CURRENT_USER?.uid) ||
          uid === WORKER_OWNER_UID ||
          hasDirectPartnerLink(uid, factory.id);
        const isNotMine = (factory.ownerUid || uid) !== CURRENT_USER?.uid;
        if (!seenIds.has(factory.id) && isNotMine && isSharedWithMe) {
          seenIds.add(factory.id);
          accessibleFactories.push(factory);
        }
      });
    } catch (_) {}
  });

  const factories = accessibleFactories;
  if (factories.length === 1 && !CURRENT_FACTORY) {
    enterFactory(factories[0]);
  } else if (factories.length === 0 && !CURRENT_FACTORY) {
    // Only owners can create factories; workers/partners wait for owner to set up
    if (CURRENT_ROLE === 'owner') {
      setTimeout(() => openAddFactoryModal(), 500);
    }
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
  if (CURRENT_FACTORY?.type === 'broiler') {
    keys.push(
      [`zohir_${fid}_broiler_cycles`, JSON.stringify([])],
      [`zohir_${fid}_broiler_logs`, JSON.stringify([])],
      [`zohir_${fid}_broiler_partners`, JSON.stringify([])],
      [`zohir_${fid}_broiler_partner_txs`, JSON.stringify([])],
      [`zohir_${fid}_broiler_settings`, JSON.stringify({})],
      [`zohir_${fid}_broiler_slaughter`, JSON.stringify([])]
    );
  }
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
    
    
    feedAlertThreshold: 100,
    brokenAlertPct: 5,
    // حساب الفائدة في صفحة التقارير
    eggSalePrice: 0,        // سعر بيع البلاكة الواحدة (دج)
    barleyPricePerKg: 0,    // سعر شراء الشعير للكيلوغرام (دج/كغ)
    chickenPrice: 0,        // سعر شراء الدجاجة الابتدائي (دج)
    reformeActive: false,   // المصنع أُغلق وبيعت الدجاجات المتبقية
    reformeChickenPrice: 0, // سعر بيع الدجاجة الواحدة في الروفورم (دج)
    reformeDate: null,
    deletePassword: '1234',
    loyer: 0,
    electricity: 0,
    repairLoyer: 0,
    repairTotal: 0,
    ownerShare: 100,
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

  const nameInput = document.getElementById('wa-name');
  const existingPartnerSelect = document.getElementById('wa-partner-select');
  if (existingPartnerSelect) existingPartnerSelect.remove();
  if (nameInput) nameInput.value = '';
  _devPasswordVerified = false;

  if (select.value === 'partner') {
    const settings = DB.get('settings') || defaultSettings();
    const partners = settings.partners || [];

    if (partners.length === 0) {
      select.value = 'worker';
      showToast('⚠️ لا يوجد شركاء مضافون — أضف شريكاً أولاً من الإعدادات → إدارة الشركاء', 'error');
      return;
    }

    const sel = document.createElement('select');
    sel.id = 'wa-partner-select';
    sel.style.cssText = 'flex:1;min-width:140px;background:var(--bg-dark);border:1px solid var(--gold);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text-primary);font-family:\'Cairo\',sans-serif;';
    sel.innerHTML = '<option value="">— اختر الشريك —</option>' +
      partners.map(p => `<option value="${p.name}">${p.name} (${p.sharePercent}%)</option>`).join('');

    sel.addEventListener('change', () => {
      if (nameInput && sel.value) nameInput.value = sel.value;
    });

    if (nameInput && nameInput.parentNode) {
      nameInput.parentNode.insertBefore(sel, nameInput);
    }
    showDevPasswordModal();

  } else if (select.value === 'owner') {
    // Creating a new independent business owner — requires DEV password
    showDevPasswordModal();
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

async function confirmDevPassword() {
  const input = document.getElementById('dev-password-input');
  const errEl = document.getElementById('dev-password-error');
  if (!input) return;

  const hashedInput = await hashString(input.value);

  if (hashedInput === DEV_SECRET_HASH) {
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
function dateKeyLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseDateKey(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
}
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = parseDateKey(dateStr);
  return d.toLocaleDateString('ar-DZ', { year: 'numeric', month: 'short', day: 'numeric' });
}
function todayStr() {
  return dateKeyLocal(new Date());
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
    .filter(l => { const d = parseDateKey(l.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
    .reduce((s, l) => s + (Number(l.dead) || 0), 0);
}
function getTotalBrokenLossThisMonth() {
  const logs = DB.get('daily_logs') || [];
  const now = new Date();
  return logs
    .filter(l => { const d = parseDateKey(l.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
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

  // One-time initial costs. The price fields were dropped from the settings
  // form (prices now live in دفعات الشراء), so these read 0 on new factories
  // while still honouring the values older factories already saved.
  const chickensCost = (Number(settings.initialChickens) || 0) * (Number(settings.chickenPrice) || 0);
  const feedCost     = (Number(settings.initialFeed) || 0) * (Number(settings.feedPrice) || 0);

  const loyer        = Number(settings.loyer)        || 0;
  const repairLoyer  = Number(settings.repairLoyer)  || 0;
  const repairTotal  = Number(settings.repairTotal)  || 0;
  const effectiveLoyer = Math.max(0, loyer - repairLoyer);

  // Monthly electricity
  const electricity = Number(settings.electricity) || 0;
  let monthsDiff = 1;
  if (logs.length > 0) {
    const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = parseDateKey(sorted[0].date);
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

function getExpectedMonthlyProfit() {
  const logs = DB.get('daily_logs') || [];
  const settings = DB.get('settings') || defaultSettings();
  if (!logs.length) return 0;
  
  const totalDailyProfit = logs.reduce((s, l) => s + (Number(l.baseProfit ?? l.profit) || 0), 0);
  const avgDailyProfit = totalDailyProfit / logs.length;
  const expectedMonthlyBase = avgDailyProfit * 30;
  
  const loyer = Number(settings.loyer) || 0;
  const repairLoyer = Number(settings.repairLoyer) || 0;
  const effectiveLoyer = Math.max(0, loyer - repairLoyer);
  const electricity = Number(settings.electricity) || 0;
  
  return expectedMonthlyBase - effectiveLoyer - electricity;
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
    settings: loadSettingsForm,
    cycles: renderCyclesPage,
    'broiler-sales': renderBroilerSalesPage,
    'broiler-reports': renderBroilerReportsPage,
    'broiler-workers': renderBroilerWorkersPage,
  };
  if (refreshers[pageId]) {
    try {
      refreshers[pageId]();
    } catch (err) {
      console.error(`[Page:${pageId}] render failed`, err);
      showToast(`تعذر فتح الصفحة: ${err.message || 'خطأ غير معروف'}`, 'error');
    }
  }
}

/* ===================== FACTORY SELECTION SCREEN ===================== */
function renderFactoryScreen() {
  const myGrid    = document.getElementById('factory-cards-grid');
  const sharedGrid = document.getElementById('shared-factory-cards-grid');
  const sharedSection = document.getElementById('section-shared-factories');
  const myHeader  = document.getElementById('my-factories-header');
  myGrid.innerHTML = '';
  if (sharedGrid) sharedGrid.innerHTML = '';

  // Read lists directly from each owner's cache so the screen never depends on
  // whichever owner namespace happened to be active before opening it.
  const readFactoriesForOwner = (uid) => {
    if (!uid) return [];
    try { return JSON.parse(localStorage.getItem(`zohir_factories_${uid}`)) || []; }
    catch { return []; }
  };

  // ── مصانعي (المملوكة لي) ──
  const allMyFactories = readFactoriesForOwner(CURRENT_USER?.uid).filter(f =>
    !f.ownerUid || f.ownerUid === CURRENT_USER?.uid
  );
  const activeGroup = window._factoryGroupViewId
    ? allMyFactories.find(f => f.id === window._factoryGroupViewId && f.isGroup)
    : null;
  const myFactories = activeGroup
    ? allMyFactories.filter(f => f.parentId === activeGroup.id)
    : allMyFactories.filter(f => !f.parentId);

  // ── المصانع المشاركة (من ملاك آخرين) ──
  // فقط المصانع التي:
  // 1. المالك الحقيقي ≠ أنا
  // 2. أنا في قائمة partnerUids
  const seenIds = new Set(myFactories.map(f => f.id));
  const sharedFactories = [];
  const linkedOwnerUids = [...new Set([...(CURRENT_LINKED_OWNERS || []), WORKER_OWNER_UID].filter(Boolean))];
  linkedOwnerUids.forEach(uid => {
    if (uid === CURRENT_USER?.uid) return;
    try {
      const list = readFactoriesForOwner(uid);
      list.forEach(f => {
        const isSharedWithMe =
          (f.partnerUids || []).includes(CURRENT_USER?.uid) ||
          uid === WORKER_OWNER_UID ||
          hasDirectPartnerLink(uid, f.id);
        const trueOwnerUid = f.ownerUid || uid;
        const isNotMine = trueOwnerUid !== CURRENT_USER?.uid;
        if (!seenIds.has(f.id) && isNotMine && isSharedWithMe) {
          if (!f.ownerUid) f.ownerUid = uid;
          seenIds.add(f.id);
          sharedFactories.push(f);
        }
      });
    } catch (e) { console.warn('Error loading shared factories for', uid, e); }
  });

  // حالة التحميل أو الفراغ لقسم مصانعي
  if (!myFactories.length) {
    myGrid.innerHTML = IS_INITIAL_CLOUD_LOAD
      ? `<div style="width:100%;text-align:center;padding:80px 0;color:var(--text-muted)">
           <div class="loader" style="margin:0 auto 20px"></div>
           <p style="font-size:1rem;animation:pulse 1.5s infinite">جاري البحث عن مصانعك...</p>
         </div>`
      : `<div style="width:100%;text-align:center;padding:60px 0;color:var(--text-muted)">
           <div style="font-size:3rem;margin-bottom:14px;filter:grayscale(1);opacity:0.4">🏭</div>
           <p style="font-size:1rem;color:var(--text-primary)">لا توجد مصانع خاصة بك</p>
           <p style="font-size:0.85rem;margin-top:6px">اضغط "إضافة مصنع جديد" للبدء</p>
         </div>`;
  }

  // عنوان "مصانعي" يظهر دائماً
  if (myHeader) {
    myHeader.style.display = '';
    myHeader.innerHTML = activeGroup
      ? `<button type="button" id="btn-back-factory-group" class="btn btn-outline" style="margin-inline-end:12px;padding:6px 14px">← رجوع</button><span>📁 ${activeGroup.name}</span>`
      : '<span>🏭 مصانعي</span>';
    myHeader.querySelector('#btn-back-factory-group')?.addEventListener('click', () => {
      window._factoryGroupViewId = null;
      renderFactoryScreen();
    });
  }

  // رسم بطاقات مصانعي
  myFactories.forEach((factory, idx) => buildFactoryCard(factory, idx, true, myGrid));

  // قسم المصانع المشاركة — يظهر دائماً
  if (sharedSection) {
    sharedSection.style.display = '';
    if (sharedFactories.length) {
      sharedFactories.forEach((factory, idx) => buildFactoryCard(factory, idx, false, sharedGrid));
    } else {
      sharedGrid.innerHTML = IS_INITIAL_CLOUD_LOAD
        ? `<div class="shared-factories-empty">
             <div class="loader" style="margin:0 auto 12px;width:28px;height:28px"></div>
             <p>جاري البحث...</p>
           </div>`
        : `<div class="shared-factories-empty">
             <div style="font-size:2.2rem;margin-bottom:10px;opacity:0.4">🤝</div>
             <p>لا توجد مصانع مشاركة معك حالياً</p>
             <p style="font-size:0.82rem;margin-top:6px;color:var(--text-muted)">اطلب من المالك مشاركة المصنع معك، ثم اضغط "تحديث"</p>
           </div>`;
    }
  }
  // Cards appear in place; the previous orbit/rotation intro is disabled.
}

function playFactoryOrbitIntro(grids) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const now = Date.now();
  if (now - _factoryOrbitIntroLastAt < 5200) return;

  const liveGrids = (grids || []).filter(Boolean);
  if (!liveGrids.length) return;

  let played = false;
  liveGrids.forEach(grid => {
    const cards = [...grid.querySelectorAll('.factory-card')];
    if (!cards.length) return;
    played = true;

    const gridRect = grid.getBoundingClientRect();
    const centerX = gridRect.left + gridRect.width / 2;
    const firstRect = cards[0].getBoundingClientRect();
    const centerY = firstRect.top + firstRect.height / 2;
    const radius = Math.min(
      Math.max(72, cards.length * 24),
      Math.max(88, Math.min(window.innerWidth, 420) * 0.34)
    );
    const duration = 7600;
    const orbitEnd = 0.92;
    const count = cards.length;

    cards.forEach((card, idx) => {
      card.getAnimations().forEach(anim => {
        if (anim.effect?.target === card) anim.cancel();
      });
      card.classList.add('is-orbiting');
      card.classList.remove('orbit-settled');
      card.style.animation = 'none';
      card.style.opacity = '1';

      const rect = card.getBoundingClientRect();
      const finalX = rect.left + rect.width / 2;
      const finalY = rect.top + rect.height / 2;
      const baseAngle = (idx / count) * Math.PI * 2 - Math.PI / 2;
      const orbitAt = (turns, bob = 0) => {
        const angle = baseAngle + turns * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius + bob;
        return `translate(${(x - finalX).toFixed(1)}px, ${(y - finalY).toFixed(1)}px) scale(0.92)`;
      };

      const animation = card.animate([
        { offset: 0, transform: orbitAt(0, 0), filter: 'saturate(1.1)' },
        { offset: 0.2, transform: orbitAt(0.3, -10), filter: 'saturate(1.25)' },
        { offset: 0.4, transform: orbitAt(0.65, 8), filter: 'saturate(1.18)' },
        { offset: 0.62, transform: orbitAt(1.0, -8), filter: 'saturate(1.28)' },
        { offset: orbitEnd, transform: orbitAt(1.35, 6), filter: 'saturate(1.15)' },
        { offset: 1, transform: 'translate(0, 0) scale(1)', filter: 'saturate(1)' }
      ], {
        duration,
        easing: 'cubic-bezier(0.18, 0.68, 0.16, 1)',
        fill: 'both'
      });

      animation.finished
        .then(() => {
          card.classList.remove('is-orbiting');
          card.classList.add('orbit-settled');
          card.style.opacity = '';
          card.style.transform = '';
          card.style.filter = '';
          setTimeout(() => card.classList.remove('orbit-settled'), 450);
        })
        .catch(() => {
          card.classList.remove('is-orbiting');
          card.style.opacity = '';
          card.style.transform = '';
          card.style.filter = '';
        });
    });
  });

  if (played) _factoryOrbitIntroLastAt = now;
}

function buildFactoryCard(factory, idx, isPrimaryOwner, container) {
  const logs = (() => {
    try { return JSON.parse(localStorage.getItem(`zohir_${factory.id}_daily_logs`)) || []; }
    catch { return []; }
  })();
  const todayLog = logs.find(l => l.date === todayStr());
  const myShareRaw = (factory.partnerShares || {})[CURRENT_USER?.uid] || null;

  const card = document.createElement('div');
  card.className = 'factory-card';
  card.setAttribute('data-color', factory.color || 'gold');
  card.setAttribute('data-id', factory.id);
  card.style.animationDelay = `${idx * 0.07}s`;

  const canDelete = isPrimaryOwner && !isReadOnlyUser();

  const fType = factory.type || 'layer';
  const typeBadge = factory.isGroup
    ? `<span class="factory-type-badge factory-type-badge--layer">📁 مجموعة مصانع</span>`
    : fType === 'broiler'
    ? `<span class="factory-type-badge factory-type-badge--broiler">🍗 لحم</span>`
    : `<span class="factory-type-badge factory-type-badge--layer">🥚 بيض</span>`;

  card.innerHTML = `
    ${canDelete ? `<button class="factory-card-delete" data-id="${factory.id}" data-name="${factory.name.replace(/\"/g, '&quot;')}" onclick="window.confirmDeleteFactory(event, this.dataset.id, this.dataset.name)" title="حذف المصنع">✕</button>` : ''}
    ${typeBadge}
    <span class="factory-card-icon">${factory.icon || '🐔'}</span>
    <div class="factory-card-name">${factory.name}</div>
    <div class="factory-card-meta">${isPrimaryOwner ? '👔 تملك هذا المصنع' : `🤝 شريك${myShareRaw ? ' — حصتك ' + myShareRaw + '%' : ''}`}</div>
    
  `;

  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('factory-card-delete') || e.target.closest('.factory-card-delete')) return;

    if (factory.isGroup) {
      window._factoryGroupViewId = factory.id;
      renderFactoryScreen();
      return;
    }

    const screen = document.getElementById('factory-screen');
    card.classList.add('factory-card-active');
    screen?.classList.add('is-transitioning');

    playShatterEffect(card, factory.color || 'gold', () => {
      screen?.classList.remove('is-transitioning');
      card.classList.remove('factory-card-active');
      const appWrapper = document.getElementById('app-wrapper');
      appWrapper?.classList.add('entering-dashboard');
      setTimeout(() => appWrapper?.classList.remove('entering-dashboard'), 520);
      enterFactory(factory, null);
    });
  });

  // Neighbor ripple: pulse adjacent cards when this one is hovered
  card.addEventListener('mouseenter', () => {
    const grid = card.parentElement;
    if (!grid) return;
    const siblings = [...grid.children].filter(el => el.classList.contains('factory-card'));
    const myIdx = siblings.indexOf(card);
    siblings.forEach((sibling, i) => {
      if (sibling === card) return;
      const dist = Math.abs(i - myIdx);
      if (dist <= 2) {
        sibling.classList.remove('is-neighbor');
        void sibling.offsetWidth;
        sibling.classList.add('is-neighbor');
      }
    });
  });

  card.addEventListener('mouseleave', () => {
    const grid = card.parentElement;
    if (!grid) return;
    grid.querySelectorAll('.factory-card.is-neighbor').forEach(s => s.classList.remove('is-neighbor'));
  });

  const delBtn = card.querySelector('.factory-card-delete');
  if (delBtn) {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fname = factory.name;
      if (!confirm('هل تريد حذف مصنع "' + fname + '"؟')) return;
      if (!confirm('تأكيد نهائي: سيتم حذف جميع بيانات "' + fname + '" من السحابة بشكل دائم. متأكد؟')) return;
      stopGlobalSync();
      FactoryDB.deleteFactory(factory.id);
      renderFactoryScreen();
      showToast('✅ تم حذف المصنع نهائياً', 'warning');
      setTimeout(() => initGlobalSync(), 800);
    });
  }

  container.appendChild(card);
}
function ensureFactoryEntryBurst() {
  let burst = document.getElementById('factory-entry-burst');
  if (burst) return burst;

  burst = document.createElement('div');
  burst.id = 'factory-entry-burst';
  burst.className = 'factory-entry-burst';
  burst.innerHTML = `
    <div class="factory-entry-burst-ring">
      <div class="factory-entry-burst-core">
        <span class="factory-entry-burst-icon"></span>
      </div>
    </div>
  `;
  document.body.appendChild(burst);
  return burst;
}

function playShatterEffect(sourceCard, color, onDone) {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const icon = sourceCard.querySelector('.factory-card-icon');
  if (reduceMotion || !icon) { onDone(); return; }

  const colorMap = {
    gold:   ['#f5c518','#f0a500'], blue:   ['#63b3ed','#2b6cb0'],
    green:  ['#48bb78','#276749'], purple: ['#b794f4','#6b46c1'],
    red:    ['#fc8181','#c53030'], teal:   ['#4fd1c5','#285e61'],
    orange: ['#f6ad55','#c05621'], pink:   ['#f687b3','#97266d'],
  };
  const [colorA, colorB] = colorMap[color] || colorMap.gold;

  const rect = icon.getBoundingClientRect();
  const N = 10;
  const r = rect.width / 2;
  const shards = [];

  // Phase 1: crack flash on the icon itself
  icon.style.animation = 'iconCrackFlash 0.18s cubic-bezier(0.4,0,1,1) forwards';

  setTimeout(() => {
    // Phase 2: hide icon, spawn shards
    icon.style.opacity = '0';

    for (let i = 0; i < N; i++) {
      const angleStart = (i / N) * Math.PI * 2 - Math.PI / 2;
      const angleEnd   = ((i + 1) / N) * Math.PI * 2 - Math.PI / 2;
      const midAngle   = (angleStart + angleEnd) / 2 + (Math.random() - 0.5) * 0.35;

      const flyDist = r * (1.4 + Math.random() * 1.6);
      const flyX    = Math.cos(midAngle) * flyDist;
      const flyY    = Math.sin(midAngle) * flyDist;
      const rot     = (Math.random() - 0.5) * 260;
      const delay   = Math.random() * 50;
      const dur     = 0.48 + Math.random() * 0.12;

      // Build wedge polygon with slight edge irregularity
      const pts = [];
      const steps = 5;
      for (let s = 0; s <= steps; s++) {
        const a = angleStart + (angleEnd - angleStart) * (s / steps);
        const v = 0.82 + Math.random() * 0.36;
        pts.push(`${50 + 50 * Math.cos(a) * v}% ${50 + 50 * Math.sin(a) * v}%`);
      }
      const clipPath = `polygon(50% 50%, ${pts.join(', ')})`;
      const grad = `linear-gradient(${midAngle.toFixed(2)}rad, ${colorA}, ${colorB})`;

      const shard = document.createElement('div');
      shard.className = 'factory-shard';
      shard.style.cssText = `
        left:${rect.left}px; top:${rect.top}px;
        width:${rect.width}px; height:${rect.height}px;
        background:${grad};
        clip-path:${clipPath};
        --fx:${flyX.toFixed(1)}px; --fy:${flyY.toFixed(1)}px;
        --fr:${rot.toFixed(1)}deg; --delay:${delay.toFixed(0)}ms; --dur:${dur.toFixed(2)}s;
        box-shadow:0 0 12px ${colorA}88;
      `;
      document.body.appendChild(shard);
      shards.push(shard);
    }

    setTimeout(() => {
      shards.forEach(s => s.remove());
      icon.style.opacity = '';
      icon.style.animation = '';
      onDone();
    }, 640);
  }, 140);
}

function playFactoryEntryTransition(factory, sourceCard, onDone) {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ring = sourceCard?.querySelector('.factory-card-icon');
  if (reduceMotion || !ring) {
    onDone();
    return;
  }

  const rect = ring.getBoundingClientRect();
  const burst = ensureFactoryEntryBurst();
  const iconEl = burst.querySelector('.factory-entry-burst-icon');
  const screen = document.getElementById('factory-screen');
  const centerX = rect.left + (rect.width / 2);
  const centerY = rect.top + (rect.height / 2);
  const targetX = (window.innerWidth / 2) - centerX;
  const targetY = (window.innerHeight / 2) - centerY;

  // Scale burst to fill entire viewport (diagonal = maximum distance)
  const diagonal = Math.hypot(window.innerWidth, window.innerHeight);
  const fillScale = (diagonal / rect.width) * 1.1;

  burst.className = 'factory-entry-burst';
  burst.setAttribute('data-color', factory.color || 'gold');
  burst.style.width = `${rect.width}px`;
  burst.style.height = `${rect.height}px`;
  burst.style.left = `${rect.left}px`;
  burst.style.top = `${rect.top}px`;
  burst.style.transform = 'translate3d(0, 0, 0) scale(0.94)';
  if (iconEl) iconEl.textContent = factory.icon || '🐔';

  // Trigger melt on the source icon
  ring.classList.add('is-melting');
  sourceCard.classList.add('factory-card-active');
  screen?.classList.add('is-transitioning');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      burst.classList.add('is-visible');
      burst.style.transform = `translate3d(${targetX}px, ${targetY}px, 0) scale(${fillScale})`;
    });
  });

  setTimeout(() => {
    burst.classList.add('is-fading');
    onDone();
    const appWrapper = document.getElementById('app-wrapper');
    appWrapper?.classList.add('entering-dashboard');
    setTimeout(() => appWrapper?.classList.remove('entering-dashboard'), 520);
  }, 380);

  setTimeout(() => {
    burst.className = 'factory-entry-burst';
    burst.style.transform = '';
    ring.classList.remove('is-melting');
    sourceCard.classList.remove('factory-card-active');
    screen?.classList.remove('is-transitioning');
  }, 860);
}

function enterFactoryLegacy(factory, sourceCard = null) {
  // The factory's true owner UID determines where data lives in Firestore
  const factoryOwnerUid = factory.ownerUid || CURRENT_USER?.uid;
  EFFECTIVE_OWNER_UID = factoryOwnerUid;
  CURRENT_FACTORY = factory;

  const isSharedFactory = factoryOwnerUid !== CURRENT_USER?.uid;

  // Show loader while switching data
  showGlobalLoader(`جاري تحميل بيانات "${factory.name}"...`);

  // Update sidebar UI
  document.getElementById('sidebar-factory-icon').textContent = factory.icon || '🐔';
  document.getElementById('sidebar-factory-name').textContent = factory.name;
  document.getElementById('sidebar-factory-sub').textContent = isSharedFactory ? '(شراكة)' : '';
  document.getElementById('topbar-factory-name').textContent = `deku — ${factory.name}${isSharedFactory ? ' (شراكة)' : ''}`;

  // Init local data safely (no cloud push)
  initFactoryData();

  // Re-evaluate read-only state now that factory/local data is loaded
  applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);

  // Render partner expense fields in daily form
  renderPartnerExpensesInForm();

  // Show app, hide selection screen
  document.getElementById('factory-screen').style.display = 'none';
  const appWrapper = document.getElementById('app-wrapper');
  appWrapper.style.display = 'flex';

  // Reset to dashboard
  showPage('dashboard');
  updateLiveDate();

  // Start sync — uses EFFECTIVE_OWNER_UID so data is fetched from factory owner's namespace
  initCloudSync();

  // Populate worker selects
  populateWorkerSelects();
}

function enterFactory(factory, sourceCard = null) {
  const factoryOwnerUid = factory.ownerUid || CURRENT_USER?.uid;
  EFFECTIVE_OWNER_UID = factoryOwnerUid;
  CURRENT_FACTORY = factory;

  const isSharedFactory = factoryOwnerUid !== CURRENT_USER?.uid;

  const continueEnter = () => {
    showGlobalLoader(`جاري تحميل بيانات "${factory.name}"...`);

    document.getElementById('sidebar-factory-icon').textContent = factory.icon || '🐔';
    document.getElementById('sidebar-factory-name').textContent = factory.name;
    const factoryType = factory.type || 'layer';
    const typeLabel = factoryType === 'broiler' ? '🍗 مصنع لحم' : '🥚 مصنع بيض';
    const sharingSuffix = isSharedFactory ? ' · شراكة' : '';
    document.getElementById('sidebar-factory-sub').textContent = typeLabel + sharingSuffix;
    document.getElementById('topbar-factory-name').textContent = `deku — ${factory.name}${isSharedFactory ? ' (شراكة)' : ''}`;

    applyFactoryTypeToUI(factoryType);

    initFactoryData();
    applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
    renderPartnerExpensesInForm();

    document.getElementById('factory-screen').style.display = 'none';
    const appWrapper = document.getElementById('app-wrapper');
    appWrapper.style.display = 'flex';

    // Land straight on the reports page — that is what the factory is opened for.
    showPage(factoryType === 'broiler' ? 'broiler-reports' : 'reports');
    updateLiveDate();
    initCloudSync();
    populateWorkerSelects();
  };

  playFactoryEntryTransition(factory, sourceCard, continueEnter);
}

function applyFactoryTypeToUI(type) {
  const isBroiler = type === 'broiler';

  // Dashboard: show/hide the correct content blocks
  const broilerPlaceholder = document.getElementById('broiler-dashboard-placeholder');
  const kpiGrid = document.getElementById('kpi-grid');
  const lastReportCard = document.getElementById('last-report-card');
  const activityFeedSection = document.querySelector('#page-dashboard .section-card:last-of-type');

  if (broilerPlaceholder) broilerPlaceholder.style.display = isBroiler ? '' : 'none';
  if (kpiGrid) kpiGrid.style.display = isBroiler ? 'none' : '';
  if (lastReportCard) lastReportCard.style.display = isBroiler ? 'none' : '';
  if (activityFeedSection) activityFeedSection.style.display = isBroiler ? 'none' : '';

  // Daily page: show broiler or layer form
  const broilerWrapper = document.getElementById('broiler-daily-wrapper');
  const layerWrapper = document.getElementById('layer-daily-wrapper');
  if (broilerWrapper) broilerWrapper.style.display = isBroiler ? '' : 'none';
  if (layerWrapper) layerWrapper.style.display = isBroiler ? 'none' : '';
  const dailySub = document.getElementById('daily-page-sub');
  if (dailySub) dailySub.textContent = isBroiler ? 'سجّل بيانات دورة اللحم اليومية' : 'سجّل بيانات يوم العمل';

  // Nav cycles, sales, reports: show for broiler, hide for layer
  const navCycles = document.getElementById('nav-cycles');
  const navSales = document.getElementById('nav-broiler-sales');
  const navReports = document.getElementById('nav-broiler-reports');
  if (navCycles) navCycles.style.display = isBroiler ? '' : 'none';
  if (navSales) navSales.style.display = isBroiler ? '' : 'none';
  if (navReports) navReports.style.display = isBroiler ? '' : 'none';

  // Nav sales/reports: for broiler, hide completely
  const comingSoonPages = ['sales', 'reports'];
  comingSoonPages.forEach(pageId => {
    const navBtn = document.getElementById(`nav-${pageId}`);
    if (!navBtn) return;
    if (isBroiler) {
      navBtn.style.display = 'none';
      navBtn.classList.add('nav-item--disabled');
    } else {
      navBtn.style.display = '';
      navBtn.classList.remove('nav-item--disabled');
      navBtn.removeAttribute('title');
    }
  });

  // AI Chat nav: always visible for all factory types
  const navAI = document.getElementById('nav-ai-chat');
  if (navAI) {
    navAI.style.display = '';
    navAI.classList.remove('nav-item--disabled');
  }

  // Dashboard header subtitle
  const dashSub = document.getElementById('dashboard-sub');
  if (dashSub) dashSub.textContent = isBroiler ? 'مصنع الدجاج اللاحم — دورات التربية' : 'نظرة عامة على المصنع';

  // P4: Nav broiler-workers
  const navBW = document.getElementById('nav-broiler-workers');
  if (navBW) navBW.style.display = isBroiler ? '' : 'none';

  // P4: Broiler settings card
  const bsc = document.getElementById('broiler-settings-card');
  if (bsc) bsc.style.display = isBroiler ? '' : 'none';
  if (bsc && isBroiler) {
    const layerOnlySettings = document.getElementById('layer-only-settings');
    const factoryInfoCard = layerOnlySettings?.closest('.form-card');
    const saveSettingsBtn = document.getElementById('btn-save-settings');
    if (factoryInfoCard && bsc.parentElement !== factoryInfoCard) {
      factoryInfoCard.insertBefore(bsc, saveSettingsBtn || null);
    } else if (factoryInfoCard && saveSettingsBtn && bsc.nextElementSibling !== saveSettingsBtn) {
      factoryInfoCard.insertBefore(bsc, saveSettingsBtn);
    }
  }

  // P4: Hide layer-only settings cards for broiler
  const psc = document.getElementById('partners-settings-card');
  if (psc) psc.style.display = isBroiler ? 'none' : '';

  // 🥚 إخفاء حقول مصنع البيض عند مصنع اللحم
  const layerOnlySettings = document.getElementById('layer-only-settings');
  if (layerOnlySettings) layerOnlySettings.style.display = isBroiler ? 'none' : '';

  // P4: Load broiler settings into form
  if (isBroiler && typeof loadBroilerSettings === 'function') loadBroilerSettings();

  // Hide layer-only nav items when broiler
  const navWorkers = document.getElementById('nav-workers');
  if (navWorkers) {
    if (isBroiler) {
      navWorkers.style.display = 'none';
      navWorkers.classList.add('nav-item--disabled');
    } else {
      navWorkers.style.display = '';
      navWorkers.classList.remove('nav-item--disabled');
      navWorkers.removeAttribute('title');
    }
  }
}

function exitToFactoryScreen() {
  stopFactorySync();
  CURRENT_FACTORY = null;
  // Restore the correct owner UID: workers/partners keep pointing to their employer's namespace
  EFFECTIVE_OWNER_UID = WORKER_OWNER_UID || CURRENT_USER?.uid;

  document.getElementById('app-wrapper').style.display = 'none';
  const screen = document.getElementById('factory-screen');
  screen.style.display = 'flex';

  // Render from cache immediately so the UI shows something fast
  renderFactoryScreen();

  // Then force a fresh sync so any newly-shared factories from partners show up.
  // Run async in background — don't block the UI. Error handling is inside the function.
  refreshFactoriesFromCloud({ silent: true }).catch(e => {
    console.error('[exitToFactoryScreen] Refresh failed (non-fatal):', e);
  });

  // Close mobile sidebar if open
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

/**
 * Force a re-sync of the factory list from cloud.
 * Simple & safe: fetch factories_list_<uid> for self + all linked owners, update localStorage, re-render.
 *
 * Triggered by the "🔄 تحديث" button or implicitly on factory screen entry.
 */
async function refreshFactoriesFromCloud({ silent = false } = {}) {
  if (!CURRENT_USER || !auth.currentUser) {
    console.warn('[Refresh] No current user');
    return;
  }

  const btn = document.getElementById('btn-refresh-factories');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري التحديث...'; }

  try {
    // STEP 1: Re-fetch the user doc from server to get latest linkedOwners
    try {
      const userDoc = await fs.collection('users').doc(CURRENT_USER.uid).get({ source: 'server' });
      if (userDoc.exists) {
        const freshLinked = userDoc.data().linkedOwners || [];
        CURRENT_LINKED_OWNERS = freshLinked;
        console.log('[Refresh] linkedOwners from cloud:', CURRENT_LINKED_OWNERS);
      }
    } catch (e) {
      console.warn('[Refresh] could not update linkedOwners:', e);
    }

    // STEP 2: Process any pending partner_link docs for this user (single-field query)
    try {
      const linkRes = await fs.collection('app_data')
        .where('partnerUid', '==', CURRENT_USER.uid)
        .get({ source: 'server' });

      const linkDocs = linkRes.docs.filter(d => d.data().type === 'partner_link');
      cachePartnerLinks(linkDocs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          ownerUid: data.ownerUid || null,
          factoryId: data.factoryId || null,
          partnerUid: data.partnerUid || null,
          sharePercent: data.sharePercent || 0
        };
      }));
      console.log('[Refresh] pending partner_link docs found:', linkDocs.length);

      let newLinked = false;
      for (const lDoc of linkDocs) {
        const ln = lDoc.data();
        if (ln.ownerUid && !CURRENT_LINKED_OWNERS.includes(ln.ownerUid)) {
          CURRENT_LINKED_OWNERS.push(ln.ownerUid);
          newLinked = true;
          console.log('[Refresh] new owner linked:', ln.ownerUid, 'factory:', ln.factoryId);
        }
        // Ensure partnerUids on the factory list
        try {
          const fListDoc = await fs.collection('app_data').doc(`factories_list_${ln.ownerUid}`).get({ source: 'server' });
          if (fListDoc.exists) {
            const list = fListDoc.data().data || [];
            let updated = false;
            list.forEach(factory => {
              if (!ln.factoryId || factory.id === ln.factoryId) {
                factory.partnerUids = factory.partnerUids || [];
                if (!factory.partnerUids.includes(CURRENT_USER.uid)) {
                  factory.partnerUids.push(CURRENT_USER.uid);
                  updated = true;
                }
                if (ln.sharePercent) {
                  factory.partnerShares = factory.partnerShares || {};
                  factory.partnerShares[CURRENT_USER.uid] = ln.sharePercent;
                  updated = true;
                }
              }
            });
            if (updated) {
              await fs.collection('app_data').doc(`factories_list_${ln.ownerUid}`).update({ data: list });
              console.log('[Refresh] patched partnerUids on owner factory list:', ln.ownerUid);
            }
          }
        } catch (e2) {
          console.warn('[Refresh] could not patch factory list:', e2);
        }
      }
      if (newLinked) {
        try {
          await fs.collection('users').doc(CURRENT_USER.uid).update({ linkedOwners: CURRENT_LINKED_OWNERS });
          console.log('[Refresh] linkedOwners persisted:', CURRENT_LINKED_OWNERS);
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[Refresh] partner_link processing error:', e);
    }

    // STEP 3: Scan partner_invite docs for this user's email as extra fallback
    // (covers cases where linkedOwners was cleared but invites still exist)
    try {
      const userEmail = (CURRENT_USER.email || '').toLowerCase();
      if (userEmail) {
        const invRes = await fs.collection('app_data')
          .where('email', '==', userEmail)
          .get({ source: 'server' });
        const invDocs = invRes.docs.filter(d =>
          d.data().type === 'partner_invite' && d.data().ownerUid
        );
        for (const invDoc of invDocs) {
          const inv = invDoc.data();
          if (!CURRENT_LINKED_OWNERS.includes(inv.ownerUid)) {
            CURRENT_LINKED_OWNERS.push(inv.ownerUid);
            console.log('[Refresh] recovered linkedOwner from invite:', inv.ownerUid);
          }
        }
        if (invDocs.length > 0) {
          try {
            await fs.collection('users').doc(CURRENT_USER.uid).update({ linkedOwners: CURRENT_LINKED_OWNERS });
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[Refresh] invite scan error:', e);
    }

    // Fetch factories_list_<uid> for self + all linked owners from server
    const ownersSet = new Set([CURRENT_USER.uid, ...CURRENT_LINKED_OWNERS]);
    if (WORKER_OWNER_UID && WORKER_OWNER_UID !== CURRENT_USER.uid) ownersSet.add(WORKER_OWNER_UID);

    let totalFactoriesFound = 0;
    for (const uid of ownersSet) {
      try {
        const docId = `factories_list_${uid}`;
        const doc = await fs.collection('app_data').doc(docId).get({ source: 'server' });
        if (doc.exists) {
          const cloudList = doc.data().data || [];
          localStorage.setItem(`zohir_factories_${uid}`, JSON.stringify(cloudList));
          totalFactoriesFound += cloudList.length;
          console.log('[Refresh] fetched', cloudList.length, 'factories for owner', uid);
        }
      } catch (e) {
        console.warn('[Refresh] could not fetch factories for', uid + ':', e?.message);
      }
    }

    // Re-render the factory grid
    renderFactoryScreen();

    console.log('[Refresh] complete. Total factories:', totalFactoriesFound);
    if (!silent && totalFactoriesFound >= 0) {
      showToast(`✅ تم تحديث القائمة (${totalFactoriesFound} مصنع)`);
    }
  } catch (err) {
    console.error('[Refresh] unexpected error:', err);
    if (!silent) showToast('⚠️ حدث خطأ أثناء التحديث', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 تحديث القائمة من السحابة'; }
  }
}

/* ===================== DIAGNOSE SHARES ===================== */
async function diagnoseShares() {
  const out = document.getElementById('diagnose-output');
  const modal = document.getElementById('modal-diagnose');
  if (!out || !modal) return;
  modal.classList.add('open');
  out.textContent = '⏳ جاري الفحص...';

  const lines = [];
  const log = (...args) => { lines.push(args.join(' ')); out.textContent = lines.join('\n'); };

  try {
    log('UID:        ', CURRENT_USER?.uid);
    log('Email:      ', CURRENT_USER?.email);
    log('Role:       ', CURRENT_ROLE);
    log('LinkedOwners (memory):', JSON.stringify(CURRENT_LINKED_OWNERS));
    log('');

    log('--- Cloud user doc ---');
    const userDoc = await fs.collection('users').doc(CURRENT_USER.uid).get({source:'server'});
    if (userDoc.exists) {
      const d = userDoc.data();
      log('exists: yes');
      log('linkedOwners:', JSON.stringify(d.linkedOwners || []));
      log('role:       ', d.role);
      log('email:      ', d.email);
    } else {
      log('exists: NO ❌');
    }
    log('');

    log('--- partner_link docs (by my UID) ---');
    const linkRes = await fs.collection('app_data')
      .where('partnerUid', '==', CURRENT_USER.uid)
      .get({source:'server'});
    const linkDocs = linkRes.docs.filter(d => d.data().type === 'partner_link');
    log('count:', linkDocs.length);
    linkDocs.forEach(d => {
      const data = d.data();
      log(`  • ${d.id}`);
      log(`    ownerUid: ${data.ownerUid}`);
      log(`    factoryId: ${data.factoryId}`);
      log(`    share%:   ${data.sharePercent || 0}`);
    });
    log('');

    log('--- partner_invite docs (by email) ---');
    const userEmail = (CURRENT_USER.email || '').toLowerCase();
    const invRes = await fs.collection('app_data').where('email','==',userEmail).get({source:'server'});
    const invDocs = invRes.docs.filter(d => d.data().type === 'partner_invite');
    log('count:', invDocs.length);
    invDocs.forEach(d => {
      const data = d.data();
      log(`  • ${d.id}`);
      log(`    ownerUid: ${data.ownerUid}`);
      log(`    factoryId: ${data.factoryId}`);
    });
    log('');

    log('--- Factories from linked owners ---');
    const allOwners = new Set([...(userDoc.data()?.linkedOwners || []), ...linkDocs.map(d => d.data().ownerUid)]);
    if (!allOwners.size) {
      log('(no linked owners found)');
    }
    for (const uid of allOwners) {
      log(`Owner: ${uid}`);
      const fDoc = await fs.collection('app_data').doc(`factories_list_${uid}`).get({source:'server'});
      if (!fDoc.exists) { log('  ❌ no factories_list doc'); continue; }
      const list = fDoc.data().data || [];
      list.forEach(f => {
        const isMine = (f.partnerUids || []).includes(CURRENT_USER.uid);
        log(`  ${isMine?'✅':'❌'} ${f.name} (id=${f.id})`);
        log(`     partnerUids: ${JSON.stringify(f.partnerUids||[])}`);
      });
    }
  } catch (e) {
    log('');
    log('❌ ERROR:', e.message);
  }
}

async function diagnoseFix() {
  const out = document.getElementById('diagnose-output');
  if (!out) return;
  const lines = [out.textContent, '', '--- 🔧 محاولة الإصلاح ---'];
  const log = (...args) => { lines.push(args.join(' ')); out.textContent = lines.join('\n'); };

  try {
    // 1. Find all owners that should be linked (from partner_link OR partner_invite)
    const linkRes = await fs.collection('app_data')
      .where('partnerUid', '==', CURRENT_USER.uid)
      .get({source:'server'});
    const linkDocs = linkRes.docs.filter(d => d.data().type === 'partner_link');

    const userEmail = (CURRENT_USER.email || '').toLowerCase();
    const invRes = await fs.collection('app_data').where('email','==',userEmail).get({source:'server'});
    const invDocs = invRes.docs.filter(d => d.data().type === 'partner_invite');

    const ownersToLink = new Set();
    linkDocs.forEach(d => { if (d.data().ownerUid) ownersToLink.add(d.data().ownerUid); });
    invDocs.forEach(d => { if (d.data().ownerUid) ownersToLink.add(d.data().ownerUid); });

    log('Found', ownersToLink.size, 'owner(s) to link');

    // 2. Build new linkedOwners and patch partnerUids on each factory
    const newLinked = [...ownersToLink];
    for (const ownerUid of ownersToLink) {
      try {
        const fDoc = await fs.collection('app_data').doc(`factories_list_${ownerUid}`).get({source:'server'});
        if (!fDoc.exists) { log(`❌ owner ${ownerUid} has no factories doc`); continue; }
        const list = fDoc.data().data || [];
        let updated = false;
        list.forEach(f => {
          // Find the matching partner_link/invite to know which factory(ies) to patch
          const myLinks = [...linkDocs, ...invDocs].filter(d => d.data().ownerUid === ownerUid);
          const allowedFactoryIds = myLinks.map(d => d.data().factoryId).filter(Boolean);
          const matches = allowedFactoryIds.length === 0 || allowedFactoryIds.includes(f.id);
          if (matches) {
            f.partnerUids = f.partnerUids || [];
            if (!f.partnerUids.includes(CURRENT_USER.uid)) {
              f.partnerUids.push(CURRENT_USER.uid);
              updated = true;
              log(`  + patched factory "${f.name}"`);
            }
          }
        });
        if (updated) {
          await fs.collection('app_data').doc(`factories_list_${ownerUid}`).update({ data: list });
        }
        // Save to localStorage
        localStorage.setItem(`zohir_factories_${ownerUid}`, JSON.stringify(list));
      } catch (e) {
        log(`❌ patch failed for ${ownerUid}:`, e.message);
      }
    }

    // 3. Update my linkedOwners
    if (newLinked.length) {
      try {
        await fs.collection('users').doc(CURRENT_USER.uid).update({ linkedOwners: newLinked });
        CURRENT_LINKED_OWNERS = newLinked;
        log('✅ linkedOwners updated:', JSON.stringify(newLinked));
      } catch (e) {
        log('❌ linkedOwners update failed:', e.message);
      }
    }

    // 4. Re-render
    renderFactoryScreen();
    log('');
    log('✅ تم — أغلق هذه النافذة وستجد المصانع المشاركة');
  } catch (e) {
    log('❌ FIX ERROR:', e.message);
  }
}

function initFactoryScreen() {
  renderFactoryScreen();

  // Add factory modal — only workers can add factories
  document.getElementById('btn-add-factory').addEventListener('click', () => {
    if (isReadOnlyUser()) {
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
    const selectedTypeBtn = document.querySelector('#factory-type-selector .factory-type-btn.selected');
    const type = selectedTypeBtn ? selectedTypeBtn.dataset.type : 'layer';
    const usedColors = FactoryDB.getFactories().map(f => f.color);
    const color = CARD_COLORS.find(c => !usedColors.includes(c)) || CARD_COLORS[FactoryDB.getFactories().length % CARD_COLORS.length];
    const factory = FactoryDB.addFactory(name, icon, color, type);
    closeAddFactoryModal();
    document.getElementById('new-factory-name').value = '';
    renderFactoryScreen();
    const typeLabel = type === 'broiler' ? 'مصنع لحم 🍗' : 'مصنع بيض 🥚';
    showToast(`✅ تمت إضافة ${name} (${typeLabel})`);
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

  // Factory type selector
  document.querySelectorAll('.factory-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.factory-type-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Auto-select matching icon based on type
      const type = btn.dataset.type;
      const autoIcon = type === 'broiler' ? '🍗' : '🥚';
      const iconOpt = document.querySelector(`.icon-opt[data-icon="${autoIcon}"]`);
      if (iconOpt) {
        document.querySelectorAll('.icon-opt').forEach(o => o.classList.remove('selected'));
        iconOpt.classList.add('selected');
      }
    });
  });

  // Factory switcher buttons
  document.getElementById('btn-switch-factory')?.addEventListener('click', exitToFactoryScreen);
  document.getElementById('topbar-switch-btn')?.addEventListener('click', exitToFactoryScreen);

  // Refresh factories from cloud (manual trigger on factory selection screen)
  document.getElementById('btn-refresh-factories')?.addEventListener('click', () => refreshFactoriesFromCloud());
  document.getElementById('btn-diagnose-shares')?.addEventListener('click', diagnoseShares);
  document.getElementById('btn-diagnose-fix')?.addEventListener('click', diagnoseFix);
  document.getElementById('btn-diagnose-close')?.addEventListener('click', () => {
    document.getElementById('modal-diagnose')?.classList.remove('open');
  });
}

function openAddFactoryModal() {
  document.getElementById('modal-add-factory').classList.add('open');
  setTimeout(() => document.getElementById('new-factory-name').focus(), 300);
}
function closeAddFactoryModal() {
  document.getElementById('modal-add-factory').classList.remove('open');
}

/* ===================== NAVIGATION ===================== */
function triggerNavAnimation(clickedBtn) {
  clickedBtn.classList.remove('nav-item--click');
  void clickedBtn.offsetWidth;
  clickedBtn.classList.add('nav-item--click');
  setTimeout(() => clickedBtn.classList.remove('nav-item--click'), 1550);
}

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
    settings: loadSettingsForm,
    cycles: renderCyclesPage,
    'broiler-sales': renderBroilerSalesPage,
    'broiler-reports': renderBroilerReportsPage,
    'broiler-workers': renderBroilerWorkersPage,
  };
  if (refreshers[pageId]) refreshers[pageId]();
  if (pageId === 'daily' && CURRENT_FACTORY?.type === 'broiler') {
    if (typeof initBroilerDailyPage === 'function') initBroilerDailyPage();
  }
  syncDailyReadOnlyState();
  // Close mobile sidebar — delay on mobile so nav animation stays visible
  const sidebarDelay = window.innerWidth <= 768 ? 1520 : 0;
  setTimeout(() => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('open');
  }, sidebarDelay);
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
  if (typeof _broilerDashboardHook === 'function' && _broilerDashboardHook()) return;
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

  // Expected Profit KPI
  const expectedProfit = getExpectedMonthlyProfit();
  const expectedProfitEl = document.getElementById('kpi-expected-profit');
  if (expectedProfitEl) {
    expectedProfitEl.textContent = fmt(expectedProfit, 'دج');
    expectedProfitEl.style.color = expectedProfit >= 0 ? 'var(--green)' : 'var(--red)';
  }

  // Personal Share KPI
  renderPersonalProfitKpi(netProfit, settings);

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
      
      <div class="report-row"><span>الكرطونات المباعة</span><strong>${fmt(log.soldGroups)}</strong></div>
      <div class="report-row"><span>الفردي المباع</span><strong>${fmt(log.soldSingle)}</strong></div>
      
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

function renderPersonalProfitKpi(totalNetProfit, settings) {
  const grid = document.getElementById('kpi-grid');
  if (!grid) return;
  
  const existing = document.getElementById('kpi-personal-share');
  if (existing) existing.remove();
  
  let mySharePct = 0;
  let label = '';
  
  if (CURRENT_ROLE === 'owner') {
     mySharePct = settings.ownerShare !== undefined ? Number(settings.ownerShare) : 100;
     label = 'حصتي كصاحب مصنع';
  } else if (CURRENT_ROLE === 'partner') {
     const myEmail = CURRENT_USER?.email?.toLowerCase();
     const myUid = CURRENT_USER?.uid;
     const p = (settings.partners || []).find(x => x.uid === myUid || (x.email && x.email.toLowerCase() === myEmail));
     if (p) {
        mySharePct = Number(p.sharePercent) || 0;
        label = `حصتي كشريك (${mySharePct}%)`;
     } else { return; }
  } else { return; }
  
  const myProfit = totalNetProfit * (mySharePct / 100);
  const card = document.createElement('div');
  card.id = 'kpi-personal-share';
  card.className = 'kpi-card kpi-my-share';
  card.innerHTML = `
    <div class="kpi-icon">💎</div>
    <div class="kpi-info">
      <span class="kpi-value">-</span>
      <span class="kpi-label">${label}</span>
    </div>
    <div class="kpi-bar"><div class="kpi-bar-fill" style="width:100%; opacity:0.3"></div></div>
  `;
  grid.appendChild(card);
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
  const btnSave = document.getElementById('btn-save-day');
  if (btnSave) {
    btnSave.innerText = 'حفظ التسجيل اليومي';
    btnSave.dataset.editMode = 'false';
  }
  initDailyWizard();

  const calcFields = ['inp-produced', 'inp-broken', 'inp-sold-total', 'inp-free-plates', 'inp-feed-in', 'inp-feed-used', ];
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

function getDailyWizardStages() {
  const cards = Array.from(document.querySelectorAll('#layer-daily-wrapper > .form-grid > .form-card'));
  return [
    {
      title: 'الإنتاج',
      hint: 'اكتب التاريخ، الإنتاج، المكسور، وسعر البلاكة. بعدها ننتقل للمبيعات.',
      cards: [cards[0]].filter(Boolean)
    },
    {
      title: 'المبيعات',
      hint: 'اكتب عدد البلاكات المباعة وحالة الدفع، ثم تحقق من المدخول.',
      cards: [cards[1]].filter(Boolean)
    },
    {
      title: 'المصاريف والمخزون',
      hint: 'أدخل الشعير، النافق، الماء، والغبار حتى تكون الفائدة دقيقة.',
      cards: [cards[2], cards[3], cards[4]].filter(Boolean)
    },
    {
      title: 'الشركاء والعمال',
      hint: 'أدخل مصاريف الشركاء، سلفيات صاحب العمل، سلفيات العمال، والبيض الخاص.',
      cards: [cards[5], cards[6], cards[7]].filter(Boolean)
    },
    {
      title: 'التأكيد والحفظ',
      hint: 'راجع الملاحظات والملخص، ثم اضغط حفظ بيانات اليوم.',
      cards: [cards[8]].filter(Boolean)
    }
  ];
}

function initDailyWizard() {
  const wizard = document.getElementById('daily-wizard');
  if (!wizard || wizard.dataset.ready === '1') return;
  wizard.dataset.ready = '1';
  document.getElementById('daily-step-prev')?.addEventListener('click', () => setDailyWizardStep(_dailyWizardStep - 1));
  document.getElementById('daily-step-next')?.addEventListener('click', () => {
    if (!validateDailyWizardStep(_dailyWizardStep)) return;
    setDailyWizardStep(_dailyWizardStep + 1);
  });
  document.querySelectorAll('#daily-wizard .daily-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = Number(btn.dataset.step) || 0;
      if (target > _dailyWizardStep && !validateDailyWizardStep(_dailyWizardStep)) return;
      setDailyWizardStep(target);
    });
  });
  setDailyWizardStep(0);
}

function validateDailyWizardStep(step) {
  if (cannotDoDailyEntry()) return true;
  const produced = Number(document.getElementById('inp-produced')?.value) || 0;
  const broken = Number(document.getElementById('inp-broken')?.value) || 0;
  const price = Number(document.getElementById('inp-price')?.value) || 0;
  const soldTotal = Number(document.getElementById('inp-sold-total')?.value) || 0;
  const freePlates = Number(document.getElementById('inp-free-plates')?.value) || 0;
  const net = produced - broken;

  if (step === 0) {
    if (!document.getElementById('inp-date')?.value) { showToast('اختر تاريخ اليوم أولاً', 'error'); return false; }
    if (produced <= 0) { showToast('أدخل إنتاج اليوم أولاً', 'error'); return false; }
    if (broken > produced) { showToast('المكسور لا يمكن أن يكون أكبر من الإنتاج', 'error'); return false; }
    
  }

  if (step === 1) {
    if (soldTotal + freePlates > net) { showToast('المبيعات والمجاني أكبر من الصافي المتوفر', 'error'); return false; }
    if (_paymentStatus === 'unpaid' && soldTotal > 0 && !document.getElementById('inp-sale-client')?.value.trim()) {
      showToast('اكتب اسم المشتري عند البيع غير الخالص', 'error');
      return false;
    }
  }

  return true;
}

function setDailyWizardStep(step) {
  const stages = getDailyWizardStages();
  if (!stages.length) return;
  _dailyWizardStep = Math.max(0, Math.min(step, stages.length - 1));

  stages.forEach((stage, idx) => {
    stage.cards.forEach(card => {
      card.classList.toggle('daily-stage-hidden', idx !== _dailyWizardStep);
      card.classList.toggle('daily-stage-active', idx === _dailyWizardStep);
    });
  });

  document.querySelectorAll('#daily-wizard .daily-step-btn').forEach(btn => {
    const idx = Number(btn.dataset.step) || 0;
    btn.classList.toggle('active', idx === _dailyWizardStep);
    btn.classList.toggle('done', idx < _dailyWizardStep);
  });

  const hint = document.getElementById('daily-wizard-hint');
  if (hint) hint.textContent = stages[_dailyWizardStep].hint;
  const prev = document.getElementById('daily-step-prev');
  const next = document.getElementById('daily-step-next');
  if (prev) prev.style.visibility = _dailyWizardStep === 0 ? 'hidden' : 'visible';
  if (next) next.textContent = _dailyWizardStep === stages.length - 1 ? 'مراجعة الحساب' : 'التالي';
  document.getElementById('btn-save-day')?.classList.toggle('daily-save-visible', _dailyWizardStep === stages.length - 1);
  updateDailyCalc();
}

function setPaymentStatus(status) {
  _paymentStatus = status;
  document.getElementById('btn-paid-status')?.classList.toggle('active', status === 'paid');
  document.getElementById('btn-unpaid-status')?.classList.toggle('active', status === 'unpaid');
  const section = document.getElementById('farsimon-section');
  if (section) section.style.display = status === 'unpaid' ? 'block' : 'none';
  if (status === 'paid') {
    const inp = document.getElementById('inp-farsimon');
    if (inp) inp.value = '';
    const cl = document.getElementById('inp-sale-client');
    if (cl) cl.value = '';
  }
  updateDailyCalc();
}

function updateDailyCalc() {
  const produced = Number(document.getElementById('inp-produced')?.value) || 0;
  const broken = Number(document.getElementById('inp-broken')?.value) || 0;
  const price = 0; // Removed
  const soldTotal = Number(document.getElementById('inp-sold-total')?.value) || 0;
  const feedIn = Number(document.getElementById('inp-feed-in')?.value) || 0;
  const feedPrice = 0; // Removed
  const feedUsed = Number(document.getElementById('inp-feed-used')?.value) || 0;
  const manureIncome = Number(document.getElementById('inp-manure-income')?.value) || 0;
  const waterCost = Number(document.getElementById('inp-water-cost')?.value) || 0;
  const specialPlates = Number(document.getElementById('inp-special-plates')?.value) || 0;
  const specialSingles = Number(document.getElementById('inp-special-singles')?.value) || 0;
  const specialSold = Number(document.getElementById('inp-special-sold')?.value) || 0;
  const specialPrice = 0; // Removed

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  const feedBal = getCurrentFeedBalance() + feedIn - feedUsed;
  
  const specialIncome = specialPlates * specialPrice + specialSingles * (specialPrice / 12);

  const settings = DB.get('settings') || defaultSettings();
  const baseFeedPrice = Number(settings.feedPrice) || 0;
  const consumedFeedCost = feedUsed * (feedPrice > 0 ? feedPrice : baseFeedPrice);

  // Identify dust worker (advances of dust worker are deducted from dust profit, not general profit)
  const _workersList = DB.get('workers') || [];
  const _dustWorkerIds = new Set(_workersList.filter(w => w.isDustWorker).map(w => String(w.id)));

  let workerAdvancesTotal = 0;
  let dustWorkerAdvancesToday = 0;

  const ownerAdvance = Number(document.getElementById('inp-owner-advance')?.value) || 0;

  // Base profit before partner expenses and owner advance
  // Note: dust worker advances are excluded from workerAdvancesTotal — they're charged against dust profit
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

  // Farsimon / payment preview
  const farsimon = _paymentStatus === 'unpaid' ? (Number(document.getElementById('inp-farsimon')?.value) || 0) : 0;
  const creditAmount = _paymentStatus === 'unpaid' ? Math.max(0, income - farsimon) : 0;
  const farsimonRow = document.getElementById('prev-farsimon-row');
  const creditRow = document.getElementById('prev-credit-row');
  if (farsimonRow) farsimonRow.style.display = _paymentStatus === 'unpaid' && income > 0 ? 'flex' : 'none';
  if (creditRow) creditRow.style.display = _paymentStatus === 'unpaid' && creditAmount > 0 ? 'flex' : 'none';
  const farsimonEl = document.getElementById('prev-farsimon');
  if (farsimonEl) farsimonEl.textContent = fmt(farsimon, 'دج');
  const creditEl = document.getElementById('prev-credit-amount');
  if (creditEl) creditEl.textContent = fmt(creditAmount, 'دج');

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

  // Partner & Owner shares preview
  const sharesEl = document.getElementById('prev-partner-shares');
  if (sharesEl) {
    let html = '';
    const ownerSharePct = settings.ownerShare !== undefined ? settings.ownerShare : 100;
    const ownerShareVal = (baseProfit * ownerSharePct / 100) - ownerAdvance;

    if (partners.length > 0) {
      partners.forEach(p => {
        const partnerExp = Number(document.getElementById(`inp-pexp-${p.id}`)?.value) || 0;
        const partnerShare = (baseProfit * (Number(p.sharePercent) || 0) / 100) - partnerExp;
        html += `<div class="calc-row" style="font-size:0.85rem;padding:3px 0">
          <span>🤝 ${p.name} (${p.sharePercent}%)</span>
          <strong style="color:${partnerShare >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(partnerShare, 'دج')}</strong>
        </div>`;
      });
      html += `<div style="border-top:1px dashed rgba(255,255,255,0.1); margin:4px 0"></div>`;
    }

    html += `<div class="calc-row" style="font-size:0.85rem;padding:3px 0">
      <span>👔 صاحب العمل (${ownerSharePct}%)</span>
      <strong style="color:${ownerShareVal >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(ownerShareVal, 'دج')}</strong>
    </div>`;

    if (ownerAdvance > 0) {
      html += `<div class="calc-row" style="font-size:0.85rem;padding:3px 0">
        <span>👔 سلفيات صاحب العمل</span>
        <strong style="color:var(--orange)">-${fmt(ownerAdvance, 'دج')}</strong>
      </div>`;
    }
    sharesEl.innerHTML = html;
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
  if (cannotDoDailyEntry()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }
  const date = document.getElementById('inp-date').value;
  const produced = Number(document.getElementById('inp-produced')?.value) || 0;
  const broken = Number(document.getElementById('inp-broken')?.value) || 0;
  const price = 0; // Removed
  const soldTotal = Number(document.getElementById('inp-sold-total')?.value) || 0;
  const freePlates = Number(document.getElementById('inp-free-plates')?.value) || 0;
  const feedIn = Number(document.getElementById('inp-feed-in')?.value) || 0;
  const feedPrice = 0; // Removed
  const feedUsed = Number(document.getElementById('inp-feed-used')?.value) || 0;
  const dead = Number(document.getElementById('inp-dead').value) || 0;
  const waterCost = 0;
  const manureIncome = 0;
  const expenses = 0; // ملغى — أصبحت مصاريف منفصلة لكل شريك
  const ownerAdvance = Number(document.getElementById('inp-owner-advance')?.value) || 0;
  const notes = document.getElementById('inp-notes').value.trim();
  const specialPlates = Number(document.getElementById('inp-special-plates')?.value) || 0;
  const specialSingles = Number(document.getElementById('inp-special-singles')?.value) || 0;
  const specialSold = Number(document.getElementById('inp-special-sold')?.value) || 0;
  const specialPrice = 0;
  const specialIncome = specialPlates * specialPrice + specialSingles * (specialPrice / 12);
  const isPaid = _paymentStatus === 'paid';
  const farsimon = isPaid ? 0 : (Number(document.getElementById('inp-farsimon')?.value) || 0);
  const saleClient = isPaid ? '' : (document.getElementById('inp-sale-client')?.value.trim() || '');

  if (!date) { showToast('يرجى تحديد التاريخ', 'error'); return; }

  const net = produced - broken;
  const koliates = Math.floor(net / 12);
  const singleLeft = net % 12;
  const soldGroups = Math.floor(soldTotal / 12);
  const soldSingle = soldTotal % 12;
  const income = soldTotal * price;
  

  // Collect advances
  // Dust-worker advances are tracked separately and NOT deducted from baseProfit (they come out of dust profit)
  const _workersForCalc = DB.get('workers') || [];
  const _dustIds = new Set(_workersForCalc.filter(w => w.isDustWorker).map(w => String(w.id)));
  const advancesThisDay = [];
  let workerAdvancesTotal = 0;
  let dustWorkerAdvancesToday = 0;

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
    specialPlates, specialSingles, specialSold, specialPrice, specialIncome,
    dustAdvances: dustWorkerAdvancesToday,
    isPaid, farsimon, saleClient,
    enteredBy: CURRENT_USER_NAME || '',
    enteredByUid: CURRENT_USER ? CURRENT_USER.uid : ''
  };

  const logs = (DB.get('daily_logs') || []).filter(l => l && typeof l === 'object');
  const existingIdx = logs.findIndex(l => l.date === log.date);
  if (existingIdx > -1) {
    // Retain old advances/credits if not fully handled, but for now just replace the day object
    log.id = logs[existingIdx].id; // Keep original ID
    logs[existingIdx] = log;
  } else {
    logs.push(log);
  }
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

  // Auto-add credit for unpaid remainder
  if (!isPaid && income > 0) {
    const creditAmt = Math.max(0, income - farsimon);
    if (creditAmt > 0) {
      const credits = DB.get('credits') || [];
      credits.push({
        id: Date.now(),
        date,
        clientName: saleClient || 'مشتري غير محدد',
        description: `بيع ${soldGroups} كرطون${soldSingle > 0 ? ' + ' + soldSingle + ' بلاكة' : ''} — فارسمون: ${fmt(farsimon, 'دج')}`,
        amount: creditAmt
      });
      DB.set('credits', credits);
      addActivity(`كريديت تلقائي: ${saleClient || 'مشتري'} — الباقي: ${fmt(creditAmt, 'دج')}`, '💳');
    }
  }

  const totalDayIncome = income + specialIncome;
  addActivity(`تم حفظ بيانات يوم ${fmtDate(date)} — مدخول: ${fmt(income, 'دج')}${specialIncome > 0 ? ' + خاص: '+fmt(specialIncome, 'دج') : ''} — فائدة: ${fmt(log.profit, 'دج')}`, '📅');
  showToast('✅ تم حفظ بيانات اليوم بنجاح!');
  const btnSave = document.getElementById('btn-save-day');
  if (btnSave && btnSave.dataset.editMode === 'true') {
    btnSave.innerText = 'حفظ التسجيل اليومي';
    btnSave.dataset.editMode = 'false';
    showPage('reports');
    return;
  }
  renderDailyReportOutput(log);
  if (!isPaid && income > 0) showSaleReceipt(log);
  updateDailyCalc();
}

function showSaleReceipt(log) {
  const modal = document.getElementById('sale-receipt-modal');
  if (!modal) return;
  const factoryName = CURRENT_FACTORY?.name || '';
  document.getElementById('receipt-factory-name').textContent = factoryName;
  const creditAmt = Math.max(0, (log.income || 0) - (log.farsimon || 0));
  document.getElementById('receipt-body').innerHTML = `
    <div class="receipt-row no-print"><span>التاريخ</span><span>${fmtDate(log.date)}</span></div>
    <div class="receipt-row"><span>المشتري</span><span><strong>${log.saleClient || '—'}</strong></span></div>
    <div class="receipt-divider"></div>
    <div class="receipt-row"><span>الكرطونات المباعة</span><span>${fmt(log.soldGroups)} كرطون</span></div>
    ${log.soldSingle > 0 ? `<div class="receipt-row"><span>الفردي المباع</span><span>${fmt(log.soldSingle)} بلاكة</span></div>` : ''}
    
    <div class="receipt-divider no-print"></div>
    <div class="receipt-row receipt-total no-print"><span>المبلغ الكلي</span><span>${fmt(log.income, 'دج')}</span></div>
    <div class="receipt-row" style="color:var(--blue)"><span>الفارسمون (المدفوع)</span><span><strong>${fmt(log.farsimon || 0, 'دج')}</strong></span></div>
    <div class="receipt-row receipt-credit"><span>الباقي (دين)</span><span><strong>${fmt(creditAmt, 'دج')}</strong></span></div>
    <div class="receipt-note no-print">تم تسجيل الباقي تلقائياً في الكريديات</div>
  `;
  modal.style.display = 'flex';
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
        <div class="report-row" style="font-size:0.88rem; border-top: 1px dashed rgba(255,255,255,0.1); margin-top: 4px; padding-top: 4px;">
          <span>👔 صاحب العمل (${settings.ownerShare || 100}%)</span>
          <strong class="${(log.baseProfit * (settings.ownerShare || 100) / 100 - (log.ownerAdvance || 0)) >= 0 ? 'positive' : 'negative'}">
            ${fmt(log.baseProfit * (settings.ownerShare || 100) / 100 - (log.ownerAdvance || 0), 'دج')}
          </strong>
        </div>
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
        <div class="report-row" style="font-size:0.88rem; border-top: 1px dashed rgba(255,255,255,0.1); margin-top: 4px; padding-top: 4px;">
          <span>👔 صاحب العمل (${settings.ownerShare || 100}%)</span>
          <strong class="${(log.baseProfit * (settings.ownerShare || 100) / 100 - (log.ownerAdvance || 0)) >= 0 ? 'positive' : 'negative'}">
            ${fmt(log.baseProfit * (settings.ownerShare || 100) / 100 - (log.ownerAdvance || 0), 'دج')}
          </strong>
        </div>
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

function printDailyLogDetails() {
  const content = document.getElementById('details-modal-body').innerHTML;
  const title = document.getElementById('details-modal-title').textContent;
  
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html dir="rtl" lang="ar">
      <head>
        <title>${title}</title>
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&display=swap" rel="stylesheet" />
        <style>
          body { 
            font-family: 'Cairo', sans-serif; 
            padding: 20px; 
            color: #000; 
            background: #fff; 
            direction: rtl;
          }
          h2 { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #000; padding-bottom: 10px; }
          .report-block { margin-bottom: 20px; border: 1px solid #000; padding: 15px; border-radius: 8px; page-break-inside: avoid; }
          .report-block-title { font-weight: bold; font-size: 1.2rem; margin-bottom: 10px; border-bottom: 1px solid #000; padding-bottom: 5px; }
          .report-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 16px; border-bottom: 1px dashed #ccc; padding-bottom: 4px; }
          .report-row:last-child { border-bottom: none; }
          .accountant-note { padding: 15px; background: #eee; border-right: 4px solid #000; margin-top: 20px; font-style: italic; border-radius: 5px; page-break-inside: avoid; }
          .negative, .positive, .warn { font-weight: bold; }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        ${content}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    printWindow.close();
  }, 500);
}

function clearDailyForm() {
  setPaymentStatus('paid');
  ['inp-produced', 'inp-broken', 'inp-sold-total', 'inp-free-plates', 'inp-feed-in', 'inp-feed-used', 'inp-dead', 'inp-notes', 'inp-farsimon', 'inp-sale-client'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  // clear partner expense fields
  document.querySelectorAll('[id^="inp-pexp-"]').forEach(el => el.value = '');
  document.getElementById('inp-date').value = todayStr();
  const btnSave = document.getElementById('btn-save-day');
  if (btnSave) {
    btnSave.innerText = 'حفظ التسجيل اليومي';
    btnSave.dataset.editMode = 'false';
  }
  document.getElementById('advance-entries').innerHTML = `
    <div class="advance-row">
      <select class="adv-worker-select">${workerOptions()}</select>
      <input type="number" class="adv-amount" placeholder="المبلغ (دج)" min="0" />
      <button class="btn-remove-adv" title="حذف">✕</button>
    </div>`;
  document.querySelector('.btn-remove-adv')?.addEventListener('click', (e) => e.target.closest('.advance-row')?.remove());
  document.getElementById('daily-report-output').style.display = 'none';
  setDailyWizardStep(0);
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
  if (!tbody) return;   // sales page not present in this build
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
  const sorted = [...logs].sort((a, b) => parseDateKey(b.date) - parseDateKey(a.date));
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

  renderMonthlySalesTable(logs);
}

function renderMonthlySalesTable(logs) {
  const tbody = document.getElementById('monthly-sales-tbody');
  if (!tbody) return;
  ensureMonthlySalesUI();
  if (!logs || !logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">لا توجد مبيعات شهرية</td></tr>';
    return;
  }
  
  if (!logs || !logs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">لا توجد مبيعات شهرية</td></tr>';
    return;
  }
  
  const monthly = {};
  logs.forEach(log => {
    if (!log.date) return;
    const dateObj = parseDateKey(log.date);
    const y = dateObj.getFullYear();
    const m = dateObj.getMonth();
    const key = `${y}-${m}`;
    const arMonth = new Intl.DateTimeFormat('ar-DZ', { month: 'long', year: 'numeric' }).format(dateObj);
    
    if (!monthly[key]) {
      monthly[key] = { key, year: y, month: m, label: arMonth, sortDate: new Date(y, m, 1), groups: 0, singles: 0, income: 0, profit: 0, logs: [] };
    }
    monthly[key].groups += Number(log.soldGroups) || 0;
    monthly[key].singles += Number(log.soldSingle) || 0;
    monthly[key].income += (Number(log.income) || 0) + (Number(log.specialIncome) || 0);
    monthly[key].profit += Number(log.profit) || 0;
    monthly[key].logs.push(log);
  });
  
  const sorted = Object.values(monthly).sort((a, b) => b.sortDate - a.sortDate);
  tbody.innerHTML = '';
  
  sorted.forEach(m => {
    const profitColor = m.profit >= 0 ? 'var(--green)' : 'var(--red)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.label}</strong></td>
      <td>${fmt(m.groups)}</td>
      <td>${fmt(m.singles)}</td>
      <td><strong style="color:var(--green)">${fmt(m.income, 'دج')}</strong></td>
      <td><strong style="color:${profitColor};font-size:1rem">${fmt(m.profit, 'دج')}</strong></td>
    `;
    const actionTd = document.createElement('td');
    actionTd.innerHTML = `
      <button class="btn btn-outline btn-sm btn-view-monthly-sales" data-month-key="${m.key}" style="margin-left:4px">تفاصيل</button>
      <button class="btn btn-outline btn-sm btn-print-monthly-sales" data-month-key="${m.key}">طباعة</button>
    `;
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-view-monthly-sales').forEach(btn => {
    btn.addEventListener('click', () => showMonthlySalesDetails(btn.dataset.monthKey));
  });
  tbody.querySelectorAll('.btn-print-monthly-sales').forEach(btn => {
    btn.addEventListener('click', () => printMonthlySalesDetails(btn.dataset.monthKey));
  });
}

function ensureMonthlySalesUI() {
  const monthlyTable = document.getElementById('monthly-sales-table');
  const headRow = monthlyTable?.querySelector('thead tr');
  if (headRow && !headRow.querySelector('.monthly-sales-actions-head')) {
    const th = document.createElement('th');
    th.className = 'monthly-sales-actions-head';
    th.textContent = 'إجراءات';
    headRow.appendChild(th);
  }

  if (document.getElementById('monthly-details-modal')) return;

  const modal = document.createElement('div');
  modal.id = 'monthly-details-modal';
  modal.className = 'modal';
  modal.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:1000; justify-content:center; align-items:center; backdrop-filter:blur(5px);';
  modal.innerHTML = `
    <div class="modal-content section-card" style="position:relative; width:92%; max-width:820px; max-height:90vh; overflow-y:auto; padding:20px; background:var(--bg-card); border-radius:var(--radius); border:1px solid var(--border); box-shadow:var(--shadow-glow);">
      <div style="position:absolute; top:15px; left:15px; display:flex; gap:15px; align-items:center;">
        <button id="btn-print-monthly-details" style="background:transparent; border:none; font-size:1.3rem; cursor:pointer;" title="طباعة">🖨️</button>
        <button id="btn-close-monthly-details" style="background:transparent; border:none; color:var(--text-secondary); font-size:1.6rem; cursor:pointer; line-height:1;" title="إغلاق">&times;</button>
      </div>
      <div class="section-title" id="monthly-details-title" style="margin-bottom:15px; font-size:1.2rem; color:var(--text-primary);">تفاصيل الشهر</div>
      <div id="monthly-details-body"></div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('btn-close-monthly-details')?.addEventListener('click', () => {
    document.getElementById('monthly-details-modal').style.display = 'none';
  });
  document.getElementById('btn-print-monthly-details')?.addEventListener('click', () => {
    printMonthlySalesDetails();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
}

function buildMonthlySalesMap(logs = DB.get('daily_logs') || []) {
  const monthly = {};
  logs.forEach(log => {
    if (!log.date) return;
    const dateObj = parseDateKey(log.date);
    const y = dateObj.getFullYear();
    const m = dateObj.getMonth();
    const key = `${y}-${m}`;
    const arMonth = new Intl.DateTimeFormat('ar-DZ', { month: 'long', year: 'numeric' }).format(dateObj);
    if (!monthly[key]) {
      monthly[key] = { key, year: y, month: m, label: arMonth, sortDate: new Date(y, m, 1), groups: 0, singles: 0, income: 0, profit: 0, logs: [] };
    }
    monthly[key].groups += Number(log.soldGroups) || 0;
    monthly[key].singles += Number(log.soldSingle) || 0;
    monthly[key].income += (Number(log.income) || 0) + (Number(log.specialIncome) || 0);
    monthly[key].profit += Number(log.profit) || 0;
    monthly[key].logs.push(log);
  });
  return monthly;
}

function showMonthlySalesDetails(monthKey) {
  ensureMonthlySalesUI();
  const monthData = buildMonthlySalesMap()[monthKey];
  if (!monthData) return;

  const modal = document.getElementById('monthly-details-modal');
  const titleEl = document.getElementById('monthly-details-title');
  const bodyEl = document.getElementById('monthly-details-body');
  titleEl.textContent = `تفاصيل شهر ${monthData.label}`;

  const sortedLogs = [...monthData.logs].sort((a, b) => parseDateKey(b.date) - parseDateKey(a.date));
  const rows = sortedLogs.map(log => {
    const totalIncome = (Number(log.income) || 0) + (Number(log.specialIncome) || 0);
    const profit = Number(log.profit) || 0;
    return `
      <div class="report-row">
        <span>${fmtDate(log.date)}</span>
        <strong>${fmt(log.soldGroups)} ك / ${fmt(log.soldSingle)} ف</strong>
      </div>
      <div class="report-row">
        <span>الإجمالي</span>
        <strong class="positive">${fmt(totalIncome, 'دج')}</strong>
      </div>
      <div class="report-row">
        <span>الربح</span>
        <strong class="${profit >= 0 ? 'positive' : 'negative'}">${fmt(profit, 'دج')}</strong>
      </div>
    `;
  }).join('');

  bodyEl.innerHTML = `
    <div class="report-grid" style="margin-bottom:16px">
      <div class="report-stat"><div class="rs-val">${fmt(monthData.groups)}</div><div class="rs-lbl">إجمالي الكرطونات</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(monthData.singles)}</div><div class="rs-lbl">إجمالي الفردي</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(monthData.income, 'دج')}</div><div class="rs-lbl">المدخول الإجمالي</div></div>
      <div class="report-stat"><div class="rs-val" style="color:${monthData.profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(monthData.profit, 'دج')}</div><div class="rs-lbl">الربح الأساسي</div></div>
    </div>
    <div class="report-block">
      <div class="report-block-title">الأيام المسجلة داخل هذا الشهر</div>
      ${rows || '<div class="report-row"><span>لا توجد أيام مسجلة</span><strong>—</strong></div>'}
    </div>
  `;
  modal.style.display = 'flex';
}

function printMonthlySalesDetails(monthKey = null) {
  if (monthKey) showMonthlySalesDetails(monthKey);
  const bodyEl = document.getElementById('monthly-details-body');
  const titleEl = document.getElementById('monthly-details-title');
  if (!bodyEl || !titleEl) return;

  const content = bodyEl.innerHTML;
  const title = titleEl.textContent;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html dir="rtl" lang="ar">
      <head>
        <title>${title}</title>
        <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&display=swap" rel="stylesheet" />
        <style>
          body { font-family: 'Cairo', sans-serif; padding: 20px; color: #000; background: #fff; direction: rtl; }
          h2 { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #000; padding-bottom: 10px; }
          .report-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin-bottom:20px; }
          .report-stat { border:1px solid #000; border-radius:8px; padding:14px; text-align:center; }
          .rs-val { font-size:1.2rem; font-weight:700; }
          .rs-lbl { margin-top:4px; font-size:0.85rem; }
          .report-block { margin-bottom: 20px; border: 1px solid #000; padding: 15px; border-radius: 8px; page-break-inside: avoid; }
          .report-block-title { font-weight: bold; font-size: 1.05rem; margin-bottom: 10px; border-bottom: 1px solid #000; padding-bottom: 5px; }
          .report-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 15px; border-bottom: 1px dashed #ccc; padding-bottom: 4px; }
          .report-row:last-child { border-bottom: none; }
          .negative, .positive, .warn { font-weight: bold; }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        ${content}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    printWindow.close();
  }, 500);
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
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

  // Calculate and display total
  const partnersSum = partners.reduce((sum, p) => sum + (Number(p.sharePercent) || 0), 0);
  const ownerShare = settings.ownerShare !== undefined ? settings.ownerShare : 100;
  const total = ownerShare + partnersSum;
  const totalEl = document.getElementById('partners-share-total');
  if (totalEl) {
    totalEl.textContent = total + '%';
    totalEl.style.color = total === 100 ? 'var(--green)' : 'var(--red)';
  }
}

async function addPartner(source = 'auto') {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  // This can be called from Settings, the Team page, or the share-factory modal
  const nameFromSettings = document.getElementById('new-partner-name')?.value.trim();
  const emailFromSettings = document.getElementById('new-partner-email')?.value.trim();
  const shareFromSettingsRaw = document.getElementById('new-partner-share')?.value;
  const shareFromSettings = shareFromSettingsRaw !== '' ? parseFloat(shareFromSettingsRaw) : 0;
  const nameFromTeam = document.getElementById('new-team-partner-name')?.value.trim();
  const emailFromTeam = document.getElementById('new-team-partner-email')?.value.trim();
  const shareFromTeamRaw = document.getElementById('new-team-partner-share')?.value;
  const shareFromTeam = shareFromTeamRaw !== '' ? parseFloat(shareFromTeamRaw) : 0;
  const nameFromModal = document.getElementById('share-partner-name')?.value.trim();
  const emailFromModal = document.getElementById('share-partner-email')?.value.trim();
  const shareFromModalRaw = document.getElementById('share-partner-share')?.value;
  const shareFromModal = shareFromModalRaw !== '' ? parseFloat(shareFromModalRaw) : 0;

  let name = '';
  let share = 0;
  let email = '';
  if (source === 'settings') {
    name = nameFromSettings || '';
    share = shareFromSettings;
    email = emailFromSettings || '';
  } else if (source === 'team') {
    name = nameFromTeam || '';
    share = shareFromTeam;
    email = emailFromTeam || '';
  } else if (source === 'modal') {
    name = nameFromModal || '';
    share = shareFromModal;
    email = emailFromModal || '';
  } else {
    name = nameFromSettings || nameFromTeam || nameFromModal || '';
    share = shareFromSettings || shareFromTeam || shareFromModal;
    email = emailFromSettings || emailFromTeam || emailFromModal || '';
  }

  if (!email && name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    email = name;
    name = name.split('@')[0];
  }

  if (!name) { showToast('يرجى إدخال اسم الشريك', 'error'); return; }
  if (isNaN(share) || share <= 0 || share > 100) { showToast('نسبة غير صحيحة (1-100)', 'error'); return; }
  if (!CURRENT_FACTORY) { showToast('⚠️ افتح المصنع أولاً', 'error'); return; }

  const settingsAddBtn = document.getElementById('btn-add-partner');
  const settingsSaveBtn = document.getElementById('btn-save-partner-shares');
  const teamBtn = document.getElementById('btn-add-team-partner');
  const shareBtn = document.getElementById('btn-confirm-share-factory');
  const btn = teamBtn;
  const setBtnState = (busy) => {
    if (settingsAddBtn)  { settingsAddBtn.disabled  = busy; settingsAddBtn.textContent  = busy ? '⏳ جاري الحفظ...' : '+ إضافة شريك'; }
    if (settingsSaveBtn) { settingsSaveBtn.disabled = busy; settingsSaveBtn.textContent = busy ? '⏳ جاري الحفظ...' : '💾 تأكيد وحفظ النسبة'; }
    if (teamBtn)  { teamBtn.disabled  = busy; teamBtn.textContent  = busy ? '⏳ جاري الإضافة...' : 'إضافة'; }
    if (shareBtn) { shareBtn.disabled = busy; shareBtn.textContent = busy ? '⏳ جاري الإرسال...' : '🤝 إرسال المصنع'; }
  };
  setBtnState(true);

  try {
    const settings = DB.get('settings') || defaultSettings();
    const partners = settings.partners || [];
    const ownerShare = (settings.ownerShare !== undefined && settings.ownerShare !== null && settings.ownerShare !== '')
      ? Number(settings.ownerShare)
      : 100;
    const existingPartnersSum = partners.reduce((sum, p) => sum + (Number(p.sharePercent) || 0), 0);

    if (existingPartnersSum + share > 100) {
      showToast(`❌ مجموع حصص الشركاء يتجاوز 100%: سيصبح ${existingPartnersSum + share}%`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'إضافة'; }
      return;
    }
    const totalAfterAdding = ownerShare + existingPartnersSum + share;
    if (totalAfterAdding > 100) {
      const available = Math.max(0, 100 - ownerShare - existingPartnersSum);
      showToast(`❌ تجاوزت الحد! المتاح للشركاء: ${available}%، المجموع سيصبح ${totalAfterAdding}%`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'إضافة'; }
      return;
    }

    let partnerUid = null;
    const emailLc = email.toLowerCase();
    if (email) {
      try {
        await upsertPartnerInvite({
          email: emailLc,
          name,
          sharePercent: share,
          ownerUid: CURRENT_USER.uid,
          factoryId: CURRENT_FACTORY.id
        });

        // Try multiple query strategies to handle case variations stored in legacy docs
        let userDoc = null;
        // 1. Lowercased email (new canonical)
        let userRes = await fs.collection('users').where('email', '==', emailLc).limit(1).get();
        if (!userRes.empty) userDoc = userRes.docs[0];
        // 2. emailLower field (compat layer)
        if (!userDoc) {
          userRes = await fs.collection('users').where('emailLower', '==', emailLc).limit(1).get();
          if (!userRes.empty) userDoc = userRes.docs[0];
        }
        // 3. Original casing (legacy)
        if (!userDoc) {
          userRes = await fs.collection('users').where('email', '==', email).limit(1).get();
          if (!userRes.empty) userDoc = userRes.docs[0];
        }

        if (userDoc) {
          partnerUid = userDoc.id;

          // Prevent self-partnership
          if (partnerUid === CURRENT_USER.uid) {
            showToast('❌ لا يمكنك إضافة نفسك كشريك', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'إضافة'; }
            return;
          }
        } else {
          // USER NOT FOUND: the invite is already queued above and will link on login/register.
          showToast('⚠️ الحساب بهذا البريد غير موجود حالياً — سيتم ربط هذا المصنع تلقائياً عند تسجيله', 'warning');
        }
      } catch (queryErr) {
        console.error('Firestore email query failed:', queryErr);
        showToast('⚠️ تعذر البحث عن حساب الشريك حالياً، لكن تم حفظ الدعوة وسيظهر المصنع عند دخوله', 'warning');
      }
    }

    partners.push({ id: Date.now(), name, email: emailLc, uid: partnerUid, sharePercent: share });
    settings.partners = partners;
    DB.set('settings', settings);

    // ── ORDER OF OPERATIONS ──
    // 1) Update CURRENT_FACTORY only (partnerUids/partnerShares) and await cloud write.
    // 2) Always queue a partner_link doc scoped to THIS factory — reliable path.
    // 3) Try fast-path: update partner's linkedOwners directly (works if rules allow).
    if (partnerUid) {
      const factories = FactoryDB.getFactories();
      const fIdx = factories.findIndex(f => f.id === CURRENT_FACTORY.id);
      if (fIdx !== -1) {
        const f = factories[fIdx];
        f.partnerUids = f.partnerUids || [];
        if (!f.partnerUids.includes(partnerUid)) f.partnerUids.push(partnerUid);
        f.partnerShares = f.partnerShares || {};
        f.partnerShares[partnerUid] = share;
        if (!f.ownerUid) f.ownerUid = CURRENT_USER.uid;
      }
      try {
        FactoryDB.saveFactories(factories);
        console.log('[Partnership] Factory', CURRENT_FACTORY.id, 'updated on cloud with partner UID', partnerUid);
      } catch (cloudErr) {
        console.error('[Partnership] Cloud factory list write failed:', cloudErr);
      }

      // Queue a partner_link doc scoped to THIS factory. Idempotent by doc ID.
      try {
        const linkDocId = `link_${partnerUid}_${CURRENT_USER.uid}_${CURRENT_FACTORY.id}`;
        await fs.collection('app_data').doc(linkDocId).set({
          type: 'partner_link',
          partnerUid: partnerUid,
          ownerUid: CURRENT_USER.uid,
          factoryId: CURRENT_FACTORY.id,
          sharePercent: share,
          name: name,
          email: emailLc,
          timestamp: Date.now()
        });
        console.log('[Partnership] Queued partner_link doc:', linkDocId);
      } catch (qErr) {
        console.error('[Partnership] Could not queue partner_link doc:', qErr);
      }

      // Fast-path: try direct update (works if rules permit owner-cross-write)
      try {
        const partnerDocRef = fs.collection('users').doc(partnerUid);
        const freshPartnerDoc = await partnerDocRef.get();
        const uData = freshPartnerDoc.exists ? freshPartnerDoc.data() : {};
        const linked = uData.linkedOwners || [];
        if (!linked.includes(CURRENT_USER.uid)) {
          linked.push(CURRENT_USER.uid);
          await partnerDocRef.update({ linkedOwners: linked });
          console.log('[Partnership] Fast-path linkedOwners updated for partner:', partnerUid);
        }
      } catch (linkErr) {
        // Falls back to queue path — partner will self-link on next login
        console.warn('[Partnership] Fast-path blocked — partner will self-link on login. Reason:', linkErr?.message || linkErr);
      }
    }
    
    if (document.getElementById('new-partner-name')) document.getElementById('new-partner-name').value = '';
    if (document.getElementById('new-partner-email')) document.getElementById('new-partner-email').value = '';
    if (document.getElementById('new-partner-share')) document.getElementById('new-partner-share').value = '';
    if (document.getElementById('new-team-partner-name')) document.getElementById('new-team-partner-name').value = '';
    if (document.getElementById('new-team-partner-email')) document.getElementById('new-team-partner-email').value = '';
    if (document.getElementById('new-team-partner-share')) document.getElementById('new-team-partner-share').value = '';
    if (document.getElementById('share-partner-name')) document.getElementById('share-partner-name').value = '';
    if (document.getElementById('share-partner-email')) document.getElementById('share-partner-email').value = '';
    if (document.getElementById('share-partner-share')) document.getElementById('share-partner-share').value = '';
    closeShareFactoryModal();

    renderPartnersSettings();
    renderWorkersPage();
    renderPartnerExpensesInForm();
    addActivity(`تم إضافة الشريك ${name} (حصة ${share}%) إلى ${CURRENT_FACTORY.name}`, '🤝');
    showToast(`✅ تمت إضافة ${name} — سيظهر هذا المصنع في حسابه فور تسجيل الدخول`);
  } catch (err) {
    console.error('Add Partner Error:', err);
    showToast('❌ حدث خطأ أثناء إضافة الشريك', 'error');
  } finally {
    setBtnState(false);
  }
}

async function confirmPartnerSharesFromSettings() {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }

  const nameEl = document.getElementById('new-partner-name');
  const emailEl = document.getElementById('new-partner-email');
  const shareEl = document.getElementById('new-partner-share');
  const ownerShareEl = document.getElementById('farm-owner-share');
  const name = nameEl?.value.trim() || '';
  const email = emailEl?.value.trim() || '';
  const shareRaw = shareEl?.value || '';
  const share = shareRaw !== '' ? Number(shareRaw) : NaN;

  if (!name && !email && shareRaw === '') {
    saveSettings();
    return;
  }

  if (!name) { showToast('يرجى إدخال اسم الشريك', 'error'); return; }
  if (!email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    showToast('أدخل بريد الشريك حتى يظهر المصنع في حسابه', 'error');
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('البريد الإلكتروني للشريك غير صحيح', 'error');
    return;
  }
  if (isNaN(share) || share <= 0 || share > 100) { showToast('نسبة غير صحيحة (1-100)', 'error'); return; }

  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const partnersSum = partners.reduce((sum, p) => sum + (Number(p.sharePercent) || 0), 0);
  let ownerShare = Number(ownerShareEl?.value);
  if (isNaN(ownerShare)) ownerShare = Number(settings.ownerShare);
  if (isNaN(ownerShare)) ownerShare = 100;

  if (ownerShare + partnersSum + share > 100 && ownerShareEl && (ownerShareEl.value === '' || ownerShare === 100)) {
    ownerShare = Math.max(0, 100 - partnersSum - share);
    ownerShareEl.value = ownerShare;
  }

  settings.ownerShare = ownerShare;
  DB.set('settings', settings);
  await addPartner('settings');
}

/* ===================== SHARE FACTORY MODAL ===================== */
function openShareFactoryModal() {
  if (isReadOnlyUser()) {
    showToast('🔒 وضع المشاهدة فقط — لا يمكنك مشاركة المصنع', 'error'); return;
  }
  if (!CURRENT_FACTORY) {
    showToast('⚠️ افتح المصنع أولاً', 'error'); return;
  }
  const modal = document.getElementById('modal-share-factory');
  if (!modal) return;
  // Reset fields each time so stale values don't leak across opens
  ['share-partner-name', 'share-partner-email', 'share-partner-share'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderShareExistingPartners();
  modal.classList.add('open');
  setTimeout(() => document.getElementById('share-partner-name')?.focus(), 200);
}

function closeShareFactoryModal() {
  document.getElementById('modal-share-factory')?.classList.remove('open');
}

function submitShareFactoryFromModal() {
  // addPartner reads from share-partner-* fields when present
  addPartner('modal');
}

/* Render the existing partners list inside the share modal so the user
 * can re-send the factory link to a partner already in their list. */
function renderShareExistingPartners() {
  const section = document.getElementById('share-existing-partners-section');
  const listEl = document.getElementById('share-existing-partners-list');
  if (!section || !listEl) return;

  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const factories = FactoryDB.getFactories();
  const currentFactory = factories.find(f => f.id === CURRENT_FACTORY.id) || {};
  const linkedUids = currentFactory.partnerUids || [];

  if (!partners.length) {
    section.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }
  section.style.display = '';

  listEl.innerHTML = partners.map(p => {
    const isLinked = p.uid && linkedUids.includes(p.uid);
    const hasEmail = !!p.email;
    const statusBadge = isLinked
      ? '<span style="background:rgba(34,197,94,0.15);color:#22c55e;font-size:0.72rem;padding:2px 8px;border-radius:10px;font-weight:700">✓ مُشارَك</span>'
      : '<span style="background:rgba(239,68,68,0.12);color:#ef4444;font-size:0.72rem;padding:2px 8px;border-radius:10px;font-weight:700">— غير مرتبط</span>';
    const actionBtn = hasEmail
      ? `<button class="btn btn-outline btn-resend-partner" data-pid="${p.id}" style="padding:6px 12px;font-size:0.78rem">${isLinked ? '🔁 إعادة الإرسال' : '📤 إرسال الآن'}</button>`
      : '<span style="color:var(--text-muted);font-size:0.75rem">لا يوجد بريد</span>';

    return `
      <div style="background:var(--bg-card-2,rgba(255,255,255,0.03));border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:160px">
          <div style="font-weight:700;font-size:0.92rem">${escapeHtml(p.name)} <span style="color:var(--text-muted);font-weight:400">(${p.sharePercent}%)</span></div>
          <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px">${p.email ? escapeHtml(p.email) : '—'}</div>
          <div style="margin-top:4px">${statusBadge}</div>
        </div>
        ${actionBtn}
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.btn-resend-partner').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = Number(btn.dataset.pid);
      btn.disabled = true;
      btn.textContent = '⏳ جاري الإرسال...';
      try {
        await resyncPartnerLink(pid);
        renderShareExistingPartners();
      } catch (e) {
        console.error('Resend partner error:', e);
        btn.disabled = false;
        btn.textContent = '📤 إرسال الآن';
      }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deletePartner(id) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  if (!confirm('هل تريد حذف هذا الشريك؟')) return;
  const settings = DB.get('settings') || defaultSettings();
  const partnerToDelete = (settings.partners || []).find(p => p.id === id);
  const partners = (settings.partners || []).filter(p => p.id !== id);
  settings.partners = partners;
  DB.set('settings', settings);

  // Remove partner UID from THIS factory only — they may still be a partner
  // in other factories owned by the same owner.
  if (partnerToDelete?.uid && CURRENT_FACTORY) {
    const factories = FactoryDB.getFactories();
    const fIdx = factories.findIndex(f => f.id === CURRENT_FACTORY.id);
    if (fIdx !== -1) {
      const f = factories[fIdx];
      if (f.partnerUids) f.partnerUids = f.partnerUids.filter(uid => uid !== partnerToDelete.uid);
      if (f.partnerShares) delete f.partnerShares[partnerToDelete.uid];
    }
    FactoryDB.saveFactories(factories);

    // Remove the queued partner_link for THIS factory so it can't re-link the partner later.
    try {
      const linkDocId = `link_${partnerToDelete.uid}_${CURRENT_USER.uid}_${CURRENT_FACTORY.id}`;
      fs.collection('app_data').doc(linkDocId).delete().catch(() => {});
    } catch (_) {}

    // Only strip the owner from the partner's linkedOwners if they no longer
    // appear in ANY of this owner's factories.
    const stillPartnerSomewhere = factories.some(f =>
      (f.partnerUids || []).includes(partnerToDelete.uid)
    );
    if (!stillPartnerSomewhere) {
      fs.collection('users').doc(partnerToDelete.uid).get()
        .then(doc => {
          if (doc.exists) {
            const linked = (doc.data().linkedOwners || []).filter(uid => uid !== CURRENT_USER.uid);
            return fs.collection('users').doc(partnerToDelete.uid).update({ linkedOwners: linked });
          }
        })
        .catch(e => console.warn('[Partnership] Could not remove linkedOwner on deletion:', e));
    }
  }

  renderPartnersSettings();
  renderWorkersPage();
  renderPartnerExpensesInForm();
  showToast('تم حذف الشريك — لن يرى المصنع بعد الآن', 'warning');
}

/**
 * Re-link a partner who was added but never got the factory in their account.
 * Useful for partners that were added before the lowercase-email fix, or where
 * the cloud write failed mid-flight.
 *
 * Steps:
 *   1. Re-search for partner by email (lowercase + emailLower + raw casing).
 *   2. If found: stamp their UID into settings.partners, factory.partnerUids,
 *      factory.partnerShares; update partner.linkedOwners.
 *   3. If not found: re-create the cloud invitation document.
 */
async function resyncPartnerLink(partnerId) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const idx = partners.findIndex(p => p.id === partnerId);
  if (idx === -1) { showToast('❌ لم يتم العثور على الشريك', 'error'); return; }
  const p = partners[idx];
  if (!p.email) { showToast('⚠️ هذا الشريك بدون بريد إلكتروني — لا يمكن ربطه', 'warning'); return; }
  if (!CURRENT_FACTORY) { showToast('⚠️ افتح المصنع أولاً ثم أعد المحاولة', 'warning'); return; }

  showToast('🔄 جاري إعادة الربط...', 'info');
  const emailLc = p.email.toLowerCase();

  try {
    // 1) Look up partner's user doc with multiple strategies
    let userDoc = null;
    let res = await fs.collection('users').where('email', '==', emailLc).limit(1).get();
    if (!res.empty) userDoc = res.docs[0];
    if (!userDoc) {
      res = await fs.collection('users').where('emailLower', '==', emailLc).limit(1).get();
      if (!res.empty) userDoc = res.docs[0];
    }
    if (!userDoc) {
      res = await fs.collection('users').where('email', '==', p.email).limit(1).get();
      if (!res.empty) userDoc = res.docs[0];
    }

    if (!userDoc) {
      // No account yet — re-create invitation
      await upsertPartnerInvite({
        email: emailLc,
        name: p.name,
        sharePercent: p.sharePercent,
        ownerUid: CURRENT_USER.uid,
        factoryId: CURRENT_FACTORY.id
      });
      showToast('⚠️ لا يوجد حساب بهذا البريد — أُعيد إرسال الدعوة، ستُربط تلقائياً عند تسجيله', 'warning');
      return;
    }

    const partnerUid = userDoc.id;
    if (partnerUid === CURRENT_USER.uid) {
      showToast('❌ لا يمكنك ربط نفسك كشريك', 'error'); return;
    }

    // 2) Stamp UID on partner record
    partners[idx].uid = partnerUid;
    settings.partners = partners;
    DB.set('settings', settings);

    // 3) Update factory.partnerUids + partnerShares + ownerUid
    const factories = FactoryDB.getFactories();
    const fIdx = factories.findIndex(f => f.id === CURRENT_FACTORY.id);
    if (fIdx !== -1) {
      const pUids = factories[fIdx].partnerUids || [];
      if (!pUids.includes(partnerUid)) pUids.push(partnerUid);
      factories[fIdx].partnerUids = pUids;
      factories[fIdx].partnerShares = factories[fIdx].partnerShares || {};
      factories[fIdx].partnerShares[partnerUid] = p.sharePercent;
      if (!factories[fIdx].ownerUid) factories[fIdx].ownerUid = CURRENT_USER.uid;
      try {
        FactoryDB.saveFactories(factories);
      } catch (e) {
        console.error('[Resync] Cloud factory list write failed:', e);
      }
    }

    // 4) Queue a partner_link doc (the partner self-processes it on next login or live)
    try {
      await upsertPartnerInvite({
        email: emailLc,
        name: p.name,
        sharePercent: p.sharePercent,
        ownerUid: CURRENT_USER.uid,
        factoryId: CURRENT_FACTORY.id
      });
      const linkDocId = `link_${partnerUid}_${CURRENT_USER.uid}_${CURRENT_FACTORY.id}`;
      await fs.collection('app_data').doc(linkDocId).set({
        type: 'partner_link',
        partnerUid: partnerUid,
        ownerUid: CURRENT_USER.uid,
        factoryId: CURRENT_FACTORY.id,
        sharePercent: p.sharePercent,
        name: p.name,
        email: emailLc,
        timestamp: Date.now()
      });
    } catch (e) {
      console.warn('[Resync] could not queue partner_link:', e);
    }

    // 5) Fast-path: also try direct write to partner's linkedOwners
    try {
      const partnerDocRef = fs.collection('users').doc(partnerUid);
      const fresh = await partnerDocRef.get();
      const uData = fresh.exists ? fresh.data() : {};
      const linked = uData.linkedOwners || [];
      if (!linked.includes(CURRENT_USER.uid)) {
        linked.push(CURRENT_USER.uid);
        await partnerDocRef.update({ linkedOwners: linked });
      }
    } catch (e) {
      console.warn('[Resync] linkedOwners direct update failed (fallback to queue):', e);
    }

    renderPartnersList(false);
    addActivity(`تم إعادة ربط الشريك ${p.name}`, '🔄');
    showToast(`✅ تم ربط ${p.name} بالمصنع — سيظهر عنده فوراً (أو عند تسجيل دخوله)`);
  } catch (err) {
    console.error('[Resync] Error:', err);
    showToast('❌ تعذرت إعادة الربط — تحقق من الاتصال', 'error');
  }
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
  if (!tbody) return;   // feed page not present in this build
  const threshold = Number(settings.feedAlertThreshold) || 100;

  let runningBal = Number(settings.initialFeed) || 0;
  let totalIn = 0, totalUsed = 0, totalCost = 0;

  tbody.innerHTML = '';
  const sorted = [...logs].sort((a, b) => parseDateKey(a.date) - parseDateKey(b.date));
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
  const isRestricted = isReadOnlyUser();
  
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
    if (w.isDustWorker) {
      card.style.borderTop = '3px solid #a0826d';
      card.style.background = 'linear-gradient(135deg, rgba(160,130,109,0.06), rgba(255,255,255,0.02))';
    }
    const dustBadge = w.isDustWorker
      ? `<span class="partner-status-badge" style="background:rgba(160,130,109,0.18);color:#d4b895;border:1px solid rgba(160,130,109,0.4);margin-right:6px">💩 عامل الغبار</span>`
      : '';
    const dustToggleBtn = !isRestricted
      ? `<button class="btn btn-outline btn-sm" onclick="toggleDustWorker(${w.id})" title="${w.isDustWorker ? 'إلغاء تعيين عامل الغبار' : 'تعيين كعامل الغبار'}">
           ${w.isDustWorker ? '✖ إلغاء عامل الغبار' : '💩 جعله عامل الغبار'}
         </button>`
      : '';

    card.innerHTML = `
      <div class="worker-header">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="worker-avatar">${w.name.charAt(0)}</div>
          <div>
            <div class="worker-name">${w.name} ${dustBadge}</div>
            <div class="worker-id">#${w.id}</div>
          </div>
        </div>
        ${!isRestricted ? `<button class="btn btn-danger btn-sm" onclick="deleteWorker(${w.id})">حذف</button>` : ''}
      </div>
      <div class="worker-stat"><span>الراتب الشهري</span><strong class="success">${fmt(w.salary, 'دج')}</strong></div>
      <div class="worker-stat"><span>إجمالي السلف</span><strong class="danger">${fmt(totalAdv, 'دج')}</strong></div>
      <div class="worker-stat"><span>الصافي المستحق</span><strong class="${netSalary < 0 ? 'danger' : 'success'}">${fmt(netSalary, 'دج')}</strong></div>
      ${w.isDustWorker ? '<div class="worker-stat" style="font-size:0.78rem;color:#d4b895"><span>📌 ملاحظة</span><span>تُخصم من فائدة الغبار</span></div>' : ''}
      <div class="adv-history">${advHtml}</div>
      <div class="worker-actions" style="display:flex;gap:6px;flex-wrap:wrap">
        ${!isRestricted ? `<button class="btn btn-outline btn-sm" onclick="resetWorkerAdvances(${w.id})">🔄 تصفية السلف</button>` : ''}
        ${dustToggleBtn}
      </div>
    `;
    grid.appendChild(card);
  });
}

function renderPartnersList(isRestricted) {
  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const ownerShare = settings.ownerShare !== undefined ? Number(settings.ownerShare) : 100;
  const ownerName = settings.owner || 'صاحب العمل';
  const container = document.getElementById('partners-list-container');
  if (!container) return;

  const inputStyle = 'width:100%;padding:7px 10px;background:var(--bg-dark);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-family:\'Cairo\',sans-serif;font-size:0.9rem;margin-top:4px;box-sizing:border-box';

  container.innerHTML = `<div class="workers-grid" id="partners-grid-team"></div>`;
  const grid = document.getElementById('partners-grid-team');

  // ── Owner card ──
  const ownerCard = document.createElement('div');
  ownerCard.className = 'worker-card';
  ownerCard.id = 'owner-team-card';
  ownerCard.style.borderTop = '3px solid var(--gold)';
  ownerCard.innerHTML = `
    <div class="worker-header">
      <div style="display:flex;gap:12px;align-items:center">
        <div class="worker-avatar" style="background:linear-gradient(135deg,#d4a017,#a07810);color:white">👔</div>
        <div><div class="worker-name" id="owner-card-name-display">${ownerName}</div><div class="worker-id">صاحب العمل 👔</div></div>
      </div>
      ${!isRestricted ? `<button class="btn btn-outline btn-sm" id="btn-edit-owner" onclick="toggleOwnerEdit()">✏️ تعديل</button>` : ''}
    </div>
    <!-- view mode -->
    <div id="owner-view-mode">
      <div class="worker-stat"><span>نسبة صاحب العمل</span><strong style="color:var(--gold)" id="owner-share-display">${ownerShare}%</strong></div>
    </div>
    <!-- edit mode (hidden by default) -->
    <div id="owner-edit-mode" style="display:none;margin-top:10px">
      <div style="margin-bottom:8px">
        <label style="font-size:0.8rem;color:var(--text-secondary)">اسم صاحب العمل</label>
        <input type="text" id="edit-owner-name" value="${ownerName}" style="${inputStyle}" placeholder="الاسم الكامل" />
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:0.8rem;color:var(--text-secondary)">نسبة صاحب العمل (%)</label>
        <input type="number" id="edit-owner-share" value="${ownerShare}" min="0" max="100" style="${inputStyle}" placeholder="0-100" />
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="saveOwnerEdit()">💾 حفظ</button>
        <button class="btn btn-outline btn-sm" onclick="toggleOwnerEdit()">إلغاء</button>
      </div>
    </div>
  `;
  grid.appendChild(ownerCard);

  if (!partners.length) {
    const emptyNote = document.createElement('div');
    emptyNote.style.cssText = 'grid-column:1/-1;text-align:center;padding:20px 0;color:var(--text-muted);font-size:0.9rem';
    emptyNote.textContent = 'لم يتم إضافة شركاء بعد.';
    grid.appendChild(emptyNote);
    return;
  }


    partners.forEach(p => {
      const card = document.createElement('div');
      card.className = 'worker-card';
      card.id = `partner-team-card-${p.id}`;
      card.style.borderTop = '3px solid var(--blue)';
      const pStatus = p.uid ? '<span class="partner-status-badge status-linked">متصل 🔗</span>' 
                            : (p.email ? '<span class="partner-status-badge status-pending">في الانتظار ⏳</span>' : '');
      card.innerHTML = `
        <div class="worker-header">
          <div style="display:flex;gap:12px;align-items:center">
            <div class="worker-avatar" style="background:var(--blue-gradient);color:white" id="partner-avatar-${p.id}">${p.name.charAt(0)}</div>
            <div>
              <div class="worker-name" id="partner-name-display-${p.id}">${p.name}</div>
              <div class="worker-id">شريك 🤝 ${pStatus}</div>
            </div>
          </div>
          ${!isRestricted ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-outline btn-sm" onclick="togglePartnerEdit(${p.id})">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deletePartner(${p.id})">حذف</button>
            </div>` : ''}
        </div>
        <!-- view mode -->
        <div id="partner-view-${p.id}">
          <div class="worker-stat"><span>نسبة المشاركة</span><strong class="success" id="partner-share-display-${p.id}">${p.sharePercent}%</strong></div>
          <div class="worker-stat" style="font-size:0.8rem"><span>البريد الإلكتروني</span><span style="color:var(--text-muted)">${p.email || '—'}</span></div>
          ${!isRestricted && p.email ? `
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-outline btn-sm" onclick="resyncPartnerLink(${p.id})" title="إعادة محاولة ربط الشريك بالمصنع">
                🔄 إعادة الربط
              </button>
              ${!p.uid ? `<span style="font-size:0.78rem;color:#f6ad55;align-self:center">⚠️ غير مربوط — اضغط إعادة الربط</span>` : ''}
            </div>` : ''}
        </div>
        <!-- edit mode -->
        <div id="partner-edit-${p.id}" style="display:none;margin-top:10px">
          <div style="margin-bottom:8px">
            <label style="font-size:0.8rem;color:var(--text-secondary)">اسم الشريك</label>
            <input type="text" id="edit-partner-name-${p.id}" value="${p.name}" style="${inputStyle}" />
          </div>
          <div style="margin-bottom:10px">
            <label style="font-size:0.8rem;color:var(--text-secondary)">نسبة المشاركة (%)</label>
            <input type="number" id="edit-partner-share-${p.id}" value="${p.sharePercent}" min="1" max="100" style="${inputStyle}" />
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="savePartnerEdit(${p.id})">💾 حفظ</button>
            <button class="btn btn-outline btn-sm" onclick="togglePartnerEdit(${p.id})">إلغاء</button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });

  // Total share summary
  const total = ownerShare + partners.reduce((s, p) => s + Number(p.sharePercent), 0);
  const summaryDiv = document.createElement('div');
  summaryDiv.style.cssText = 'grid-column:1/-1;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-top:4px;border:1px solid rgba(255,255,255,0.07)';
  summaryDiv.innerHTML = `
    <span style="color:var(--text-secondary);font-size:0.9rem">مجموع الحصص (صاحب العمل + الشركاء)</span>
    <strong style="color:${total === 100 ? 'var(--green)' : 'var(--red)'};font-size:1.05rem">${total}%</strong>
  `;
  grid.appendChild(summaryDiv);
}

function toggleOwnerEdit() {
  const viewEl = document.getElementById('owner-view-mode');
  const editEl = document.getElementById('owner-edit-mode');
  const btn    = document.getElementById('btn-edit-owner');
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? '' : 'none';
  editEl.style.display = isEditing ? 'none' : 'block';
  if (btn) btn.textContent = isEditing ? '✏️ تعديل' : 'إلغاء';
}

function saveOwnerEdit() {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  const newName  = document.getElementById('edit-owner-name')?.value.trim() || '';
  const newShare = Number(document.getElementById('edit-owner-share')?.value);
  if (!newName) { showToast('أدخل اسم صاحب العمل', 'error'); return; }
  if (isNaN(newShare) || newShare < 0 || newShare > 100) { showToast('نسبة غير صحيحة (0-100)', 'error'); return; }

  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const partnersSum = partners.reduce((s, p) => s + Number(p.sharePercent), 0);
  if (newShare + partnersSum > 100) {
    showToast(`❌ المجموع سيكون ${newShare + partnersSum}% — يجب أن يساوي 100%`, 'error'); return;
  }

  settings.owner      = newName;
  settings.ownerShare = newShare;
  DB.set('settings', settings);

  // Update display without full re-render
  const nameDisplay  = document.getElementById('owner-card-name-display');
  const shareDisplay = document.getElementById('owner-share-display');
  if (nameDisplay)  nameDisplay.textContent  = newName;
  if (shareDisplay) shareDisplay.textContent = newShare + '%';
  toggleOwnerEdit();
  renderPartnersSettings();
  renderPartnerExpensesInForm();
  addActivity(`تم تعديل بيانات صاحب العمل: ${newName} (${newShare}%)`, '👔');
  showToast('✅ تم حفظ بيانات صاحب العمل');
}

function togglePartnerEdit(id) {
  const viewEl = document.getElementById(`partner-view-${id}`);
  const editEl = document.getElementById(`partner-edit-${id}`);
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? '' : 'none';
  editEl.style.display = isEditing ? 'none' : 'block';
}

function savePartnerEdit(id) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  const newName  = document.getElementById(`edit-partner-name-${id}`)?.value.trim() || '';
  const newShare = Number(document.getElementById(`edit-partner-share-${id}`)?.value);
  if (!newName) { showToast('أدخل اسم الشريك', 'error'); return; }
  if (isNaN(newShare) || newShare <= 0 || newShare > 100) { showToast('نسبة غير صحيحة (1-100)', 'error'); return; }

  const settings = DB.get('settings') || defaultSettings();
  const partners = settings.partners || [];
  const ownerShare = settings.ownerShare !== undefined ? Number(settings.ownerShare) : 100;

  // Sum of all OTHER partners
  const othersSum = partners.filter(p => p.id !== id).reduce((s, p) => s + Number(p.sharePercent), 0);
  if (ownerShare + othersSum + newShare > 100) {
    const available = Math.max(0, 100 - ownerShare - othersSum);
    showToast(`❌ النسبة المتاحة لهذا الشريك: ${available}%`, 'error'); return;
  }

  const idx = partners.findIndex(p => p.id === id);
  if (idx === -1) return;
  
  const oldPartner = partners[idx];
  partners[idx] = { ...oldPartner, name: newName, sharePercent: newShare };
  settings.partners = partners;
  DB.set('settings', settings);

  // If already linked, update the factory list metadata too
  if (oldPartner.uid && CURRENT_FACTORY) {
    const factories = FactoryDB.getFactories();
    const fIdx = factories.findIndex(f => f.id === CURRENT_FACTORY.id);
    if (fIdx !== -1) {
      factories[fIdx].partnerShares = factories[fIdx].partnerShares || {};
      factories[fIdx].partnerShares[oldPartner.uid] = newShare;
      FactoryDB.saveFactories(factories);
    }
  }

  // Update display without full re-render
  const nameDisplay  = document.getElementById(`partner-name-display-${id}`);
  const shareDisplay = document.getElementById(`partner-share-display-${id}`);
  const avatarEl     = document.getElementById(`partner-avatar-${id}`);
  if (nameDisplay)  nameDisplay.textContent  = newName;
  if (shareDisplay) shareDisplay.textContent = newShare + '%';
  if (avatarEl)     avatarEl.textContent     = newName.charAt(0);
  togglePartnerEdit(id);
  renderPartnersSettings();
  renderPartnerExpensesInForm();
  addActivity(`تم تعديل بيانات الشريك: ${newName} (${newShare}%)`, '🤝');
  showToast(`✅ تم حفظ بيانات ${newName}`);
}

document.addEventListener('click', function (e) {
  if (e.target.classList.contains('btn-remove-adv')) {
    e.target.closest('.advance-row')?.remove();
  }
});

function deleteLogById(logId) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
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

function toggleDustWorker(id) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }
  const workers = DB.get('workers') || [];
  const w = workers.find(wk => wk.id === id);
  if (!w) return;
  const willBeDust = !w.isDustWorker;
  if (willBeDust) {
    // Only one dust worker at a time
    workers.forEach(wk => { wk.isDustWorker = false; });
    w.isDustWorker = true;
    addActivity(`تم تعيين ${w.name} كعامل الغبار 💩`, '👷');
    showToast(`💩 ${w.name} هو الآن عامل الغبار`);
  } else {
    w.isDustWorker = false;
    addActivity(`تم إلغاء تعيين ${w.name} كعامل الغبار`, '👷');
    showToast('تم إلغاء تعيين عامل الغبار');
  }
  DB.set('workers', workers);
  renderWorkersPage();
}

function resetWorkerAdvances(id) {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
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

function renderReportCurves(reportLogs) {
  const card = document.getElementById('report-curves-card');
  const button = document.getElementById('btn-show-report-curves');
  const select = document.getElementById('report-curve-metric');
  const canvas = document.getElementById('report-curves-canvas');
  const details = document.getElementById('report-curve-details');
  const zoomOut = document.getElementById('report-curve-zoom-out');
  const zoomIn = document.getElementById('report-curve-zoom-in');
  const zoomReset = document.getElementById('report-curve-zoom-reset');
  const zoomLabel = document.getElementById('report-curve-zoom-label');
  if (!card || !button || !select || !canvas) return;

  if (!Number.isFinite(window._reportCurveZoom)) window._reportCurveZoom = 1;

  const ordered = (reportLogs || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const soldFor = l => (Number(l.soldEggs ?? l.soldTotal ?? 0) ||
    ((Number(l.soldGroups) || 0) * 12 + (Number(l.soldSingle) || 0))) +
    (Number(l.brokenEggs ?? l.broken) || 0);
  const pointsFor = metric => {
    let runningProduced = 0;
    let runningSold = 0;
    return ordered.map(l => {
      runningProduced += Number(l.produced) || 0;
      runningSold += soldFor(l);
      const values = {
        produced: Number(l.produced) || 0,
        dead: Number(l.dead) || 0,
        price: Number(l.price) || 0,
        income: (Number(l.income) || 0) + (Number(l.specialIncome) || 0),
        sold: soldFor(l),
        feedUsed: Number(l.feedUsed) || 0,
        remaining: Math.max(0, (Number(l.totalProduction) || runningProduced) - runningSold)
      };
      return { date: l.date, value: Math.max(0, values[metric] || 0) };
    });
  };
  const labels = {
    produced: 'الإنتاج', dead: 'النفوق', price: 'سعر البيع', income: 'المدخول',
    sold: 'البيض المباع والمكسور', feedUsed: 'الشعير المستهلك', remaining: 'البيض المتبقي'
  };
  const colors = { produced: '#f5c518', dead: '#fc8181', price: '#63b3ed', income: '#48bb78', sold: '#b794f4', feedUsed: '#f6ad55', remaining: '#4ade80' };

  const draw = () => {
    const metric = select.value || 'produced';
    const points = pointsFor(metric);
    const zoom = Math.max(0.7, Math.min(2.4, Number(window._reportCurveZoom) || 1));
    const containerWidth = Math.max(320, Math.floor(canvas.parentElement?.clientWidth || 700));
    // Give every day a readable horizontal slot. The wrapper scrolls only when
    // needed, so zooming never forces the labels to overlap.
    const width = Math.max(containerWidth, Math.floor(Math.max(48, 48 * zoom) * Math.max(points.length, 8)));
    const height = Math.floor(330 * zoom);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const pad = { left: 56, right: 18, top: 22, bottom: 48 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...points.map(p => p.value));
    const color = colors[metric] || '#f5c518';
    ctx.font = '12px Cairo, sans-serif';
    ctx.direction = 'rtl';
    ctx.strokeStyle = 'rgba(148,163,184,.16)';
    ctx.fillStyle = '#8fa4c1';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + plotH - (plotH * i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(fmt(Math.round(max * i / 4)), pad.left - 8, y + 4);
    }
    if (!points.length) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#8fa4c1'; ctx.fillText('لا توجد بيانات للرسم', width / 2, height / 2);
      if (details) details.innerHTML = '<span>لا توجد سجلات يومية متاحة.</span>';
      return;
    }
    const step = points.length > 1 ? plotW / (points.length - 1) : plotW / 2;
    const xAt = i => points.length > 1 ? pad.left + step * i : pad.left + plotW / 2;
    const yAt = v => pad.top + plotH - (v / max) * plotH;
    const barW = Math.max(3, Math.min(24, plotW / Math.max(points.length * 2, 8)));
    ctx.fillStyle = `${color}22`;
    points.forEach((p, i) => ctx.fillRect(xAt(i) - barW / 2, yAt(p.value), barW, pad.top + plotH - yAt(p.value)));
    ctx.beginPath();
    points.forEach((p, i) => { const x = xAt(i), y = yAt(p.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    points.forEach((p, i) => { ctx.beginPath(); ctx.arc(xAt(i), yAt(p.value), 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); });
    ctx.fillStyle = '#8fa4c1'; ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(4, Math.floor(plotW / 78))));
    const shortDate = value => {
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return match ? `${match[3]}/${match[2]}` : fmtDate(value);
    };
    points.forEach((p, i) => { if (i % labelEvery === 0 || i === points.length - 1) ctx.fillText(shortDate(p.date), xAt(i), height - 18); });
    const values = points.map(p => p.value);
    const total = values.reduce((s, v) => s + v, 0);
    const average = values.length ? total / values.length : 0;
    if (details) details.innerHTML = `<span class="curve-detail-title" style="color:${color}">${labels[metric]}</span><span>أعلى قيمة: <b>${fmt(Math.max(...values))}</b></span><span>المتوسط اليومي: <b>${fmt(Math.round(average))}</b></span><span>عدد الأيام: <b>${fmt(values.length)}</b></span>`;
  };
  button.onclick = () => {
    const opening = card.hidden;
    card.hidden = !opening;
    button.textContent = opening ? '📉 إخفاء المنحنيات' : '📈 عرض المنحنيات';
    if (opening) requestAnimationFrame(draw);
  };
  select.onchange = draw;
  const updateZoom = amount => {
    window._reportCurveZoom = Math.max(0.7, Math.min(2.4, Number(amount) || 1));
    if (zoomLabel) zoomLabel.textContent = `${Math.round(window._reportCurveZoom * 100)}%`;
    if (!card.hidden) requestAnimationFrame(draw);
  };
  zoomOut.onclick = () => updateZoom((window._reportCurveZoom || 1) - 0.2);
  zoomIn.onclick = () => updateZoom((window._reportCurveZoom || 1) + 0.2);
  zoomReset.onclick = () => updateZoom(1);
  if (zoomLabel) zoomLabel.textContent = `${Math.round(window._reportCurveZoom * 100)}%`;
  if (!card.hidden) requestAnimationFrame(draw);
}

/* ---------------- حساب الفائدة (سعر بيع البيض − تكلفة الشعير) ---------------- */
function renderProfitCalculator(stats) {
  const wrap = document.getElementById('profit-summary');
  const priceInput = document.getElementById('inp-egg-sale-price');
  const feedInput = document.getElementById('inp-barley-price-kg');
  const reformeInput = document.getElementById('inp-reforme-price');
  const reformeField = document.getElementById('reforme-price-field');
  const reformeBtn = document.getElementById('btn-reforme');
  const reformeStatus = document.getElementById('reforme-status');
  if (!wrap || !priceInput || !feedInput) return;

  const settings = DB.get('settings') || defaultSettings();
  const readOnly = isReadOnlyUser();
  // Do not fight the user while they are typing in the field.
  if (document.activeElement !== priceInput) priceInput.value = Number(settings.eggSalePrice) > 0 ? settings.eggSalePrice : '';
  if (document.activeElement !== feedInput) feedInput.value = Number(settings.barleyPricePerKg) > 0 ? settings.barleyPricePerKg : '';
  if (reformeInput && document.activeElement !== reformeInput) {
    reformeInput.value = Number(settings.reformeChickenPrice) > 0 ? settings.reformeChickenPrice : '';
  }
  priceInput.disabled = readOnly;
  feedInput.disabled = readOnly;
  if (reformeInput) reformeInput.disabled = readOnly;
  if (reformeBtn) reformeBtn.style.display = readOnly ? 'none' : '';

  const soldRegular = Number(stats.soldRegular) || 0;
  const soldSpecial = Number(stats.soldSpecial) || 0;
  const soldPlates = soldRegular + soldSpecial;
  const feedBoughtKg = Number(stats.feedBoughtKg) || 0;
  const initialChickens = Number(stats.initialChickens) || 0;
  const remainingChickens = Number(stats.remainingChickens) || 0;
  const chickenBuyPrice = Number(settings.chickenPrice) || 0;
  let reformeActive = !!settings.reformeActive;

  const paintReformeUI = () => {
    if (reformeField) reformeField.hidden = !reformeActive;
    if (reformeBtn) {
      reformeBtn.textContent = reformeActive
        ? '↩️ إلغاء الروفورم — إعادة فتح المصنع'
        : '🐔 الروفورم — إغلاق المصنع وبيع الدجاج';
      reformeBtn.classList.toggle('reforme-on', reformeActive);
    }
    if (reformeStatus) {
      reformeStatus.textContent = reformeActive
        ? `🔒 المصنع مغلق — تم بيع ${fmt(remainingChickens)} دجاجة${settings.reformeDate ? ' بتاريخ ' + fmtDate(settings.reformeDate) : ''}`
        : '';
    }
  };

  const paint = () => {
    const price = Number(priceInput.value) || 0;
    const feedPricePerKg = Number(feedInput.value) || 0;
    const reformePrice = reformeInput ? (Number(reformeInput.value) || 0) : 0;

    const eggIncome = soldPlates * price;
    // الروفورم: الدجاجات المتبقية تُباع ويُضاف مدخولها إلى الفائدة
    const reformeIncome = reformeActive ? remainingChickens * reformePrice : 0;
    // Barley is costed on what was bought (العلف الداخل), not on consumption.
    const barleyCost = feedBoughtKg * feedPricePerKg;
    const chickensCost = initialChickens * chickenBuyPrice;
    const profit = eggIncome + reformeIncome - barleyCost - chickensCost;
    const profitColor = profit >= 0 ? 'var(--green)' : 'var(--red)';
    const hasAnyPrice = price > 0 || feedPricePerKg > 0 || reformePrice > 0 || chickenBuyPrice > 0;

    wrap.innerHTML = `
      <div class="report-stat"><div class="rs-val">${fmt(soldRegular)}</div><div class="rs-lbl">البلاكات المباعة (عادي)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(soldSpecial)}</div><div class="rs-lbl">البلاكات المباعة (خاص) ⭐</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(soldPlates)}</div><div class="rs-lbl">إجمالي البلاكات المباعة</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--green)">${price > 0 ? fmt(eggIncome, 'دج') : '—'}</div><div class="rs-lbl">مدخول البيض</div></div>
      <div class="report-stat" style="border-color:rgba(183,148,244,0.35)"><div class="rs-val" style="color:#b794f4">${fmt(remainingChickens)}</div><div class="rs-lbl">🐔 الدجاجات المتبقية</div></div>
      ${reformeActive ? `<div class="report-stat" style="border-color:rgba(72,187,120,0.4)"><div class="rs-val" style="color:var(--green)">${reformePrice > 0 ? fmt(reformeIncome, 'دج') : '—'}</div><div class="rs-lbl">🐔 مدخول الروفورم</div></div>` : ''}
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(feedBoughtKg, 'كغ')}</div><div class="rs-lbl">الشعير الداخل (المشترى)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${feedPricePerKg > 0 ? fmt(barleyCost, 'دج') : '—'}</div><div class="rs-lbl">تكلفة شراء الشعير</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${chickenBuyPrice > 0 ? fmt(chickensCost, 'دج') : '—'}</div><div class="rs-lbl">تكلفة شراء الدجاج الابتدائي</div></div>
      <div class="report-stat" style="border-color:${profit >= 0 ? 'rgba(72,187,120,0.4)' : 'rgba(252,129,129,0.4)'}">
        <div class="rs-val" style="color:${profitColor}">${hasAnyPrice ? fmt(profit, 'دج') : '—'}</div>
        <div class="rs-lbl">💹 الفائدة الصافية</div></div>`;
  };

  const persist = () => {
    if (readOnly) return;
    const current = DB.get('settings') || defaultSettings();
    current.eggSalePrice = Number(priceInput.value) || 0;
    current.barleyPricePerKg = Number(feedInput.value) || 0;
    if (reformeInput) current.reformeChickenPrice = Number(reformeInput.value) || 0;
    current.reformeActive = reformeActive;
    if (reformeActive && !current.reformeDate) current.reformeDate = todayStr();
    if (!reformeActive) current.reformeDate = null;
    settings.reformeDate = current.reformeDate;
    DB.set('settings', current);
  };

  // Assignment (not addEventListener) so re-rendering the page never stacks handlers.
  priceInput.oninput = paint;
  feedInput.oninput = paint;
  priceInput.onchange = () => { paint(); persist(); };
  feedInput.onchange = () => { paint(); persist(); };
  if (reformeInput) {
    reformeInput.oninput = paint;
    reformeInput.onchange = () => { paint(); persist(); };
  }
  if (reformeBtn) {
    reformeBtn.onclick = () => {
      if (readOnly) { showToast('🔒 وضع المشاهدة فقط', 'error'); return; }
      if (!reformeActive) {
        if (!confirm(`تأكيد الروفورم: سيُعتبر المصنع مغلقاً وأن الدجاجات المتبقية (${fmt(remainingChickens)}) قد بيعت. هل تريد المتابعة؟`)) return;
        reformeActive = true;
        paintReformeUI();
        persist();
        paint();
        showToast('🐔 تم تفعيل الروفورم — أدخل سعر الدجاجة الواحدة', 'success');
        if (reformeInput) reformeInput.focus();
      } else {
        if (!confirm('إلغاء الروفورم وإعادة فتح المصنع؟ سيُحذف مدخول بيع الدجاج من الفائدة.')) return;
        reformeActive = false;
        paintReformeUI();
        persist();
        paint();
        showToast('↩️ تم إلغاء الروفورم', 'warning');
      }
    };
  }

  paintReformeUI();
  paint();
}

/* ===================== REPORTS PAGE ===================== */
function renderReportsPage() {
  // Stable report renderer for imported Excel data.  Keep this path isolated
  // from legacy report widgets so one malformed historical row cannot crash
  // navigation to the reports page.
  {
    const reportLogs = (DB.get('daily_logs') || []).filter(l => l && typeof l === 'object' && l.date);
    const saleWithBreakage = l =>
      (l.soldEggs !== undefined ? Number(l.soldEggs) : Number(l.soldTotal) ||
        ((Number(l.soldGroups) || 0) * 12 + (Number(l.soldSingle) || 0))) +
      (Number(l.brokenEggs) || Number(l.broken) || 0);
    const totalProduced = reportLogs.reduce((s, l) => s + (Number(l.produced) || 0), 0);
    const totalSold = reportLogs.reduce((s, l) => s + saleWithBreakage(l), 0);
    const totalBroken = reportLogs.reduce((s, l) => s + (Number(l.brokenEggs) || Number(l.broken) || 0), 0);
    const totalNet = reportLogs.reduce((s, l) => s + (Number(l.netEggs) || Math.max(0, (Number(l.produced) || 0) - (Number(l.brokenEggs) || Number(l.broken) || 0))), 0);
    const totalKartons = reportLogs.reduce((s, l) => s + (Number(l.soldGroups) || 0), 0);
    const totalSpecial = reportLogs.reduce((s, l) => s + (Number(l.specialEggs) || 0), 0);
    const totalSpecialSold = reportLogs.reduce((s, l) => s + (Number(l.specialSold) || 0), 0);
    const totalFeedIn = reportLogs.reduce((s, l) => s + (Number(l.feedIn) || 0), 0);
    const totalFeedUsed = reportLogs.reduce((s, l) => s + (Number(l.feedUsed) || 0), 0);
    const totalDead = reportLogs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
    const cumulative = reportLogs.reduce((m, l) => Math.max(m, Number(l.totalProduction) || 0), 0);
    const nowKey = todayStr().slice(0, 7);
    const monthLogs = reportLogs.filter(l => String(l.date).slice(0, 7) === nowKey);
    const monthProduced = monthLogs.reduce((s, l) => s + (Number(l.produced) || 0), 0);
    const monthSold = monthLogs.reduce((s, l) => s + saleWithBreakage(l), 0);
    const monthKartons = monthLogs.reduce((s, l) => s + (Number(l.soldGroups) || 0), 0);
    const monthSpecial = monthLogs.reduce((s, l) => s + (Number(l.specialEggs) || 0), 0);
    const monthSpecialSold = monthLogs.reduce((s, l) => s + (Number(l.specialSold) || 0), 0);
    const monthFeedUsed = monthLogs.reduce((s, l) => s + (Number(l.feedUsed) || 0), 0);
    const monthDead = monthLogs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
    const monthCumulative = monthLogs.reduce((m, l) => Math.max(m, Number(l.totalProduction) || 0), 0);
    const monthRemaining = Math.max(0, (monthCumulative || monthProduced) - monthSold);
    // The current stock belongs to the latest period.  Do not subtract
    // historical months' sales from the latest month's cumulative balance.
    const remaining = monthRemaining;
    const totalSummary = document.getElementById('total-summary');
    const monthSummary = document.getElementById('monthly-summary');
    const specialRemaining = Math.max(0, totalSpecial - totalSpecialSold);
    const monthSpecialRemaining = Math.max(0, monthSpecial - monthSpecialSold);
    // الدجاجات المتبقية = الابتدائي − مجموع النفوق
    const reportSettings = DB.get('settings') || defaultSettings();
    const initialChickens = Number(reportSettings.initialChickens) || 0;
    const remainingChickens = Math.max(0, initialChickens - totalDead);
    if (totalSummary) totalSummary.innerHTML = `
      <div class="report-stat"><div class="rs-val">${fmt(reportLogs.length)}</div><div class="rs-lbl">إجمالي الأيام</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalProduced)}</div><div class="rs-lbl">إجمالي المنتج (بلاكة)</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalNet)}</div><div class="rs-lbl">إجمالي الصافي</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalKartons)}</div><div class="rs-lbl">إجمالي الكرطونات</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--green)">${fmt(totalSold)}</div><div class="rs-lbl">المبيعات (المباع والمكسور)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(totalSpecial)}</div><div class="rs-lbl">بيض خاص ⭐</div></div>
      <div class="report-stat"><div class="rs-val" style="color:#4ade80">${fmt(remaining)}</div><div class="rs-lbl">البيض المتبقي العادي</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(totalSpecialSold)}</div><div class="rs-lbl">مبيعات البيض الخاص</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(specialRemaining)}</div><div class="rs-lbl">المتبقي من الخاص</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalFeedIn)}</div><div class="rs-lbl">العلف الداخل (كغ)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalFeedUsed)}</div><div class="rs-lbl">العلف المستهلك (كغ)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalBroken)}</div><div class="rs-lbl">إجمالي المكسور</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalDead)}</div><div class="rs-lbl">إجمالي النفوق</div></div>
      <div class="report-stat" style="border-color:rgba(183,148,244,0.35)"><div class="rs-val" style="color:#b794f4">${fmt(remainingChickens)}</div><div class="rs-lbl">🐔 الدجاجات المتبقية</div></div>`;
    if (monthSummary) monthSummary.innerHTML = `
      <div class="report-stat"><div class="rs-val">${fmt(monthProduced)}</div><div class="rs-lbl">المنتج هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(monthKartons)}</div><div class="rs-lbl">الكرطونات هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--green)">${fmt(monthSold)}</div><div class="rs-lbl">مبيعات الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:#4ade80">${fmt(monthRemaining)}</div><div class="rs-lbl">البيض المتبقي العادي</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(monthSpecialSold)}</div><div class="rs-lbl">مبيعات الخاص هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(monthSpecialRemaining)}</div><div class="rs-lbl">المتبقي من الخاص</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(monthFeedUsed)}</div><div class="rs-lbl">الاستهلاك هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(monthDead)}</div><div class="rs-lbl">النفوق هذا الشهر</div></div>`;
    const tbody = document.getElementById('unified-tbody');
    if (tbody) {
      tbody.innerHTML = reportLogs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(l => `
        <tr><td>${fmtDate(l.date)}</td><td>${fmt(l.produced)}</td><td>${fmt(l.soldGroups)}</td>
        <td>${fmt(l.soldSingle)}</td><td style="color:var(--red)">${fmt(l.brokenEggs ?? l.broken)}</td>
        <td style="color:var(--green)">${fmt(l.soldEggs ?? l.soldTotal ?? 0)}</td>
        <td style="color:var(--gold)">${fmt(l.specialEggs ?? 0)}</td><td>${fmt(l.dead)}</td>
        <td>${fmt(l.feedIn)}</td><td>${fmt(l.feedUsed)}</td><td>${l.notes || '—'}</td><td>—</td></tr>`).join('') ||
        '<tr><td colspan="12" class="empty-cell">لا توجد سجلات</td></tr>';
    }
    renderReportCurves(reportLogs);
    renderProfitCalculator({
      soldRegular: Math.max(0, totalSold - totalBroken),
      soldSpecial: totalSpecialSold,
      feedBoughtKg: totalFeedIn,
      initialChickens,
      remainingChickens
    });
    return;
  }

  // === Inject fresh CSS for report-grid (bypasses any cached stylesheet) ===
  (function() {
    var old = document.getElementById('__report-grid-style__');
    if (old) old.remove();
    var s = document.createElement('style');
    s.id = '__report-grid-style__';
    s.textContent = `
      .report-grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)) !important;
        gap: 12px !important;
        width: 100% !important;
        box-sizing: border-box !important;
        overflow: visible !important;
      }
      .report-stat {
        background: var(--bg-card2, #1a2035) !important;
        border-radius: 10px !important;
        border: 1px solid var(--border, rgba(255,255,255,0.08)) !important;
        padding: 14px 10px !important;
        text-align: center !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      .report-stat .rs-val {
        font-size: 1.15rem !important;
        font-weight: 900 !important;
        color: var(--gold, #f5c518) !important;
        word-break: break-all !important;
      }
      .report-stat .rs-lbl {
        font-size: 0.74rem !important;
        color: var(--text-secondary, #8899aa) !important;
        margin-top: 4px !important;
        line-height: 1.3 !important;
      }
    `;
    document.head.appendChild(s);
  })();

  const logs = (DB.get('daily_logs') || []).filter(l => l && typeof l === 'object');
  
  // === 1. Total Summary (All Time) ===
  const totalDays = logs.length;
  const totalProduced = logs.reduce((s, l) => s + (Number(l.produced) || 0), 0);
  const totalBroken = logs.reduce((s, l) => s + (Number(l.broken) || 0), 0);
  const totalNet = logs.reduce((s, l) => s + (Number(l.netEggs) || 0), 0);
  const totalKartons = logs.reduce((s, l) => s + (Number(l.soldGroups) || 0), 0);
  const totalDead = logs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
  const totalFeedIn = logs.reduce((s, l) => s + (Number(l.feedIn) || 0), 0);
  const totalFeedUsed = logs.reduce((s, l) => s + (Number(l.feedUsed) || 0), 0);
  // The spreadsheet's "egg sales" column includes both sold and broken
  // eggs.  Keep the two fields for daily detail, but use their combined
  // quantity for stock and all-time/monthly summaries.
  const totalSoldEggs = logs.reduce((s, l) => s +
    (Number(l.soldEggs) || Number(l.income) || 0) + (Number(l.brokenEggs) || Number(l.broken) || 0), 0);
  const totalSpecial = logs.reduce((s, l) => s + (Number(l.specialEggs) || ((Number(l.specialPlates)||0)*30 + (Number(l.specialSingles)||0)) || 0), 0);
  // البيض المتبقي = المنتج - المكسور - المباع - المجاني
  // Imported workbooks carry an opening balance in totalProduction.  The
  // remaining stock is that cumulative balance less the combined sales and
  // breakage, not the sum of daily production alone.
  const cumulativeProduction = logs.reduce((max, l) => Math.max(max, Number(l.totalProduction) || 0), 0);
  const remainingBase = cumulativeProduction > 0 ? cumulativeProduction : totalProduced;
  const totalRemaining = Math.max(0, remainingBase - totalSoldEggs);
  const totalSpecialSold = logs.reduce((s, l) => s + (Number(l.specialSold) || 0), 0);
  const totalRemainingSpecial = Math.max(0, totalSpecial - totalSpecialSold);

  const totalSummary = document.getElementById('total-summary');
  if (totalSummary) {
    totalSummary.innerHTML = `
      <div class="report-stat"><div class="rs-val">${totalDays}</div><div class="rs-lbl">إجمالي الأيام</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalProduced)}</div><div class="rs-lbl">إجمالي المنتج (بلاكة)</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalNet)}</div><div class="rs-lbl">إجمالي الصافي (بلاكة)</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(totalKartons)}</div><div class="rs-lbl">إجمالي الكرطونات</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--green)">${fmt(totalSoldEggs)}</div><div class="rs-lbl">المبيعات (بلاكة)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(totalSpecial)}</div><div class="rs-lbl">بيض خاص ⭐</div></div>
      <div class="report-stat" style="border-color:rgba(100,220,130,0.35)"><div class="rs-val" style="color:#4ade80">${fmt(totalRemaining)}</div><div class="rs-lbl">🥚 البيض المتبقي (عادي)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(totalSpecialSold)}</div><div class="rs-lbl">🌟 مبيعات البيض الخاص</div></div>
      <div class="report-stat" style="border-color:rgba(255,215,0,0.3)"><div class="rs-val" style="color:var(--gold)">${fmt(totalRemainingSpecial)}</div><div class="rs-lbl">🌟 المتبقي من الخاص</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalFeedIn)}</div><div class="rs-lbl">العلف الداخل (كغ)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(totalFeedUsed)}</div><div class="rs-lbl">العلف المستهلك (كغ)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalBroken)}</div><div class="rs-lbl">إجمالي المكسور</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(totalDead)}</div><div class="rs-lbl">إجمالي النفوق</div></div>
    `;
  }

  // === 2. Monthly Summary ===
  const now = new Date();
  const monthLogs = logs.filter(l => {
    if (!l.date) return false;
    // Handle YYYY-MM-DD reliably
    const [y, m, d] = l.date.split('-');
    if (y && m) {
      return parseInt(m, 10) === now.getMonth() + 1 && parseInt(y, 10) === now.getFullYear();
    }
    return false;
  });

  const mProduced = monthLogs.reduce((s, l) => s + (Number(l.produced) || 0), 0);
  const mBroken = monthLogs.reduce((s, l) => s + (Number(l.broken) || 0), 0);
  const mNet = monthLogs.reduce((s, l) => s + (Number(l.netEggs) || 0), 0);
  const mKartons = monthLogs.reduce((s, l) => s + (Number(l.soldGroups) || 0), 0);
  const mDead = monthLogs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
  const mFeedIn = monthLogs.reduce((s, l) => s + (Number(l.feedIn) || 0), 0);
  const mFeedUsed = monthLogs.reduce((s, l) => s + (Number(l.feedUsed) || 0), 0);
  const mSoldEggs = monthLogs.reduce((s, l) => s +
    (Number(l.soldEggs) || Number(l.income) || 0) + (Number(l.brokenEggs) || Number(l.broken) || 0), 0);
  const mSpecial = monthLogs.reduce((s, l) => s + (Number(l.specialEggs) || ((Number(l.specialPlates)||0)*30 + (Number(l.specialSingles)||0)) || 0), 0);
  const monthCumulativeProduction = monthLogs.reduce((max, l) => Math.max(max, Number(l.totalProduction) || 0), 0);
  const mRemainingBase = monthCumulativeProduction > 0 ? monthCumulativeProduction : mProduced;
  const mRemaining = Math.max(0, mRemainingBase - mSoldEggs);
  const mSpecialSold = monthLogs.reduce((s, l) => s + (Number(l.specialSold) || 0), 0);
  const mRemainingSpecial = Math.max(0, mSpecial - mSpecialSold);

  const monthSummary = document.getElementById('monthly-summary');
  if (monthSummary) {
    monthSummary.innerHTML = `
      <div class="report-stat"><div class="rs-val">${fmt(mProduced)}</div><div class="rs-lbl">المنتج هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val">${fmt(mKartons)}</div><div class="rs-lbl">الكرطونات هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--green)">${fmt(mSoldEggs)}</div><div class="rs-lbl">مبيعات الشهر</div></div>
      <div class="report-stat" style="border-color:rgba(100,220,130,0.35)"><div class="rs-val" style="color:#4ade80">${fmt(mRemaining)}</div><div class="rs-lbl">🥚 البيض المتبقي (عادي)</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--gold)">${fmt(mSpecialSold)}</div><div class="rs-lbl">🌟 مبيعات الخاص (الشهر)</div></div>
      <div class="report-stat" style="border-color:rgba(255,215,0,0.3)"><div class="rs-val" style="color:var(--gold)">${fmt(mRemainingSpecial)}</div><div class="rs-lbl">🌟 المتبقي من الخاص</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--orange)">${fmt(mFeedUsed)}</div><div class="rs-lbl">الاستهلاك هذا الشهر</div></div>
      <div class="report-stat"><div class="rs-val" style="color:var(--red)">${fmt(mDead)}</div><div class="rs-lbl">النفوق هذا الشهر</div></div>
    `;
  }

  // === 3. Unified Table (with missing date fill) ===
  const tbody = document.getElementById('unified-tbody');
  if (tbody) {
    // Build a map of existing logs by date
    const logByDate = {};
    logs.forEach(l => { if (l.date) logByDate[l.date] = l; });

    // Generate all dates from first log to today
    let allDates = [];
    if (logs.length > 0) {
      const firstDate = parseDateKey(logs.reduce((mn, l) => (!mn || l.date < mn) ? l.date : mn, null));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let d = new Date(firstDate); d <= today; d.setDate(d.getDate() + 1)) {
        allDates.push(dateKeyLocal(d));
      }
    }
    allDates.reverse(); // newest first

    // Merge: use existing log or empty placeholder
    const sorted = allDates.map(dateStr => logByDate[dateStr] || {
      date: dateStr, produced: 0, broken: 0, netEggs: 0, soldGroups: 0, soldSingle: 0,
      soldEggs: 0, specialEggs: 0, dead: 0, feedIn: 0, feedUsed: 0, notes: '', id: null,
      _empty: true
    });

    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-cell">لا توجد سجلات</td></tr>';
    } else {
      tbody.innerHTML = '';
      sorted.forEach(log => {
        const tr = document.createElement('tr');
        
        const soldDisplay = (log.soldEggs !== undefined) ? log.soldEggs : log.income;
        const specDisplay = (log.specialEggs !== undefined) ? log.specialEggs : log.specialIncome;
        
        tr.innerHTML = `
          <td>${fmtDate(log.date)}</td>
          <td>${fmt(log.produced)}</td>
          <td>${fmt(log.soldGroups)}</td>
          <td>${fmt(log.soldSingle)}</td>
          <td><span style="color:var(--red)">${fmt(log.broken)}</span></td>
          <td><strong style="color:var(--green)">${fmt(soldDisplay)}</strong></td>
          <td><strong style="color:var(--gold)">${fmt(specDisplay)}</strong></td>
          <td>${log.dead > 0 ? `<span style="color:var(--red)">💀 ${log.dead}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td><span style="color:var(--blue)">${fmt(log.feedIn)}</span></td>
          <td><span style="color:var(--orange)">${fmt(log.feedUsed)}</span></td>
          <td style="color:var(--text-secondary);font-size:0.8rem;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${log.notes || ''}">${log.notes || '—'}</td>
          <td class="admin-only" style="display:flex;gap:4px;">
            <button class="btn btn-sm btn-edit-log-rep" data-date="${log.date}" style="background:var(--blue);color:white;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;">✏️ تعديل</button>
            <button class="btn btn-danger btn-sm btn-delete-log-rep" data-id="${log.id}">🗑</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
      
      tbody.querySelectorAll('.btn-delete-log-rep').forEach(btn => {
        btn.addEventListener('click', () => deleteLogById(Number(btn.dataset.id)));
      });
      tbody.querySelectorAll('.btn-edit-log-rep').forEach(btn => {
        btn.addEventListener('click', () => window.editLogByDate(btn.dataset.date));
      });
    }
  }

  // Render Partner Summary (remains unchanged)
  const settings = DB.get('settings') || defaultSettings();
  renderPartnerFinancialSummary(logs, settings);
}

// ====== Clear daily logs and trigger reimport ======
window.clearAndReimportLogs = async function() {
  if (!confirm('سيتم مسح جميع بيانات التقارير الحالية وإعادة استيرادها من الملف الجديد. هل أنت متأكد؟')) return;
  const uid = CURRENT_USER && CURRENT_USER.uid;
  const fid = CURRENT_FACTORY && CURRENT_FACTORY.id;
  if (!uid || !fid) { showToast('حدث خطأ، يرجى إعادة الدخول للمصنع', 'error'); return; }
  
  // Clear localStorage
  localStorage.removeItem('zohir_' + fid + '_daily_logs');
  DB.set('daily_logs', []);
  
  // Clear Firestore if available
  if (typeof fs !== 'undefined' && auth.currentUser) {
    fs.collection('app_data').doc(fid + '_daily_logs').delete().catch(function(){});
  }
  showToast('تم مسح السجلات. يرجى اختيار ملف Excel الآن...', 'info');
  
  // Open file picker
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = async function(e) {
    var f = e.target.files[0];
    if (f) {
      await handleFactoryImport(f);
      window.location.reload(); // Force reload to ensure DB memory is updated and page is fresh
    }
  };
  inp.click();
}

function renderPartnerFinancialSummary(logs, settings) {
  const tbody = document.getElementById('partner-summary-tbody');
  const faidaBlock = document.getElementById('partner-summary-faida-block');
  if (!tbody) return;

  // Render dust profit section first (separate accounting view)
  renderDustProfitSection(logs);

  // Expected monthly profit (used for "expected" partner column)
  const expectedMonthly = (typeof getExpectedMonthlyProfit === 'function') ? getExpectedMonthlyProfit() : 0;

  // Total gross daily base profit across all logs
  const totalDailyProfit = logs.reduce((s, l) => s + (Number(l.baseProfit ?? l.profit) || 0), 0);
  const partners = settings.partners || [];

  // ── Fixed cost deductions (same formula as getTotalNetProfit) ──
  const chickensCost   = (Number(settings.initialChickens) || 0) * (Number(settings.chickenPrice) || 0);
  const feedCost       = (Number(settings.initialFeed) || 0) * (Number(settings.feedPrice) || 0);
  const loyer          = Number(settings.loyer)       || 0;
  const repairLoyer    = Number(settings.repairLoyer)  || 0;
  const repairTotal    = Number(settings.repairTotal)  || 0;
  const effectiveLoyer = Math.max(0, loyer - repairLoyer);
  const electricity    = Number(settings.electricity)  || 0;
  const credits        = DB.get('credits') || [];
  const totalCredits   = credits.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  // Calculate months since first log for electricity
  let monthsDiff = 1;
  if (logs.length > 0) {
    const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = parseDateKey(sorted[0].date);
    const now = new Date();
    monthsDiff = Math.max(1, (now.getFullYear() - firstDate.getFullYear()) * 12 + (now.getMonth() - firstDate.getMonth()) + 1);
  }
  const totalElectricity = electricity * monthsDiff;
  const totalFixedDeductions = chickensCost + feedCost + effectiveLoyer + totalElectricity + repairTotal + totalCredits;

  // Net profit base = gross daily profit − all fixed deductions (before individual partner expenses)
  const netProfitBase = totalDailyProfit - totalFixedDeductions;

  // ── Show faida breakdown block ──
  if (faidaBlock) {
    faidaBlock.style.display = 'block';
    const rows = [
      `<div style="color:var(--text-secondary)">💵 إجمالي الفائدة اليومية</div>
       <div style="color:var(--green);font-weight:600;text-align:left">${fmt(totalDailyProfit,'دج')}</div>`
    ];
    if (chickensCost > 0) rows.push(`
      <div style="color:var(--text-secondary)">🐔 تكلفة الدجاج الابتدائي (${fmt(settings.initialChickens)} × ${fmt(settings.chickenPrice,'دج')})</div>
      <div style="color:var(--red);text-align:left">− ${fmt(chickensCost,'دج')}</div>`);
    if (feedCost > 0) rows.push(`
      <div style="color:var(--text-secondary)">🌾 تكلفة الشعير الابتدائي (${fmt(settings.initialFeed,'كغ')} × ${fmt(settings.feedPrice,'دج')})</div>
      <div style="color:var(--red);text-align:left">− ${fmt(feedCost,'دج')}</div>`);
    if (effectiveLoyer > 0) rows.push(`
      <div style="color:var(--text-secondary)">🏠 الكراء (إجمالي ثابت)</div>
      <div style="color:var(--red);text-align:left">− ${fmt(effectiveLoyer,'دج')}</div>`);
    if (totalElectricity > 0) rows.push(`
      <div style="color:var(--text-secondary)">⚡ الكهرباء (${monthsDiff} شهر × ${fmt(electricity,'دج')})</div>
      <div style="color:var(--red);text-align:left">− ${fmt(totalElectricity,'دج')}</div>`);
    if (repairTotal > 0) rows.push(`
      <div style="color:var(--text-secondary)">🔨 ريباراسيون الفائدة</div>
      <div style="color:var(--red);text-align:left">− ${fmt(repairTotal,'دج')}</div>`);
    if (totalCredits > 0) rows.push(`
      <div style="color:var(--text-secondary)">📋 الكريديات</div>
      <div style="color:var(--red);text-align:left">− ${fmt(totalCredits,'دج')}</div>`);

    faidaBlock.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr auto;gap:6px 20px;font-size:0.88rem;align-items:center">
        ${rows.join('')}
        <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:8px;margin-top:2px;color:var(--text-primary);font-weight:700;font-size:0.95rem">
          💹 صافي الفائدة الإجمالية
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:8px;margin-top:2px;font-weight:700;text-align:left;font-size:0.95rem;
          color:${netProfitBase >= 0 ? 'var(--green)' : 'var(--red)'}">
          ${fmt(netProfitBase,'دج')}
        </div>
      </div>`;
  }

  if (partners.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">لا يوجد شركاء مضافون</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  partners.forEach(p => {
    const pct = Number(p.sharePercent) || 0;
    // Gross share (of daily production profit)
    const shareAmt  = totalDailyProfit * pct / 100;
    // Net faida share (of profit after all fixed deductions)
    const faidaAmt  = netProfitBase    * pct / 100;
    // Expected partner profit = expected monthly profit × share %
    const expectedAmt = expectedMonthly * pct / 100;
    // Partner's individual expenses (advances/withdrawals)
    const totalExpenses = logs.reduce((s, l) => {
      const pe = (l.partnerExpenses || []).find(e => e.partnerId === p.id);
      return s + (pe ? Number(pe.amount) || 0 : 0);
    }, 0);
    // Net due = faida share − individual expenses
    const balance = faidaAmt - totalExpenses;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td><span class="partner-share-badge">${pct}%</span></td>
      <td><span style="color:var(--blue)">${fmt(shareAmt,'دج')}</span></td>
      <td><strong style="color:${faidaAmt >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(faidaAmt,'دج')}</strong></td>
      <td><strong style="color:${expectedAmt >= 0 ? '#b794f4' : 'var(--red)'}">${fmt(expectedAmt,'دج')}</strong></td>
      <td><span style="color:var(--orange)">${fmt(totalExpenses,'دج')}</span></td>
      <td><strong style="color:${balance >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:1.05rem">${fmt(balance,'دج')}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  // Owner row
  const ownerShare = Number(settings.ownerShare) || 0;
  if (ownerShare > 0) {
    const ownerFaida = netProfitBase * ownerShare / 100;
    const ownerExpected = expectedMonthly * ownerShare / 100;
    const ownerAdvs  = logs.reduce((s, l) => s + (Number(l.ownerAdvance) || 0), 0);
    const ownerBal   = ownerFaida - ownerAdvs;
    const trOwner = document.createElement('tr');
    trOwner.style.cssText = 'border-top:2px solid rgba(212,160,23,0.3);background:rgba(212,160,23,0.04)';
    trOwner.innerHTML = `
      <td><strong style="color:var(--gold)">👔 ${settings.owner || 'صاحب العمل'}</strong></td>
      <td><span class="partner-share-badge" style="background:linear-gradient(135deg,rgba(212,160,23,0.25),rgba(212,160,23,0.1));color:var(--gold)">${ownerShare}%</span></td>
      <td><span style="color:var(--blue)">${fmt(totalDailyProfit * ownerShare / 100,'دج')}</span></td>
      <td><strong style="color:${ownerFaida >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(ownerFaida,'دج')}</strong></td>
      <td><strong style="color:${ownerExpected >= 0 ? '#b794f4' : 'var(--red)'}">${fmt(ownerExpected,'دج')}</strong></td>
      <td><span style="color:var(--orange)">${fmt(ownerAdvs,'دج')}</span></td>
      <td><strong style="color:${ownerBal >= 0 ? 'var(--green)' : 'var(--red)'}; font-size:1.05rem">${fmt(ownerBal,'دج')}</strong></td>
    `;
    tbody.appendChild(trOwner);
  }
}

/* ===================== DUST PROFIT (فائدة الغبار) ===================== */
function renderDustProfitSection(logs) {
  const block = document.getElementById('dust-profit-block');
  if (!block) return;

  // Total dust (manure) revenue across all logs
  const totalManureIncome = (logs || []).reduce((s, l) => s + (Number(l.manureIncome) || 0), 0);

  // Find the dust worker
  const workers = DB.get('workers') || [];
  const dustWorker = workers.find(w => w.isDustWorker);

  // Dust worker advances total (independent of where they were stored historically)
  const dustWorkerAdvances = dustWorker
    ? (dustWorker.advances || []).reduce((s, a) => s + (Number(a.amount) || 0), 0)
    : 0;

  // Net dust profit = dust revenue − dust worker advances actually paid
  const netDustProfit = totalManureIncome - dustWorkerAdvances;

  if (totalManureIncome === 0 && !dustWorker) {
    block.innerHTML = `<div class="empty-state" style="padding:14px 0;color:var(--text-muted);font-size:0.9rem">
      💡 لم يتم تسجيل مدخول غبار بعد، ولا يوجد عامل غبار محدد.<br>
      <span style="font-size:0.82rem">يمكنك تعيين عامل من صفحة العمال بالضغط على "💩 جعله عامل الغبار"</span>
    </div>`;
    return;
  }

  const rows = [];
  rows.push(`
    <div style="color:var(--text-secondary)">💩 إجمالي مدخول الغبار</div>
    <div style="color:var(--green);font-weight:600;text-align:left">${fmt(totalManureIncome,'دج')}</div>
  `);

  if (dustWorker) {
    rows.push(`
      <div style="color:var(--text-secondary)">👷 عامل الغبار</div>
      <div style="text-align:left;color:#d4b895;font-weight:600">${dustWorker.name}</div>
    `);
    rows.push(`
      <div style="color:var(--text-secondary)">💵 الراتب الشهري المقرر</div>
      <div style="text-align:left;color:var(--text-primary)">${fmt(Number(dustWorker.salary)||0,'دج')}</div>
    `);
    rows.push(`
      <div style="color:var(--text-secondary)">💸 إجمالي السلفيات المدفوعة</div>
      <div style="color:var(--red);text-align:left">− ${fmt(dustWorkerAdvances,'دج')}</div>
    `);
  } else {
    rows.push(`
      <div style="color:var(--text-secondary)">👷 عامل الغبار</div>
      <div style="text-align:left;color:var(--text-muted);font-size:0.85rem">لم يتم تعيينه بعد</div>
    `);
  }

  block.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px 20px;font-size:0.9rem;align-items:center">
      ${rows.join('')}
      <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:10px;margin-top:4px;color:var(--text-primary);font-weight:700;font-size:1rem">
        🔥 صافي فائدة الغبار
      </div>
      <div style="border-top:1px solid rgba(255,255,255,0.12);padding-top:10px;margin-top:4px;font-weight:700;text-align:left;font-size:1rem;
        color:${netDustProfit >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${fmt(netDustProfit,'دج')}
      </div>
    </div>
    ${dustWorker ? `
      <div style="margin-top:10px;padding:8px 12px;background:rgba(160,130,109,0.08);border-radius:8px;font-size:0.78rem;color:#d4b895;border:1px dashed rgba(160,130,109,0.3)">
        ⓘ سلفيات عامل الغبار لا تُخصم من الفائدة العامة — تُخصم فقط من فائدة الغبار.
      </div>` : ''}
  `;
}

/* ===================== SETTINGS ===================== */
function loadSettingsForm() {
  const s = DB.get('settings') || defaultSettings();
  document.getElementById('farm-name').value = s.farmName || '';
  document.getElementById('farm-owner').value = s.owner || '';
  document.getElementById('farm-chickens').value = s.initialChickens || '';
  const chickenPriceEl = document.getElementById('farm-chicken-price');
  if (chickenPriceEl) chickenPriceEl.value = s.chickenPrice || '';
  document.getElementById('farm-feed-init').value = s.initialFeed || '';
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
  const ownerShareEl = document.getElementById('farm-owner-share');
  if (ownerShareEl) ownerShareEl.value = s.ownerShare !== undefined ? s.ownerShare : 100;
  // Render partners list
  renderPartnersSettings();

  // Lock settings for partner role (read-only) — owner and worker have full access
  const isReadOnly = isReadOnlyUser();
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
    '#btn-save-settings, #btn-save-general-settings, #btn-save-partner-shares, #btn-reset-all, #btn-add-partner, #partner-add-form, #btn-create-worker-account'
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }
  const existing = DB.get('settings') || defaultSettings();
  const s = {
    farmName: document.getElementById('farm-name').value || (CURRENT_FACTORY?.name || 'deku'),
    owner: document.getElementById('farm-owner').value || '',
    initialChickens: Number(document.getElementById('farm-chickens').value) || 0,
    chickenPrice: Number(document.getElementById('farm-chicken-price')?.value) || 0,
    initialFeed: Number(document.getElementById('farm-feed-init').value) || 0,
    // Prices and الروفورم state live in the reports page, not in this form —
    // carry them over so saving settings never wipes them.
    eggSalePrice: Number(existing.eggSalePrice) || 0,
    barleyPricePerKg: Number(existing.barleyPricePerKg) || 0,
    reformeActive: !!existing.reformeActive,
    reformeChickenPrice: Number(existing.reformeChickenPrice) || 0,
    reformeDate: existing.reformeDate || null,

    feedAlertThreshold: Number(document.getElementById('feed-alert-threshold').value) || 100,
    brokenAlertPct: Number(document.getElementById('broken-alert-pct').value) || 5,
    deletePassword: existing.deletePassword || '1234',
    loyer: Number(document.getElementById('farm-loyer')?.value) || 0,
    electricity: Number(document.getElementById('farm-electricity')?.value) || 0,
    repairLoyer: Number(document.getElementById('farm-repair-loyer')?.value) || 0,
    repairTotal: Number(document.getElementById('farm-repair-total')?.value) || 0,
    ownerShare: Number(document.getElementById('farm-owner-share')?.value) || 0,
    partners: existing.partners || []  // preserve partners
  };

  // Validation: owner + partners = 100%
  const partnersSum = s.partners.reduce((sum, p) => sum + (Number(p.sharePercent) || 0), 0);
  const totalShare = s.ownerShare + partnersSum;
  if (totalShare !== 100) {
    showToast(`❌ مجموع الحصص يجب أن يكون 100% تماماً (المجموع الحالي: ${totalShare}%)`, 'error');
    return;
  }

  DB.set('settings', s);
  if (CURRENT_FACTORY?.type === 'broiler' && typeof saveBroilerSettings === 'function') {
    saveBroilerSettings(false);
  }
  addActivity('تم تحديث إعدادات المصنع', '⚙️');
  showToast('✅ تم حفظ الإعدادات');
}

/* ===================== ADD WORKER ===================== */
function initWorkersPage() {
  document.getElementById('btn-add-worker')?.addEventListener('click', () => {
    if (isReadOnlyUser()) {
      showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
    }
    const name = document.getElementById('new-worker-name').value.trim();
    const salary = Number(document.getElementById('new-worker-salary').value) || 0;
    const isDustWorker = !!document.getElementById('new-worker-is-dust')?.checked;
    if (!name) { showToast('يرجى إدخال اسم العامل', 'error'); return; }
    const workers = DB.get('workers') || [];
    // Ensure only one dust worker at a time
    if (isDustWorker) {
      workers.forEach(w => { w.isDustWorker = false; });
    }
    const newWorker = { id: Date.now(), name, salary, advances: [], isDustWorker };
    workers.push(newWorker);
    DB.set('workers', workers);
    document.getElementById('new-worker-name').value = '';
    document.getElementById('new-worker-salary').value = '';
    const dustChk = document.getElementById('new-worker-is-dust');
    if (dustChk) dustChk.checked = false;
    addActivity(`تم إضافة العامل ${name}${isDustWorker ? ' (عامل الغبار)' : ''}`, '👷');
    renderWorkersPage();
    populateWorkerSelects();
    showToast(`✅ تمت إضافة ${name}`);
  });

  document.getElementById('btn-add-team-partner')?.addEventListener('click', () => addPartner('team'));
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }
  if (!confirm(`⚠️ تحذير: سيتم حذف جميع سجلات مصنع "${CURRENT_FACTORY?.name}" بشكل نهائي لا يمكن التراجع عنه!\n\nهل تريد المتابعة؟`)) return;
  if (!confirm(`⛔ تأكيد أخير: كل البيانات (الإنتاج، المبيعات، الشعير، العمال) ستُمسح من السحابة نهائياً.\n\nاضغط موافق للتأكيد.`)) return;

  showGlobalLoader('جاري إعادة ضبط المصنع...');

  const keys = getFactorySyncKeys();
  const emptyData = {
    settings:   defaultSettings(),
    workers:    [],
    daily_logs: [],
    activities: [],
    credits:    [],
    broiler_cycles: [],
    broiler_logs: [],
    broiler_partners: [],
    broiler_partner_txs: [],
    broiler_settings: {},
    broiler_slaughter: []
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


window.editLogByDate = function(dateStr) {
  const logs = DB.get('daily_logs') || [];
  const log = logs.find(l => l.date === dateStr);
  
  showPage('daily');
  document.getElementById('inp-date').value = dateStr;
  
  if (log) {
    document.getElementById('inp-produced').value = log.produced || '';
    document.getElementById('inp-broken').value = log.broken || '';
    document.getElementById('inp-sold-total').value = log.soldEggs || log.income || '';
    document.getElementById('inp-special-plates').value = log.specialEggs || log.specialPlates || '';
    document.getElementById('inp-special-sold').value = log.specialSold || '';
    document.getElementById('inp-feed-in').value = log.feedIn || '';
    document.getElementById('inp-feed-used').value = log.feedUsed || '';
    document.getElementById('inp-dead').value = log.dead || '';
    document.getElementById('inp-notes').value = log.notes || '';
    document.getElementById('inp-owner-advance').value = log.ownerAdvance || '';
    // Optional prices/other fields if they exist
    document.getElementById('inp-price').value = log.price || '';
  } else {
    document.getElementById('inp-produced').value = '';
    document.getElementById('inp-broken').value = '';
    document.getElementById('inp-sold-total').value = '';
    document.getElementById('inp-special-plates').value = '';
    document.getElementById('inp-special-sold').value = '';
    document.getElementById('inp-feed-in').value = '';
    document.getElementById('inp-feed-used').value = '';
    document.getElementById('inp-dead').value = '';
    document.getElementById('inp-notes').value = '';
    document.getElementById('inp-owner-advance').value = '';
    document.getElementById('inp-price').value = '';
  }
  
  // Trigger calculations to update totals visually
  const evt = new Event('input');
  document.getElementById('inp-produced').dispatchEvent(evt);
  
  showToast('يمكنك تعديل بيانات يوم ' + fmtDate(dateStr) + ' الآن', 'info');
  window.scrollTo(0,0);
  
  const btnSave = document.getElementById('btn-save-day');
  if (btnSave) {
    btnSave.innerText = '💾 حفظ التعديلات والعودة للتقارير';
    btnSave.dataset.editMode = 'true';
    btnSave.classList.add('daily-save-visible');
  }
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
    btn.addEventListener('click', () => {
      if (!btn.dataset.page) return;
      triggerNavAnimation(btn);
      showPage(btn.dataset.page);
    });
  });

  document.querySelectorAll('.bottom-nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      triggerNavAnimation(btn);
      showPage(btn.dataset.page);
    });
  });

  document.getElementById('bn-more')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('open');
  });

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-general-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-partner-shares')?.addEventListener('click', confirmPartnerSharesFromSettings);
  document.getElementById('btn-reset-all').addEventListener('click', resetAllData);

  // Credits tab events
  document.getElementById('btn-add-credit')?.addEventListener('click', addCredit);

  // Partners settings events
  document.getElementById('btn-add-partner')?.addEventListener('click', () => addPartner('settings'));

  // Dashboard "share this factory" button + modal
  document.getElementById('btn-share-this-factory')?.addEventListener('click', openShareFactoryModal);
  document.getElementById('btn-confirm-share-factory')?.addEventListener('click', submitShareFactoryFromModal);
  document.getElementById('btn-cancel-share-factory')?.addEventListener('click', closeShareFactoryModal);
  document.getElementById('modal-share-factory')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-share-factory') closeShareFactoryModal();
  });

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

/* =====================================================================
   BROILER (MEAT FACTORY) — FULL MODULE
   ===================================================================== */

/* ---------- Utility ---------- */
function getCyclePhase(day) {
  if (day <= 14) return { key: 'starter', label: 'Starter', color: '#68d391', feedType: 'starter' };
  if (day <= 28) return { key: 'grower',  label: 'Grower',  color: '#f6ad55', feedType: 'grower'  };
  return              { key: 'finisher', label: 'Finisher', color: '#fc8181', feedType: 'finisher' };
}

function getDayOfCycle(cycle) {
  if (!cycle?.startDate) return 0;
  const start = new Date(cycle.startDate);
  const now   = new Date();
  now.setHours(0,0,0,0); start.setHours(0,0,0,0);
  return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}

/* ---------- DB helpers ---------- */
const BroilerDB = {
  getCycles()          { return DB.get('broiler_cycles') || []; },
  saveCycles(arr)      { DB.set('broiler_cycles', arr); },
  getLogs()            { return DB.get('broiler_logs') || []; },
  saveLogs(arr)        { DB.set('broiler_logs', arr); },
  getActiveCycle()     { return this.getCycles().find(c => c.status === 'active') || null; },
  getLogsForCycle(cid) { return this.getLogs().filter(l => l.cycleId === cid); },
};

/* ---------- Broiler Dashboard ---------- */
function renderBroilerDashboard() {
  const placeholder = document.getElementById('broiler-dashboard-placeholder');
  if (!placeholder) return;

  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) {
    placeholder.innerHTML = `
      <div class="broiler-coming-soon">
        <div class="broiler-cs-icon">🐣</div>
        <div class="broiler-cs-title">لا توجد دورة نشطة</div>
        <div class="broiler-cs-sub">ابدأ دورة تربية جديدة لتتبع أداء مصنعك</div>
        <button class="btn btn-primary" onclick="showPage('cycles')">📋 إدارة الدورات</button>
      </div>`;
    return;
  }

  const day   = getDayOfCycle(cycle);
  const phase = getCyclePhase(day);
  const logs  = BroilerDB.getLogsForCycle(cycle.id);

  const totalDead    = logs.reduce((s, l) => s + (l.dead || 0), 0);
  const remaining    = (cycle.chicksCount || 0) - totalDead;
  const mortRate     = cycle.chicksCount ? ((totalDead / cycle.chicksCount) * 100).toFixed(1) : '0.0';
  const totalFeedKg  = logs.reduce((s, l) => s + (l.feedKg || 0), 0);
  const lastWeightLog = [...logs].reverse().find(l => l.avgWeight > 0);
  const avgWeight    = lastWeightLog ? lastWeightLog.avgWeight : 0;
  const totalWeightKg = avgWeight ? ((remaining * avgWeight) / 1000).toFixed(0) : '—';
  const fcr = avgWeight && totalFeedKg && remaining
    ? (totalFeedKg / (remaining * avgWeight / 1000)).toFixed(2) : '—';

  placeholder.innerHTML = `
    <div class="broiler-hero-card">
      <div class="bhero-top">
        <div>
          <div class="bhero-title">${cycle.name}</div>
          <div class="bhero-sub">بدأت ${new Date(cycle.startDate).toLocaleDateString('ar-DZ')}</div>
        </div>
        <div class="bhero-badge" style="background:${phase.color}22;color:${phase.color};border-color:${phase.color}44">
          ${phase.label} · يوم ${day}
        </div>
      </div>
      <div class="bhero-kpis">
        <div class="bhero-kpi"><span class="bhkpi-val">${remaining.toLocaleString('ar')}</span><span class="bhkpi-label">الباقي</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val" style="color:#fc8181">${mortRate}%</span><span class="bhkpi-label">نسبة النفوق</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${totalFeedKg.toLocaleString('ar')} كغ</span><span class="bhkpi-label">إجمالي العلف</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${avgWeight ? avgWeight + ' غ' : '—'}</span><span class="bhkpi-label">متوسط الوزن</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${fcr}</span><span class="bhkpi-label">FCR</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${totalWeightKg !== '—' ? totalWeightKg + ' كغ' : '—'}</span><span class="bhkpi-label">الوزن الكلي</span></div>
      </div>
      <div class="bhero-actions">
        <button class="btn btn-outline btn-sm" onclick="showPage('cycles')">📋 الدورات</button>
        <button class="btn btn-primary btn-sm" onclick="showPage('daily')">📅 إدخال يومي</button>
      </div>
    </div>
    ${logs.length > 0 ? renderBroilerRecentLogs(logs.slice(-3).reverse()) : ''}`;
}

function renderBroilerRecentLogs(logs) {
  const rows = logs.map(l => {
    const ph = getCyclePhase(l.dayNum || 1);
    return `<tr>
      <td>${l.date || '—'}</td>
      <td>يوم ${l.dayNum || '—'}</td>
      <td><span style="color:${ph.color}">${ph.label}</span></td>
      <td style="color:#fc8181">${l.dead || 0}</td>
      <td>${l.feedKg || 0} كغ</td>
      <td>${l.avgWeight ? l.avgWeight + ' غ' : '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="section-card" style="margin-top:16px">
      <div class="section-title">📜 آخر الإدخالات</div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th>التاريخ</th><th>اليوم</th><th>الطور</th><th>النافق</th><th>العلف</th><th>الوزن</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

/* ---------- renderDashboard hook (called via _broilerDashboardHook) ---------- */
function _broilerDashboardHook() {
  if (CURRENT_FACTORY?.type === 'broiler') {
    renderBroilerDashboard();
    return true;
  }
  return false;
}

/* ---------- Cycles Page ---------- */
let _cyclesFilter = 'active';

function switchCyclesTab(filter, btn) {
  _cyclesFilter = filter;
  document.querySelectorAll('#cycles-tabs .page-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderCyclesPage();
}

function renderCyclesPage() {
  const cycles = BroilerDB.getCycles();
  const activeCycle = BroilerDB.getActiveCycle();

  // Hero card for active cycle
  const heroCard = document.getElementById('cycle-hero-card');
  if (heroCard) {
    if (activeCycle) {
      heroCard.style.display = '';
      const day = getDayOfCycle(activeCycle);
      const phase = getCyclePhase(day);
      const logs = BroilerDB.getLogsForCycle(activeCycle.id);
      const totalDead = logs.reduce((s,l) => s+(l.dead||0), 0);
      const remaining = (activeCycle.chicksCount||0) - totalDead;
      const totalFeedKg = logs.reduce((s,l) => s+(l.feedKg||0), 0);
      const lastW = [...logs].reverse().find(l=>l.avgWeight>0);
      const avgW = lastW ? lastW.avgWeight : 0;
      const fcr = avgW && totalFeedKg && remaining
        ? (totalFeedKg / (remaining * avgW / 1000)).toFixed(2) : '—';

      document.getElementById('bhero-title').textContent = activeCycle.name;
      document.getElementById('bhero-sub').textContent =
        `بدأت ${new Date(activeCycle.startDate).toLocaleDateString('ar-DZ')} · ${activeCycle.chicksCount?.toLocaleString('ar')} كتكوت`;
      const badge = document.getElementById('bhero-phase-badge');
      badge.textContent = `${phase.label} · يوم ${day}`;
      badge.style.cssText = `background:${phase.color}22;color:${phase.color};border:1px solid ${phase.color}44;`;

      document.getElementById('bhero-kpis').innerHTML = `
        <div class="bhero-kpi"><span class="bhkpi-val">${remaining.toLocaleString('ar')}</span><span class="bhkpi-label">الباقي</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val" style="color:#fc8181">${activeCycle.chicksCount ? ((totalDead/activeCycle.chicksCount)*100).toFixed(1)+'%' : '—'}</span><span class="bhkpi-label">نسبة النفوق</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${totalFeedKg.toLocaleString('ar')} كغ</span><span class="bhkpi-label">إجمالي العلف</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${avgW ? avgW+' غ' : '—'}</span><span class="bhkpi-label">متوسط الوزن</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${fcr}</span><span class="bhkpi-label">FCR</span></div>
        <div class="bhero-kpi"><span class="bhkpi-val">${logs.length}</span><span class="bhkpi-label">أيام مسجّلة</span></div>`;
    } else {
      heroCard.style.display = 'none';
    }
  }

  // Cycle list
  const container = document.getElementById('cycles-list-container');
  if (!container) return;

  const filtered = cycles.filter(c => {
    if (_cyclesFilter === 'active') return c.status === 'active';
    if (_cyclesFilter === 'done')   return c.status === 'completed';
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${_cyclesFilter === 'active' ? '🟢' : '📋'}</div>
      <p>${_cyclesFilter === 'active' ? 'لا توجد دورة نشطة حالياً' : 'لا توجد دورات في هذا القسم'}</p>
    </div>`;
    return;
  }

  container.innerHTML = filtered.map(cycle => {
    const logs = BroilerDB.getLogsForCycle(cycle.id);
    const totalDead = logs.reduce((s,l) => s+(l.dead||0), 0);
    const remaining = (cycle.chicksCount||0) - totalDead;
    const totalFeedKg = logs.reduce((s,l) => s+(l.feedKg||0), 0);
    const lastW = [...logs].reverse().find(l=>l.avgWeight>0);
    const avgW = lastW ? lastW.avgWeight : 0;
    const day = cycle.status === 'active' ? getDayOfCycle(cycle) : cycle.totalDays || '—';
    const phase = cycle.status === 'active' ? getCyclePhase(day) : null;

    return `<div class="cycle-card ${cycle.status === 'active' ? 'cycle-card--active' : ''}">
      <div class="cc-header">
        <div>
          <div class="cc-name">${cycle.name}</div>
          <div class="cc-meta">${new Date(cycle.startDate).toLocaleDateString('ar-DZ')} · ${cycle.chicksCount?.toLocaleString('ar')} كتكوت</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          ${phase ? `<span class="bhero-badge" style="background:${phase.color}22;color:${phase.color};border:1px solid ${phase.color}44;border-radius:8px;padding:3px 10px;font-size:0.8rem;font-weight:700">${phase.label}</span>` : ''}
          ${cycle.status === 'completed' ? '<span class="cycle-done-badge">✅ منتهية</span>' : ''}
        </div>
      </div>
      <div class="cc-kpis">
        <div class="cc-kpi"><span>${typeof day === 'number' ? 'يوم '+day : day+' يوم'}</span><small>المدة</small></div>
        <div class="cc-kpi"><span>${remaining.toLocaleString('ar')}</span><small>الباقي</small></div>
        <div class="cc-kpi"><span style="color:#fc8181">${totalDead}</span><small>النفوق</small></div>
        <div class="cc-kpi"><span>${totalFeedKg.toLocaleString('ar')} كغ</span><small>إجمالي العلف</small></div>
        <div class="cc-kpi"><span>${avgW ? avgW+' غ' : '—'}</span><small>آخر وزن</small></div>
        <div class="cc-kpi"><span>${logs.length}</span><small>أيام مسجّلة</small></div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- New Cycle Modal ---------- */
function openNewCycleModal() {
  const today = todayStr();
  document.getElementById('nc-start-date').value = today;
  document.getElementById('nc-name').value = `الدورة ${BroilerDB.getCycles().length + 1}`;
  ['nc-chicks','nc-chick-price','nc-supplier','nc-target-weight','nc-bedding-cost','nc-heating-cost'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('nc-preview-chick-cost').textContent = '—';
  document.getElementById('modal-new-cycle').classList.add('open');
  setTimeout(() => document.getElementById('nc-name').focus(), 300);
}

function closeNewCycleModal() {
  document.getElementById('modal-new-cycle').classList.remove('open');
}

function confirmNewCycle() {
  const name        = document.getElementById('nc-name').value.trim();
  const startDate   = document.getElementById('nc-start-date').value;
  const chicksCount = parseInt(document.getElementById('nc-chicks').value) || 0;
  const chickPrice  = parseFloat(document.getElementById('nc-chick-price').value) || 0;
  const supplier    = document.getElementById('nc-supplier').value.trim();
  const targetWeight= parseInt(document.getElementById('nc-target-weight').value) || 0;
  const beddingCost = parseFloat(document.getElementById('nc-bedding-cost').value) || 0;
  const heatingCost = parseFloat(document.getElementById('nc-heating-cost').value) || 0;

  if (!name)        { showToast('أدخل اسم الدورة', 'error'); return; }
  if (!startDate)   { showToast('أدخل تاريخ البداية', 'error'); return; }
  if (!chicksCount) { showToast('أدخل عدد الكتاكيت', 'error'); return; }

  if (BroilerDB.getActiveCycle()) {
    showToast('يوجد دورة نشطة بالفعل — أنهِها أولاً', 'error'); return;
  }

  const cycle = {
    id: 'cyc_' + Date.now(),
    name, startDate, chicksCount, chickPrice, supplier,
    targetWeight, beddingCost, heatingCost,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  const cycles = BroilerDB.getCycles();
  cycles.push(cycle);
  BroilerDB.saveCycles(cycles);

  closeNewCycleModal();
  renderCyclesPage();
  showToast(`✅ بدأت الدورة "${name}" — ${chicksCount.toLocaleString('ar')} كتكوت`);
}

/* ---------- Complete Cycle Modal ---------- */
function openCompleteCycleModal() {
  if (!BroilerDB.getActiveCycle()) { showToast('لا توجد دورة نشطة', 'error'); return; }
  document.getElementById('cc-password').value = '';
  document.getElementById('cc-notes').value = '';
  document.getElementById('cc-error').textContent = '';
  document.getElementById('modal-complete-cycle').classList.add('open');
}

function closeCompleteCycleModal() {
  document.getElementById('modal-complete-cycle').classList.remove('open');
}

function confirmCompleteCycle() {
  const pwd = document.getElementById('cc-password').value;
  const bSettings = DB.get('broiler_settings') || {};
  const settings = DB.get('settings') || {};
  const correctPwd = bSettings.cyclePassword || settings.completeCyclePassword || '1234';
  if (pwd !== correctPwd) {
    document.getElementById('cc-error').textContent = '❌ كلمة السر غير صحيحة';
    return;
  }
  const notes = document.getElementById('cc-notes').value.trim();
  const cycles = BroilerDB.getCycles();
  const idx = cycles.findIndex(c => c.status === 'active');
  if (idx === -1) { showToast('لا توجد دورة نشطة', 'error'); return; }

  const cycle = cycles[idx];
  const logs  = BroilerDB.getLogsForCycle(cycle.id);
  cycle.status       = 'completed';
  cycle.endDate      = todayStr();
  cycle.totalDays    = getDayOfCycle(cycle);
  cycle.closingNotes = notes;

  const totalDead = logs.reduce((s,l) => s+(l.dead||0), 0);
  cycle.finalRemaining = (cycle.chicksCount||0) - totalDead;
  cycle.totalFeedKg    = logs.reduce((s,l) => s+(l.feedKg||0), 0);
  const lastW = [...logs].reverse().find(l=>l.avgWeight>0);
  cycle.finalAvgWeight = lastW ? lastW.avgWeight : 0;

  cycles[idx] = cycle;
  BroilerDB.saveCycles(cycles);

  closeCompleteCycleModal();
  renderCyclesPage();
  showToast(`✅ تم إنهاء الدورة "${cycle.name}"`, 'success');
}

/* ---------- Broiler Daily Entry ---------- */
function initBroilerDailyPage() {
  const cycle = BroilerDB.getActiveCycle();
  const noCycleBanner = document.getElementById('broiler-no-cycle-banner');
  const formInner = document.getElementById('broiler-daily-form-inner');

  if (!cycle) {
    if (noCycleBanner) noCycleBanner.style.display = '';
    if (formInner) formInner.style.display = 'none';
    return;
  }
  if (noCycleBanner) noCycleBanner.style.display = 'none';
  if (formInner) formInner.style.display = '';

  const day = getDayOfCycle(cycle);
  const phase = getCyclePhase(day);

  const dayBar = document.getElementById('broiler-day-bar');
  if (dayBar) dayBar.style.borderColor = phase.color + '55';
  const dayNum = document.getElementById('bday-num');
  if (dayNum) dayNum.textContent = `يوم ${day}`;
  const phaseBadge = document.getElementById('bday-phase');
  if (phaseBadge) {
    phaseBadge.textContent = phase.label;
    phaseBadge.style.cssText = `background:${phase.color}22;color:${phase.color};border:1px solid ${phase.color}44;border-radius:6px;padding:2px 10px;font-size:0.82rem;font-weight:700`;
  }
  const cycleName = document.getElementById('bday-cycle-name');
  if (cycleName) cycleName.textContent = cycle.name;

  // Auto-set feed type based on phase
  const feedTypeEl = document.getElementById('binp-feed-type');
  if (feedTypeEl) feedTypeEl.value = phase.feedType;

  // Set today's date
  const dateEl = document.getElementById('binp-date');
  if (dateEl && !dateEl.value) dateEl.value = todayStr();

  updateBroilerCalc();
  renderBroilerRecentTable(cycle.id);
}

function updateBroilerCalc() {
  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) return;

  const logs      = BroilerDB.getLogsForCycle(cycle.id);
  const totalDead = logs.reduce((s,l) => s+(l.dead||0), 0);
  const newDead   = parseInt(document.getElementById('binp-dead')?.value) || 0;
  const remaining = (cycle.chicksCount||0) - totalDead - newDead;
  const mortRate  = cycle.chicksCount
    ? (((totalDead + newDead) / cycle.chicksCount) * 100).toFixed(1) : '0.0';

  const el = (id) => document.getElementById(id);
  if (el('bprev-remaining')) el('bprev-remaining').textContent = remaining.toLocaleString('ar');
  if (el('bprev-mort-rate')) {
    el('bprev-mort-rate').textContent = mortRate + '%';
    el('bprev-mort-rate').style.color = parseFloat(mortRate) > 5 ? 'var(--red)' : 'var(--green)';
  }

  const feedKg    = parseFloat(el('binp-feed-kg')?.value) || 0;
  const feedPrice = parseFloat(el('binp-feed-price')?.value) || 0;
  
  const totalFeedKg = logs.reduce((s,l) => s+(l.feedKg||0), 0) + feedKg;

  if (el('bprev-feed-cost')) el('bprev-feed-cost').textContent = feedCost ? fmt(feedCost,'دج') : '—';
  if (el('bprev-total-feed')) el('bprev-total-feed').textContent = totalFeedKg.toLocaleString('ar') + ' كغ';

  const avgWeight = parseFloat(el('binp-avg-weight')?.value) || 0;
  if (avgWeight && remaining > 0) {
    const totalWeightKg = (remaining * avgWeight / 1000).toFixed(0);
    if (el('bprev-total-weight')) el('bprev-total-weight').textContent = (+totalWeightKg).toLocaleString('ar') + ' كغ';
    const fcr = totalFeedKg && remaining ? (totalFeedKg / (remaining * avgWeight / 1000)).toFixed(2) : '—';
    if (el('bprev-fcr')) el('bprev-fcr').textContent = fcr;
  } else {
    if (el('bprev-total-weight')) el('bprev-total-weight').textContent = '—';
    if (el('bprev-fcr')) el('bprev-fcr').textContent = '—';
  }
}

function saveBroilerDay() {
  if (cannotDoDailyEntry()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
    return;
  }
  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) { showToast('لا توجد دورة نشطة', 'error'); return; }

  const date      = document.getElementById('binp-date')?.value;
  if (!date) { showToast('اختر تاريخ اليوم', 'error'); return; }

  const logs = BroilerDB.getLogs();
  if (logs.find(l => l.cycleId === cycle.id && l.date === date)) {
    if (!confirm(`يوجد إدخال بتاريخ ${date} — هل تريد تحديثه؟`)) return;
    const idx = logs.findIndex(l => l.cycleId === cycle.id && l.date === date);
    logs.splice(idx, 1);
  }

  const day     = getDayOfCycle(cycle);
  const feedKg  = parseFloat(document.getElementById('binp-feed-kg')?.value) || 0;
  const entry = {
    id:         'bl_' + Date.now(),
    cycleId:    cycle.id,
    date,
    dayNum:     day,
    phase:      getCyclePhase(day).key,
    dead:       parseInt(document.getElementById('binp-dead')?.value) || 0,
    feedType:   document.getElementById('binp-feed-type')?.value || 'grower',
    feedKg,
    feedPrice:  parseFloat(document.getElementById('binp-feed-price')?.value) || 0,
    avgWeight:  parseFloat(document.getElementById('binp-avg-weight')?.value) || 0,
    weighedCount: parseInt(document.getElementById('binp-weighed-count')?.value) || 0,
    waterCost:  parseFloat(document.getElementById('binp-water')?.value) || 0,
    medsCost:   parseFloat(document.getElementById('binp-meds')?.value) || 0,
    notes:      document.getElementById('binp-notes')?.value.trim() || '',
    enteredBy:  CURRENT_USER_NAME || 'unknown',
    createdAt:  new Date().toISOString()
  };

  logs.push(entry);
  BroilerDB.saveLogs(logs);

  showToast(`✅ تم حفظ يوم ${day} — نافق: ${entry.dead} | علف: ${feedKg} كغ`);
  clearBroilerForm();
  renderBroilerRecentTable(cycle.id);
  updateBroilerCalc();
}

function clearBroilerForm() {
  ['binp-dead','binp-feed-kg','binp-feed-price','binp-avg-weight','binp-weighed-count','binp-water','binp-meds','binp-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  updateBroilerCalc();
}

function renderBroilerRecentTable(cycleId) {
  const tbody = document.getElementById('broiler-daily-tbody');
  if (!tbody) return;
  const logs = BroilerDB.getLogsForCycle(cycleId).slice(-7).reverse();
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">لا توجد سجلات</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => {
    const ph = getCyclePhase(l.dayNum||1);
    return `<tr>
      <td>${l.date}</td>
      <td>${l.dayNum}</td>
      <td><span style="color:${ph.color};font-weight:700">${ph.label}</span></td>
      <td style="color:#fc8181">${l.dead}</td>
      <td>${l.feedKg} كغ</td>
      <td>${l.avgWeight ? l.avgWeight+' غ' : '—'}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${l.notes||'—'}</td>
      <td class="admin-only"><button class="btn-icon btn-danger-sm" onclick="deleteBroilerLog('${l.id}')">🗑</button></td>
    </tr>`;
  }).join('');
}

function deleteBroilerLog(logId) {
  if (!confirm('حذف هذا السجل؟')) return;
  const logs = BroilerDB.getLogs().filter(l => l.id !== logId);
  BroilerDB.saveLogs(logs);
  const cycle = BroilerDB.getActiveCycle();
  if (cycle) renderBroilerRecentTable(cycle.id);
  updateBroilerCalc();
  showToast('تم الحذف', 'warning');
}

/* ---------- New Cycle preview calc ---------- */
function updateNewCyclePreview() {
  const count = parseInt(document.getElementById('nc-chicks')?.value) || 0;
  const price = parseFloat(document.getElementById('nc-chick-price')?.value) || 0;
  const el = document.getElementById('nc-preview-chick-cost');
  if (el) el.textContent = count && price ? fmt(count * price, 'دج') : '—';
}

/* ---------- Event Listeners (Broiler) ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // New cycle modal
  document.getElementById('btn-new-cycle')?.addEventListener('click', () => {
    if (isReadOnlyUser()) { showToast('🔒 وضع المشاهدة فقط', 'error'); return; }
    openNewCycleModal();
  });
  document.getElementById('btn-confirm-new-cycle')?.addEventListener('click', confirmNewCycle);
  document.getElementById('btn-cancel-new-cycle')?.addEventListener('click', closeNewCycleModal);
  document.getElementById('modal-new-cycle')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-new-cycle')) closeNewCycleModal();
  });

  // Live preview in new cycle modal
  ['nc-chicks','nc-chick-price'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateNewCyclePreview);
  });

  // Complete cycle modal
  document.getElementById('btn-complete-cycle')?.addEventListener('click', () => {
    if (isReadOnlyUser()) { showToast('🔒 وضع المشاهدة فقط', 'error'); return; }
    openCompleteCycleModal();
  });
  document.getElementById('btn-confirm-complete-cycle')?.addEventListener('click', confirmCompleteCycle);
  document.getElementById('btn-cancel-complete-cycle')?.addEventListener('click', closeCompleteCycleModal);
  document.getElementById('modal-complete-cycle')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-complete-cycle')) closeCompleteCycleModal();
  });

  // Broiler daily save/clear
  document.getElementById('btn-save-broiler-day')?.addEventListener('click', saveBroilerDay);
  document.getElementById('btn-clear-broiler-form')?.addEventListener('click', clearBroilerForm);

  // Broiler advance row
  document.getElementById('broiler-add-advance-row')?.addEventListener('click', () => {
    const container = document.getElementById('broiler-advance-entries');
    if (!container) return;
    const rows = container.querySelectorAll('.advance-row');
    const newRow = document.createElement('div');
    newRow.className = 'advance-row';
    newRow.dataset.idx = rows.length;
    newRow.innerHTML = `
      <select class="adv-worker-select"><option value="">— اختر عاملاً —</option></select>
      <input type="number" class="adv-amount" placeholder="المبلغ (دج)" min="0" />
      <button class="btn-remove-adv" title="حذف">✕</button>`;
    newRow.querySelector('.btn-remove-adv').addEventListener('click', () => newRow.remove());
    container.appendChild(newRow);
    populateWorkerSelects();
  });
});

// Broiler daily init is called from applyFactoryTypeToUI + nav click

/* -------- Broiler Sales -------- */
function renderBroilerSalesPage() {
  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) {
    document.getElementById('page-broiler-sales').innerHTML = `<div class="empty-state" style="padding:60px 20px">
      <p>لا توجد دورة نشطة</p></div>`;
    return;
  }

  const sales = DB.get('broiler_slaughter') || [];
  const cycleSales = sales.filter(s => s.cycleId === cycle.id);

  const totalCount = cycleSales.reduce((s, sl) => s + (sl.count || 0), 0);
  const totalIncome = cycleSales.reduce((s, sl) => s + (sl.income || 0), 0);
  const totalPaid = cycleSales.reduce((s, sl) => s + (sl.paidAmount || 0), 0);
  const totalCredit = totalIncome - totalPaid;

  // Cycle cost estimate
  const logs = BroilerDB.getLogsForCycle(cycle.id);
  const totalFeedCost = logs.reduce((s, l) => s + (l.feedKg * (l.feedPrice || 0)), 0);
  const totalWaterMeds = logs.reduce((s, l) => s + ((l.waterCost || 0) + (l.medsCost || 0)), 0);
  const chicksInitial = (cycle.chicksCount || 0) * (cycle.chickPrice || 0);
  const totalCost = chicksInitial + totalFeedCost + totalWaterMeds + (cycle.beddingCost || 0) + (cycle.heatingCost || 0);
  const profit = totalIncome - totalCost;

  document.getElementById('bs-total-slaughtered').textContent = totalCount.toLocaleString('ar');
  document.getElementById('bs-total-income').textContent = fmt(totalIncome, 'دج');
  document.getElementById('bs-total-cost').textContent = fmt(totalCost, 'دج');
  document.getElementById('bs-total-profit').textContent = fmt(profit, 'دج');
  const profitEl = document.getElementById('bs-total-profit').parentElement.parentElement;
  if (profitEl) profitEl.style.borderColor = profit >= 0 ? 'rgba(72,187,120,0.3)' : 'rgba(252,129,129,0.3)';

  const tbody = document.getElementById('slaughter-tbody');
  if (!cycleSales.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">لم يتم تسجيل أي دفعات ذبح</td></tr>';
  } else {
    tbody.innerHTML = cycleSales.map(sl => `<tr>
      <td>${sl.date}</td>
      <td>${sl.count.toLocaleString('ar')}</td>
      <td>${(sl.count * sl.liveWeight / 1000).toFixed(1)} كغ</td>
      <td>${sl.buyer}</td>
      <td>${sl.pricePerKg}</td>
      <td>${fmt(sl.income, 'دج')}</td>
      <td><span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:${sl.paymentType === 'cash' ? 'rgba(72,187,120,0.15);color:#68d391' : 'rgba(252,129,129,0.15);color:#fc8181'}">${sl.paymentType === 'cash' ? '💰 نقد' : '📋 كريديت'}</span></td>
      <td class="admin-only"><button class="btn-icon btn-danger-sm" onclick="deleteBroilerSale('${sl.id}')">🗑</button></td>
    </tr>`).join('');
  }

  // Credits
  const credits = cycleSales.filter(s => s.paymentType === 'credit');
  const creditsEl = document.getElementById('broiler-credits-list');
  if (credits.length) {
    creditsEl.innerHTML = credits.map(c => `<div class="credit-item" style="padding:12px;background:rgba(252,129,129,0.08);border:1px solid rgba(252,129,129,0.2);border-radius:8px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap">
        <div><span style="font-weight:700">${c.buyer}</span><br><span style="font-size:0.8rem;color:var(--text-muted)">${c.date}</span></div>
        <div style="text-align:right">
          <span style="color:#fc8181;font-weight:700;font-size:1.1rem">${fmt(c.income - c.paidAmount, 'دج')}</span><br>
          <span style="font-size:0.75rem">من أصل ${fmt(c.income, 'دج')}</span>
        </div>
      </div>
    </div>`).join('');
  } else {
    creditsEl.innerHTML = '<div class="empty-state"><p>لا توجد كريديات معلقة</p></div>';
  }
}

function updateSlaughterCalc() {
  const count = parseInt(document.getElementById('sl-count')?.value) || 0;
  const weight = parseInt(document.getElementById('sl-live-weight')?.value) || 0;
  const price = parseFloat(document.getElementById('sl-price-per-kg')?.value) || 0;

  const totalWeightKg = count * weight / 1000;
  const income = totalWeightKg * price;

  const wEl = document.getElementById('sl-prev-total-weight');
  if (wEl) wEl.textContent = totalWeightKg.toFixed(1) + ' كغ';
  const iEl = document.getElementById('sl-prev-income');
  if (iEl) iEl.textContent = fmt(income, 'دج');

  const paymentType = document.getElementById('sl-payment-type')?.value;
  const paidWrap = document.getElementById('sl-paid-amount-wrap');
  const creditRow = document.getElementById('sl-prev-credit-row');

  if (paymentType === 'credit') {
    if (paidWrap) paidWrap.style.display = '';
    if (creditRow) creditRow.style.display = '';
    const paid = parseFloat(document.getElementById('sl-paid-amount')?.value) || 0;
    const credit = income - paid;
    const cEl = document.getElementById('sl-prev-credit');
    if (cEl) cEl.textContent = fmt(credit, 'دج');
  } else {
    if (paidWrap) paidWrap.style.display = 'none';
    if (creditRow) creditRow.style.display = 'none';
  }
}

function openAddSlaughterModal() {
  const today = todayStr();
  document.getElementById('sl-date').value = today;
  ['sl-count','sl-live-weight','sl-price-per-kg','sl-buyer','sl-paid-amount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('sl-payment-type').value = 'cash';
  updateSlaughterCalc();
  document.getElementById('modal-add-slaughter').classList.add('open');
  setTimeout(() => document.getElementById('sl-count').focus(), 300);
}

function closeAddSlaughterModal() {
  document.getElementById('modal-add-slaughter').classList.remove('open');
}

function confirmAddSlaughter() {
  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) { showToast('لا توجد دورة نشطة', 'error'); return; }

  const date = document.getElementById('sl-date')?.value;
  const count = parseInt(document.getElementById('sl-count')?.value) || 0;
  const weight = parseInt(document.getElementById('sl-live-weight')?.value) || 0;
  const price = parseFloat(document.getElementById('sl-price-per-kg')?.value) || 0;
  const buyer = document.getElementById('sl-buyer')?.value.trim();
  const paymentType = document.getElementById('sl-payment-type')?.value || 'cash';
  const paidAmount = paymentType === 'cash' ? (count * weight / 1000 * price) : (parseFloat(document.getElementById('sl-paid-amount')?.value) || 0);

  if (!date || !count || !weight || !price) { showToast('أكمل البيانات المطلوبة', 'error'); return; }

  const income = count * weight / 1000 * price;
  const sale = {
    id: 'sl_' + Date.now(),
    cycleId: cycle.id,
    date, count, liveWeight: weight,
    pricePerKg: price, buyer: buyer || 'بدون',
    income, paymentType, paidAmount,
    createdAt: new Date().toISOString()
  };

  const sales = DB.get('broiler_slaughter') || [];
  sales.push(sale);
  DB.set('broiler_slaughter', sales);

  closeAddSlaughterModal();
  renderBroilerSalesPage();
  showToast(`✅ تم تسجيل دفعة: ${count} طير — ${fmt(income, 'دج')}`);
}

function deleteBroilerSale(saleId) {
  if (!confirm('حذف هذه الدفعة؟')) return;
  const sales = (DB.get('broiler_slaughter') || []).filter(s => s.id !== saleId);
  DB.set('broiler_slaughter', sales);
  renderBroilerSalesPage();
  showToast('تم الحذف', 'warning');
}

/* -------- Broiler Reports -------- */
function renderBroilerReportsPage() {
  const cycle = BroilerDB.getActiveCycle();
  if (!cycle) {
    document.getElementById('page-broiler-reports').innerHTML = `<div class="empty-state" style="padding:60px 20px">
      <p>لا توجد دورة نشطة</p></div>`;
    return;
  }

  const logs = BroilerDB.getLogsForCycle(cycle.id);
  const sales = (DB.get('broiler_slaughter') || []).filter(s => s.cycleId === cycle.id);
  const partners = DB.get('partners') || [];

  const totalDead = logs.reduce((s, l) => s + (l.dead || 0), 0);
  const remaining = (cycle.chicksCount || 0) - totalDead;
  const mortRate = cycle.chicksCount ? ((totalDead / cycle.chicksCount) * 100).toFixed(2) : '0.00';
  const totalFeedKg = logs.reduce((s, l) => s + (l.feedKg || 0), 0);
  const lastW = [...logs].reverse().find(l => l.avgWeight > 0);
  const avgWeight = lastW ? lastW.avgWeight : 0;
  const fcr = avgWeight && totalFeedKg && remaining
    ? (totalFeedKg / (remaining * avgWeight / 1000)).toFixed(2) : '—';
  const totalSlaughtered = sales.reduce((s, sl) => s + (sl.count || 0), 0);

  const summaryHTML = `
    <div class="report-item"><span>🐣 الكتاكيت الابتدائية:</span><strong>${(cycle.chicksCount || 0).toLocaleString('ar')}</strong></div>
    <div class="report-item"><span>💀 النفوق الإجمالي:</span><strong style="color:#fc8181">${totalDead.toLocaleString('ar')} (${mortRate}%)</strong></div>
    <div class="report-item"><span>🐔 المتبقي الحي:</span><strong>${remaining.toLocaleString('ar')}</strong></div>
    <div class="report-item"><span>🔪 المذبوح:</span><strong>${totalSlaughtered.toLocaleString('ar')}</strong></div>
    <div class="report-item"><span>🌾 إجمالي العلف:</span><strong>${totalFeedKg.toLocaleString('ar')} كغ</strong></div>
    <div class="report-item"><span>⚖️ متوسط الوزن:</span><strong>${avgWeight ? avgWeight + ' غ' : '—'}</strong></div>
    <div class="report-item"><span>📊 FCR:</span><strong>${fcr}</strong></div>
    <div class="report-item"><span>📅 مدة الدورة:</span><strong>${getDayOfCycle(cycle)} يوم</strong></div>`;

  const summaryEl = document.getElementById('broiler-report-summary');
  if (summaryEl) summaryEl.innerHTML = summaryHTML;

  // Financials
  const chicksInitial = (cycle.chicksCount || 0) * (cycle.chickPrice || 0);
  
  const waterMeds = logs.reduce((s, l) => s + ((l.waterCost || 0) + (l.medsCost || 0)), 0);
  const beddingHeating = (cycle.beddingCost || 0) + (cycle.heatingCost || 0);
  const totalCost = chicksInitial + feedCost + waterMeds + beddingHeating;
  const totalIncome = sales.reduce((s, sl) => s + (sl.income || 0), 0);
  const profit = totalIncome - totalCost;

  const finEl = document.getElementById('broiler-report-financials');
  if (finEl) finEl.innerHTML = `
    <div style="margin-bottom:20px">
      <div class="calc-row"><span>تكلفة الكتاكيت:</span><strong>${fmt(chicksInitial, 'دج')}</strong></div>
      <div class="calc-row"><span>تكلفة العلف:</span><strong>${fmt(feedCost, 'دج')}</strong></div>
      <div class="calc-row"><span>الماء والأدوية:</span><strong>${fmt(waterMeds, 'دج')}</strong></div>
      <div class="calc-row"><span>الفرشة والتدفئة:</span><strong>${fmt(beddingHeating, 'دج')}</strong></div>
      <div style="border-top:1px dashed rgba(255,255,255,0.2);margin:10px 0;padding-top:10px">
        <div class="calc-row"><span style="font-weight:700">إجمالي التكاليف:</span><strong>${fmt(totalCost, 'دج')}</strong></div>
      </div>
      <div class="calc-row"><span>إجمالي المدخول (الذبح):</span><strong style="color:var(--green)">${fmt(totalIncome, 'دج')}</strong></div>
      <div style="border-top:1px dashed rgba(255,255,255,0.2);margin:10px 0;padding-top:10px">
        <div class="calc-row" style="font-size:1.1rem"><span style="font-weight:900">الفائدة الصافية:</span><strong style="color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(profit, 'دج')}</strong></div>
      </div>
    </div>`;

  // Partners
  const partnersEl = document.getElementById('broiler-partners-tbody');
  if (!partners.length) {
    if (partnersEl) partnersEl.innerHTML = '<tr><td colspan="5" class="empty-cell">لا يوجد شركاء</td></tr>';
  } else {
    const ownerSharePct = (DB.get('settings') || {}).ownerShare || 100;
    const rows = [];

    partners.forEach(p => {
      const share = (profit * (p.sharePercent || 0) / 100);
      rows.push(`<tr>
        <td>${p.name}</td>
        <td>${p.sharePercent}%</td>
        <td>${fmt(share, 'دج')}</td>
        <td>—</td>
        <td style="color:${share >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(share, 'دج')}</td>
      </tr>`);
    });

    const ownerShare = (profit * ownerSharePct / 100);
    rows.push(`<tr style="border-top:1px solid rgba(255,255,255,0.1)">
      <td style="font-weight:700">👔 صاحب العمل</td>
      <td style="font-weight:700">${ownerSharePct}%</td>
      <td style="font-weight:700">${fmt(ownerShare, 'دج')}</td>
      <td>—</td>
      <td style="color:var(--green);font-weight:700">${fmt(ownerShare, 'دج')}</td>
    </tr>`);

    if (partnersEl) partnersEl.innerHTML = rows.join('');
  }

  // Feed
  const feedEl = document.getElementById('broiler-report-feed');
  if (feedEl) {
    const feedByType = { starter: 0, grower: 0, finisher: 0 };
    logs.forEach(l => {
      const t = l.feedType || 'grower';
      if (feedByType.hasOwnProperty(t)) feedByType[t] += l.feedKg || 0;
    });
    feedEl.innerHTML = `
      <div class="calc-row"><span>Starter:</span><strong>${feedByType.starter.toLocaleString('ar')} كغ</strong></div>
      <div class="calc-row"><span>Grower:</span><strong>${feedByType.grower.toLocaleString('ar')} كغ</strong></div>
      <div class="calc-row"><span>Finisher:</span><strong>${feedByType.finisher.toLocaleString('ar')} كغ</strong></div>`;
  }
}

/* ---------- Broiler Event Listeners (Phase 3) ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // Slaughter modal
  document.getElementById('btn-add-slaughter')?.addEventListener('click', () => {
    if (isReadOnlyUser()) { showToast('🔒 وضع المشاهدة فقط', 'error'); return; }
    openAddSlaughterModal();
  });
  document.getElementById('btn-confirm-add-slaughter')?.addEventListener('click', confirmAddSlaughter);
  document.getElementById('btn-cancel-add-slaughter')?.addEventListener('click', closeAddSlaughterModal);
  document.getElementById('modal-add-slaughter')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-add-slaughter')) closeAddSlaughterModal();
  });
  document.getElementById('sl-payment-type')?.addEventListener('change', updateSlaughterCalc);
  document.getElementById('sl-paid-amount')?.addEventListener('input', updateSlaughterCalc);
  ['sl-count','sl-live-weight','sl-price-per-kg'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateSlaughterCalc);
  });
});

// broiler-sales, broiler-reports, broiler-workers, and daily are handled
// directly inside the showPage refreshers map (no override needed)

/* ======================================================================
   BROILER — PHASE 4: PARTNERS, WORKERS, SETTINGS, STATEMENT
   ====================================================================== */

/* -------- Partners (Broiler) -------- */
let _bpePartnerId = null; // partner being edited in expense modal

function renderBroilerWorkersPage() {
  renderBroilerPartnersTab();
  renderBroilerWorkersTab();
}

function switchBroilerTeamTab(tab, btn) {
  document.querySelectorAll('#broiler-team-tabs .page-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const partnersTab = document.getElementById('bteam-tab-partners');
  const workersTab  = document.getElementById('bteam-tab-workers');
  if (partnersTab) partnersTab.style.display = tab === 'partners' ? '' : 'none';
  if (workersTab)  workersTab.style.display  = tab === 'workers'  ? '' : 'none';
}

function renderBroilerPartnersTab() {
  const partners = DB.get('broiler_partners') || [];
  const container = document.getElementById('broiler-partners-list');
  if (!container) return;

  if (!partners.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🤝</div><p>لا يوجد شركاء بعد</p></div>`;
    return;
  }

  const cycle  = BroilerDB.getActiveCycle();
  const logs   = cycle ? BroilerDB.getLogsForCycle(cycle.id) : [];
  const sales  = cycle ? (DB.get('broiler_slaughter') || []).filter(s => s.cycleId === cycle.id) : [];
  const totalIncome = sales.reduce((s, sl) => s + (sl.income || 0), 0);
  const totalFeedCost = logs.reduce((s, l) => s + (l.feedKg * (l.feedPrice || 0)), 0);
  const totalWaterMeds = logs.reduce((s, l) => s + ((l.waterCost||0) + (l.medsCost||0)), 0);
  const chicksInitial = cycle ? (cycle.chicksCount||0) * (cycle.chickPrice||0) : 0;
  const bSettings = DB.get('broiler_settings') || {};
  const fixedCosts = (bSettings.loyer||0) + (bSettings.electricity||0) + (bSettings.misc||0);
  const totalCost  = chicksInitial + totalFeedCost + totalWaterMeds + (cycle?.beddingCost||0) + (cycle?.heatingCost||0) + fixedCosts;
  const profit     = totalIncome - totalCost;

  container.innerHTML = partners.map(p => {
    const sharePct = Number(p.sharePercent) || 0;
    const profitShare = profit * sharePct / 100;
    const txs = (DB.get('broiler_partner_txs') || []).filter(t => t.partnerId === p.id);
    const totalExpenses   = txs.filter(t => t.txType === 'expense'   ).reduce((s,t) => s+(t.amount||0), 0);
    const totalWithdrawals= txs.filter(t => t.txType === 'withdrawal').reduce((s,t) => s+(t.amount||0), 0);
    const totalInjections = txs.filter(t => t.txType === 'injection' ).reduce((s,t) => s+(t.amount||0), 0);
    const netDue = profitShare - totalExpenses - totalWithdrawals + totalInjections;

    return `<div class="broiler-partner-card">
      <div class="bpc-header">
        <div>
          <div class="bpc-name">${p.name}</div>
          <div class="bpc-meta">${sharePct}% — ${txs.length} معاملة</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="openBroilerPartnerExpense('${p.id}')">💸 مصروف</button>
          <button class="btn btn-outline btn-sm" onclick="openBroilerStatement('${p.id}')">📄 كشف</button>
          <button class="btn btn-danger btn-sm restricted-edit" onclick="deleteBroilerPartner('${p.id}')">✕</button>
        </div>
      </div>
      <div class="bpc-kpis">
        <div class="bpc-kpi"><span>${fmt(profitShare,'دج')}</span><small>الحصة من الفائدة</small></div>
        <div class="bpc-kpi"><span style="color:var(--orange)">${fmt(totalExpenses+totalWithdrawals,'دج')}</span><small>المسحوبات</small></div>
        <div class="bpc-kpi"><span style="color:${netDue>=0?'var(--green)':'var(--red)'}">${fmt(netDue,'دج')}</span><small>الصافي المستحق</small></div>
      </div>
    </div>`;
  }).join('');
}

function renderBroilerWorkersTab() {
  const workers = DB.get('workers') || [];
  const container = document.getElementById('broiler-workers-list');
  if (!container) return;
  if (!workers.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><p>لا يوجد عمال</p></div>`;
    return;
  }

  const cycle = BroilerDB.getActiveCycle();
  const logs  = cycle ? BroilerDB.getLogsForCycle(cycle.id) : [];

  container.innerHTML = workers.map(w => {
    const advances = logs.reduce((s, l) => {
      const adv = (l.advances || []).find(a => a.workerId === w.id);
      return s + (adv ? adv.amount : 0);
    }, 0);
    return `<div class="section-card" style="margin-bottom:10px;padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700">${w.name}</span>
          <span style="font-size:0.78rem;color:var(--text-muted);margin-right:8px">راتب: ${fmt(w.salary||0,'دج')}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="font-size:0.85rem;color:var(--orange)">سلف: ${fmt(advances,'دج')}</span>
          <button class="btn btn-danger btn-sm restricted-edit" onclick="deleteBroilerWorker('${w.id}')">✕ حذف</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function addBroilerPartner() {
  const name  = document.getElementById('bp-name')?.value.trim();
  const share = parseFloat(document.getElementById('bp-share')?.value) || 0;
  if (!name)  { showToast('أدخل اسم الشريك','error'); return; }
  if (!share) { showToast('أدخل نسبة المشاركة','error'); return; }

  const partners = DB.get('broiler_partners') || [];
  const totalUsed = partners.reduce((s,p) => s + Number(p.sharePercent), 0);
  const ownerShare = (DB.get('broiler_settings')||{}).ownerShare || 100;
  const available  = 100 - (100 - ownerShare) - totalUsed;
  if (share > available) {
    showToast(`النسب المتاحة: ${available.toFixed(1)}% فقط`, 'error'); return;
  }

  partners.push({ id:'bp_'+Date.now(), name, sharePercent: share });
  DB.set('broiler_partners', partners);
  document.getElementById('bp-name').value  = '';
  document.getElementById('bp-share').value = '';
  renderBroilerPartnersTab();
  showToast(`✅ تمت إضافة ${name}`);
}

function deleteBroilerPartner(id) {
  if (!confirm('حذف هذا الشريك؟')) return;
  DB.set('broiler_partners', (DB.get('broiler_partners')||[]).filter(p => p.id !== id));
  DB.set('broiler_partner_txs', (DB.get('broiler_partner_txs')||[]).filter(t => t.partnerId !== id));
  renderBroilerPartnersTab();
  showToast('تم الحذف', 'warning');
}

function addBroilerWorker() {
  const name   = document.getElementById('bw-name')?.value.trim();
  const salary = parseFloat(document.getElementById('bw-salary')?.value) || 0;
  if (!name) { showToast('أدخل اسم العامل','error'); return; }
  const workers = DB.get('workers') || [];
  workers.push({ id:'bw_'+Date.now(), name, salary });
  DB.set('workers', workers);
  document.getElementById('bw-name').value   = '';
  document.getElementById('bw-salary').value = '';
  renderBroilerWorkersTab();
  populateWorkerSelects();
  showToast(`✅ تمت إضافة ${name}`);
}

function deleteBroilerWorker(id) {
  if (!confirm('حذف هذا العامل؟')) return;
  DB.set('workers', (DB.get('workers')||[]).filter(w => w.id !== id));
  renderBroilerWorkersTab();
  populateWorkerSelects();
  showToast('تم الحذف', 'warning');
}

/* -------- Partner Expense Modal -------- */
function openBroilerPartnerExpense(partnerId) {
  _bpePartnerId = partnerId;
  const partner = (DB.get('broiler_partners')||[]).find(p => p.id === partnerId);
  const title = document.getElementById('bpe-modal-title');
  if (title) title.textContent = `💸 معاملة — ${partner?.name || ''}`;
  document.getElementById('bpe-amount').value = '';
  document.getElementById('bpe-note').value   = '';
  document.getElementById('bpe-date').value   = todayStr();
  document.getElementById('bpe-type').value   = 'expense';
  document.getElementById('modal-broiler-partner-expense').classList.add('open');
  setTimeout(() => document.getElementById('bpe-amount').focus(), 300);
}

function closeBroilerPartnerExpense() {
  document.getElementById('modal-broiler-partner-expense').classList.remove('open');
  _bpePartnerId = null;
}

function confirmBroilerPartnerExpense() {
  if (!_bpePartnerId) return;
  const amount = parseFloat(document.getElementById('bpe-amount')?.value) || 0;
  if (!amount) { showToast('أدخل المبلغ','error'); return; }
  const tx = {
    id:        'btx_'+Date.now(),
    partnerId: _bpePartnerId,
    txType:    document.getElementById('bpe-type')?.value || 'expense',
    amount,
    date:      document.getElementById('bpe-date')?.value || '',
    note:      document.getElementById('bpe-note')?.value.trim() || '',
    createdAt: new Date().toISOString()
  };
  const txs = DB.get('broiler_partner_txs') || [];
  txs.push(tx);
  DB.set('broiler_partner_txs', txs);
  closeBroilerPartnerExpense();
  renderBroilerPartnersTab();
  const typeLabels = { expense:'مصروف', withdrawal:'سحب', injection:'ضخ رأسمال' };
  showToast(`✅ تم تسجيل ${typeLabels[tx.txType]}: ${fmt(amount,'دج')}`);
}

/* -------- Partner Statement -------- */
function openBroilerStatement(partnerId) {
  const partner  = (DB.get('broiler_partners')||[]).find(p => p.id === partnerId);
  const txs      = (DB.get('broiler_partner_txs')||[]).filter(t => t.partnerId === partnerId);
  const cycle    = BroilerDB.getActiveCycle();
  const sales    = cycle ? (DB.get('broiler_slaughter')||[]).filter(s => s.cycleId === cycle.id) : [];
  const logs     = cycle ? BroilerDB.getLogsForCycle(cycle.id) : [];
  const totalIncome = sales.reduce((s,sl)=>s+(sl.income||0),0);
  const bS = DB.get('broiler_settings') || {};
  const fixedCosts = (bS.loyer||0)+(bS.electricity||0)+(bS.misc||0);
  const chiCost = cycle ? (cycle.chicksCount||0)*(cycle.chickPrice||0) : 0;
  
  const waterMeds = logs.reduce((s,l)=>s+((l.waterCost||0)+(l.medsCost||0)),0);
  const totalCost = chiCost+feedCost+waterMeds+(cycle?.beddingCost||0)+(cycle?.heatingCost||0)+fixedCosts;
  const profit = totalIncome - totalCost;
  const sharePct = Number(partner?.sharePercent)||0;
  const profitShare = profit * sharePct / 100;
  const totalExp  = txs.filter(t=>t.txType==='expense'  ).reduce((s,t)=>s+(t.amount||0),0);
  const totalWith = txs.filter(t=>t.txType==='withdrawal').reduce((s,t)=>s+(t.amount||0),0);
  const totalInj  = txs.filter(t=>t.txType==='injection' ).reduce((s,t)=>s+(t.amount||0),0);
  const netDue = profitShare - totalExp - totalWith + totalInj;

  const txRows = txs.length
    ? txs.map(t=>`<tr>
        <td>${t.date}</td>
        <td>${{expense:'💸 مصروف',withdrawal:'💵 سحب',injection:'💉 رأسمال'}[t.txType]||t.txType}</td>
        <td>${t.note||'—'}</td>
        <td style="color:${t.txType==='injection'?'var(--green)':'var(--red)'}">${t.txType==='injection'?'+':'−'} ${fmt(t.amount,'دج')}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-cell">لا توجد معاملات</td></tr>';

  const html = `
    <div style="padding:16px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;margin-bottom:16px">
      <div style="font-size:1.1rem;font-weight:900;margin-bottom:4px">${partner?.name}</div>
      <div style="font-size:0.82rem;color:var(--text-muted)">نسبة المشاركة: ${sharePct}% · ${new Date().toLocaleDateString('ar-DZ')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px">
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:0.75rem;color:var(--text-muted)">الحصة من الفائدة</div>
          <div style="font-weight:800;font-size:1.1rem;margin-top:4px">${fmt(profitShare,'دج')}</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:0.75rem;color:var(--text-muted)">الصافي المستحق</div>
          <div style="font-weight:800;font-size:1.1rem;margin-top:4px;color:${netDue>=0?'var(--green)':'var(--red)'}">${fmt(netDue,'دج')}</div>
        </div>
      </div>
    </div>
    <div style="margin-bottom:8px;font-weight:700;font-size:0.9rem">سجل المعاملات:</div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>الملاحظة</th><th>المبلغ</th></tr></thead>
        <tbody>${txRows}</tbody>
      </table>
    </div>`;

  document.getElementById('broiler-statement-content').innerHTML = html;
  document.getElementById('modal-broiler-statement').classList.add('open');
}

function closeBroilerStatement() {
  document.getElementById('modal-broiler-statement').classList.remove('open');
}

/* -------- Broiler Settings -------- */
function loadBroilerSettings() {
  const s = DB.get('broiler_settings') || {};
  const el = id => document.getElementById(id);
  if (el('broiler-owner-share'))    el('broiler-owner-share').value    = s.ownerShare    ?? 100;
  if (el('broiler-loyer'))          el('broiler-loyer').value          = s.loyer         ?? 0;
  if (el('broiler-electricity'))    el('broiler-electricity').value    = s.electricity   ?? 0;
  if (el('broiler-misc'))           el('broiler-misc').value           = s.misc          ?? 0;
  if (el('broiler-cycle-password')) el('broiler-cycle-password').value = s.cyclePassword ?? '';
  if (el('broiler-mort-alert'))     el('broiler-mort-alert').value     = s.mortAlert     ?? 5;
}

function saveBroilerSettings(showMessage = true) {
  const el = id => document.getElementById(id);
  const existing = DB.get('broiler_settings') || {};
  const s = {
    ownerShare:    parseFloat(el('broiler-owner-share')?.value)    || existing.ownerShare || 100,
    loyer:         parseFloat(el('broiler-loyer')?.value)          || 0,
    electricity:   parseFloat(el('broiler-electricity')?.value)    || 0,
    misc:          parseFloat(el('broiler-misc')?.value)           || 0,
    cyclePassword: el('broiler-cycle-password')?.value             || '1234',
    mortAlert:     parseFloat(el('broiler-mort-alert')?.value)     || 5,
  };
  DB.set('broiler_settings', s);
  if (showMessage) showToast('✅ تم حفظ إعدادات اللحم');
}

/* -------- Sync broiler keys -------- */
// Add extra keys to cloud sync
const _broilerExtraKeys = ['broiler_partners','broiler_partner_txs','broiler_settings','broiler_slaughter'];

/* -------- applyFactoryTypeToUI — show broiler-settings-card -------- */
// called by applyFactoryTypeToUI which runs on enterFactory

/* -------- Event Listeners Phase 4 -------- */
document.addEventListener('DOMContentLoaded', () => {
  // Workers page
  document.getElementById('btn-add-broiler-partner')?.addEventListener('click', addBroilerPartner);
  document.getElementById('btn-add-broiler-worker')?.addEventListener('click', addBroilerWorker);

  // Partner expense modal
  document.getElementById('btn-confirm-bpe')?.addEventListener('click', confirmBroilerPartnerExpense);
  document.getElementById('btn-cancel-bpe')?.addEventListener('click',  closeBroilerPartnerExpense);
  document.getElementById('modal-broiler-partner-expense')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-broiler-partner-expense')) closeBroilerPartnerExpense();
  });

  // Statement modal
  document.getElementById('btn-close-broiler-statement')?.addEventListener('click', closeBroilerStatement);
  document.getElementById('modal-broiler-statement')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-broiler-statement')) closeBroilerStatement();
  });

  // Broiler settings save
  document.getElementById('btn-save-broiler-settings')?.addEventListener('click', saveBroilerSettings);
});

/* -------- confirmCompleteCycle uses broiler settings password -------- */
/* (replaces the earlier definition to support custom password) */

/* =====================================================================
   END BROILER MODULE
   ===================================================================== */

/* =====================================================================
   AI CHAT MODULE — مساعد مصنع البيض الذكي
   ===================================================================== */
// Auto-detect: use localhost for local dev, empty string (relative) for Vercel
const AI_BACKEND_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:5000'
  : '';
let _aiChatHistory = [];
let _aiIsOnline = false;
let _aiIsSending = false;
let _aiPageInitialized = false;

function getBusinessContextForAI() {
  const logs = DB.get('daily_logs') || [];
  const settings = DB.get('settings') || {};
  const workers = DB.get('workers') || [];
  const credits = DB.get('credits') || [];
  const today = todayStr();
  const todayLogs = logs.filter(l => l.date === today);

  const sumLayerLogs = (items) => items.reduce((acc, l) => {
    const produced = Number(l.produced) || 0;
    const broken = Number(l.broken) || 0;
    const explicitSold = l.soldEggs !== undefined ? Number(l.soldEggs) : Number(l.soldTotal);
    const soldPlates = (explicitSold || ((Number(l.soldGroups) || 0) * 12) + (Number(l.soldSingle) || 0)) +
      (Number(l.brokenEggs) || broken);
    const baseProfit = Number(l.baseProfit ?? l.profit) || 0;
    const netProfit = Number(l.profit ?? l.baseProfit) || 0;

    acc.days += 1;
    acc.producedPlates += produced;
    acc.brokenPlates += broken;
    acc.netPlates += Number(l.netEggs) || Math.max(0, produced - broken);
    acc.soldPlates += soldPlates;
    acc.freePlates += Number(l.freePlates) || 0;
    acc.income += Number(l.income) || 0;
    acc.specialIncome += Number(l.specialIncome) || 0;
    acc.manureIncome += Number(l.manureIncome) || 0;
    acc.feedInKg += Number(l.feedIn) || 0;
    acc.feedUsedKg += Number(l.feedUsed) || 0;
    acc.feedCost += Number(l.feedCost) || ((Number(l.feedUsed) || 0) * (Number(l.feedPrice || settings.feedPrice) || 0));
    acc.waterCost += Number(l.waterCost) || 0;
    acc.deadChickens += Number(l.dead) || 0;
    acc.ownerAdvance += Number(l.ownerAdvance) || 0;
    acc.baseProfit += baseProfit;
    acc.netProfit += netProfit;
    return acc;
  }, {
    days: 0,
    producedPlates: 0,
    brokenPlates: 0,
    netPlates: 0,
    soldPlates: 0,
    freePlates: 0,
    income: 0,
    specialIncome: 0,
    manureIncome: 0,
    feedInKg: 0,
    feedUsedKg: 0,
    feedCost: 0,
    waterCost: 0,
    deadChickens: 0,
    ownerAdvance: 0,
    baseProfit: 0,
    netProfit: 0
  });

  const sortedLogs = [...logs].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const monthKey = today.slice(0, 7);
  const monthLogs = logs.filter(l => String(l.date || '').slice(0, 7) === monthKey);
  const todaySummary = sumLayerLogs(todayLogs);
  const monthSummary = sumLayerLogs(monthLogs);
  const allTimeSummary = sumLayerLogs(logs);

  const feedBalance = typeof getCurrentFeedBalance === 'function' ? getCurrentFeedBalance() : 0;
  const cumulativeProduction = logs.reduce((max, l) => Math.max(max, Number(l.totalProduction) || 0), 0);
  const eggStockPlates = (cumulativeProduction > 0 ? cumulativeProduction : allTimeSummary.netPlates) -
    allTimeSummary.soldPlates - allTimeSummary.freePlates;
  const initialChickensCost = (Number(settings.initialChickens) || 0) * (Number(settings.chickenPrice) || 0);
  const initialFeedCost = (Number(settings.initialFeed) || 0) * (Number(settings.feedPrice) || 0);
  const effectiveRent = Math.max(0, (Number(settings.loyer) || 0) - (Number(settings.repairLoyer) || 0));
  const totalFixedDeductions =
    initialChickensCost +
    initialFeedCost +
    effectiveRent +
    (Number(settings.electricity) || 0) +
    (Number(settings.repairTotal) || 0) +
    credits.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const netFaidaTotal = allTimeSummary.baseProfit - totalFixedDeductions;
  const todayNetFaida = todaySummary.baseProfit;
  const thisMonthNetFaida = monthSummary.baseProfit - effectiveRent - (Number(settings.electricity) || 0);
  const partners = (settings.partners || []).map(p => ({
    name: p.name || p.email || 'partner',
    email: p.email || '',
    sharePercent: Number(p.sharePercent) || 0
  }));
  const workerSummary = workers.map(w => ({
    name: w.name || 'worker',
    salary: Number(w.salary) || 0,
    isDustWorker: !!w.isDustWorker,
    totalAdvances: (w.advances || []).reduce((s, a) => s + (Number(a.amount) || 0), 0)
  }));
  const creditSummary = credits.map(c => ({
    client: c.client || c.name || c.buyer || 'client',
    amount: Number(c.amount) || Number(c.income || 0) - Number(c.paidAmount || 0) || 0,
    date: c.date || '',
    description: c.description || ''
  }));
  const aiSecretKeyPattern = /(password|pass|secret|token|apiKey|api_key|deletePassword|cyclePassword|completeCyclePassword|ownerCode|hashedOwnerCode|devCode)/i;
  const sanitizeForAI = (value, depth = 0) => {
    if (depth > 8) return '[nested data omitted]';
    if (Array.isArray(value)) return value.map(item => sanitizeForAI(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.entries(value).reduce((acc, [key, val]) => {
      if (aiSecretKeyPattern.test(key)) {
        acc[key] = '[hidden security field]';
      } else {
        acc[key] = sanitizeForAI(val, depth + 1);
      }
      return acc;
    }, {});
  };
  const fullAppData = sanitizeForAI({
    visibleFactories: typeof FactoryDB !== 'undefined' ? FactoryDB.getFactories() : [],
    selectedFactory: CURRENT_FACTORY || null,
    currentUser: {
      uid: CURRENT_USER?.uid || '',
      email: CURRENT_USER?.email || '',
      name: CURRENT_USER_NAME || '',
      role: CURRENT_ROLE || '',
      effectiveOwnerUid: EFFECTIVE_OWNER_UID || ''
    },
    factoryTables: {
      settings,
      workers,
      daily_logs: logs,
      activities: DB.get('activities') || [],
      credits,
      broiler_cycles: DB.get('broiler_cycles') || [],
      broiler_logs: DB.get('broiler_logs') || [],
      broiler_partners: DB.get('broiler_partners') || [],
      broiler_partner_txs: DB.get('broiler_partner_txs') || [],
      broiler_settings: DB.get('broiler_settings') || {},
      broiler_slaughter: DB.get('broiler_slaughter') || []
    }
  });

  const context = {
    generatedAt: new Date().toISOString(),
    aiPermissions: {
      level: 'full_app_read',
      canRead: [
        'factory settings',
        'partners and partner shares',
        'workers and advances',
        'daily egg records',
        'credits/debts',
        'activities',
        'broiler cycles',
        'broiler daily records',
        'broiler partners and transactions',
        'broiler sales/slaughter records'
      ],
      canWriteOrDelete: false,
      hiddenSecurityFields: 'passwords, API keys, tokens, developer/delete/cycle codes'
    },
    currentFactory: {
      id: CURRENT_FACTORY?.id || '',
      name: CURRENT_FACTORY?.name || settings.farmName || 'deku',
      type: CURRENT_FACTORY?.type === 'broiler' ? 'broiler_meat_factory' : 'layer_egg_factory',
      userRole: CURRENT_ROLE || '',
      readOnlyView: typeof cannotDoDailyEntry === 'function' ? cannotDoDailyEntry() : false
    },
    layerSettings: {
      farmName: settings.farmName || CURRENT_FACTORY?.name || '',
      ownerName: settings.owner || '',
      ownerSharePercent: Number(settings.ownerShare ?? 100),
      layingHens: Number(settings.chickens || settings.initialChickens) || 0,
      initialChickens: Number(settings.initialChickens) || 0,
      chickenPrice: Number(settings.chickenPrice) || 0,
      initialFeedKg: Number(settings.initialFeed) || 0,
      feedPrice: Number(settings.feedPrice) || 0,
      monthlyRent: Number(settings.loyer) || 0,
      monthlyElectricity: Number(settings.electricity) || 0,
      brokenAlertPercent: Number(settings.brokenAlertPct) || 5,
      feedAlertKg: Number(settings.feedAlertThreshold) || 100
    },
    fullAppData,
    partners,
    workers: workerSummary,
    faida: {
      todayNetFaida,
      thisMonthNetFaida,
      totalGrossDailyFaida: allTimeSummary.baseProfit,
      totalFixedDeductions,
      netFaidaTotal,
      netFaidaTotalLabel: 'الفائدة الإجمالية الصافية الكلية',
      calculation: 'netFaidaTotal = totalGrossDailyFaida - totalFixedDeductions'
    },
    legacyAIFields: {
      date: today,
      salesTotal: todaySummary.income,
      feedCost: todaySummary.feedCost,
      laborCost: workerSummary.reduce((s, w) => s + (Number(w.salary) || 0), 0),
      electricityCost: Number(settings.electricity) || 0,
      waterCost: todaySummary.waterCost,
      totalNetProfit: netFaidaTotal,
      faidaTotal: netFaidaTotal,
      todayProfit: todayNetFaida,
      thisMonthProfit: thisMonthNetFaida
    },
    credits: {
      total: creditSummary.reduce((s, c) => s + (Number(c.amount) || 0), 0),
      items: creditSummary.slice(0, 20)
    },
    layerSummary: {
      today: todaySummary,
      thisMonth: monthSummary,
      allTime: allTimeSummary,
      stock: {
        eggStockPlates,
        eggStockApproxEggs: eggStockPlates * 30,
        feedStockKg: feedBalance
      },
      profit: {
        netFaidaTotal,
        todayNetFaida,
        thisMonthNetFaida,
        totalNetProfitAfterFixedCosts: typeof getTotalNetProfit === 'function' ? getTotalNetProfit() : allTimeSummary.netProfit,
        expectedMonthlyProfit: typeof getExpectedMonthlyProfit === 'function' ? getExpectedMonthlyProfit() : 0,
        brokenLossThisMonth: typeof getTotalBrokenLossThisMonth === 'function' ? getTotalBrokenLossThisMonth() : 0,
        workerAdvancesTotal: typeof getTotalAdvances === 'function' ? getTotalAdvances() : 0
      },
      recentDays: sortedLogs.slice(0, 14).map(l => ({
        date: l.date,
        producedPlates: Number(l.produced) || 0,
        brokenPlates: Number(l.broken) || 0,
        soldPlates: Number(l.soldTotal) || ((Number(l.soldGroups) || 0) * 12) + (Number(l.soldSingle) || 0),
        pricePerPlate: Number(l.price) || 0,
        income: Number(l.income) || 0,
        feedUsedKg: Number(l.feedUsed) || 0,
        waterCost: Number(l.waterCost) || 0,
        baseProfit: Number(l.baseProfit ?? l.profit) || 0,
        netProfit: Number(l.profit ?? l.baseProfit) || 0,
        notes: l.notes || ''
      }))
    },
    units: {
      plate: 'one plate equals 30 eggs',
      carton: 'one carton equals 12 plates'
    }
  };

  if (CURRENT_FACTORY?.type === 'broiler') {
    const cycles = DB.get('broiler_cycles') || [];
    const broilerLogs = DB.get('broiler_logs') || [];
    const sales = DB.get('broiler_slaughter') || [];
    const broilerPartners = DB.get('broiler_partners') || [];
    const broilerSettings = DB.get('broiler_settings') || {};
    const activeCycle = cycles.find(c => c.status === 'active') || null;
    const cycleLogs = activeCycle ? broilerLogs.filter(l => l.cycleId === activeCycle.id) : [];
    const cycleSales = activeCycle ? sales.filter(s => s.cycleId === activeCycle.id) : [];
    const totalDead = cycleLogs.reduce((s, l) => s + (Number(l.dead) || 0), 0);
    const totalFeedKg = cycleLogs.reduce((s, l) => s + (Number(l.feedKg) || 0), 0);
    const totalFeedCost = cycleLogs.reduce((s, l) => s + ((Number(l.feedKg) || 0) * (Number(l.feedPrice) || 0)), 0);
    const totalWaterMeds = cycleLogs.reduce((s, l) => s + (Number(l.waterCost) || 0) + (Number(l.medsCost) || 0), 0);
    const totalSalesIncome = cycleSales.reduce((s, sl) => s + (Number(sl.income) || 0), 0);
    const totalPaid = cycleSales.reduce((s, sl) => s + (Number(sl.paidAmount) || 0), 0);
    const initialCost = activeCycle
      ? ((Number(activeCycle.chicksCount) || 0) * (Number(activeCycle.chickPrice) || 0))
        + (Number(activeCycle.beddingCost) || 0)
        + (Number(activeCycle.heatingCost) || 0)
      : 0;

    context.broiler = {
      settings: {
        ownerSharePercent: Number(broilerSettings.ownerShare ?? 100),
        rent: Number(broilerSettings.loyer) || 0,
        electricity: Number(broilerSettings.electricity) || 0,
        misc: Number(broilerSettings.misc) || 0,
        mortalityAlertPercent: Number(broilerSettings.mortAlert) || 5
      },
      activeCycle: activeCycle ? {
        name: activeCycle.name,
        startDate: activeCycle.startDate,
        chicksCount: Number(activeCycle.chicksCount) || 0,
        chickPrice: Number(activeCycle.chickPrice) || 0,
        currentDay: typeof getDayOfCycle === 'function' ? getDayOfCycle(activeCycle) : 0,
        deadTotal: totalDead,
        remainingBirds: (Number(activeCycle.chicksCount) || 0) - totalDead,
        mortalityPercent: activeCycle.chicksCount ? (totalDead / Number(activeCycle.chicksCount)) * 100 : 0,
        totalFeedKg,
        totalFeedCost,
        waterAndMedicineCost: totalWaterMeds,
        initialCost,
        salesIncome: totalSalesIncome,
        unpaidSales: totalSalesIncome - totalPaid,
        estimatedProfit: totalSalesIncome - initialCost - totalFeedCost - totalWaterMeds,
        recentDays: cycleLogs.slice(-14).map(l => ({
          date: l.date,
          dayNum: l.dayNum,
          dead: Number(l.dead) || 0,
          feedKg: Number(l.feedKg) || 0,
          feedPrice: Number(l.feedPrice) || 0,
          avgWeight: Number(l.avgWeight) || 0,
          waterCost: Number(l.waterCost) || 0,
          medsCost: Number(l.medsCost) || 0,
          notes: l.notes || ''
        })),
        sales: cycleSales.slice(-12).map(s => ({
          date: s.date,
          count: Number(s.count) || 0,
          liveWeight: Number(s.liveWeight) || 0,
          pricePerKg: Number(s.pricePerKg) || 0,
          buyer: s.buyer || '',
          income: Number(s.income) || 0,
          paidAmount: Number(s.paidAmount) || 0,
          paymentType: s.paymentType || ''
        }))
      } : null,
      completedCyclesCount: cycles.filter(c => c.status === 'completed').length,
      partners: broilerPartners.map(p => ({
        name: p.name || '',
        sharePercent: Number(p.sharePercent) || 0
      }))
    };
  }

  return context;
}

/* The assistant now lives on the factory-selection screen, so it must see
   EVERYTHING: every factory, every supplier invoice, every worker month and
   the بلاكة ledger — not just the factory that happens to be open. */
function getGlobalContextForAI() {
  const savedFactory = CURRENT_FACTORY;
  const savedOwner = EFFECTIVE_OWNER_UID;
  const ctx = { scope: 'global', generatedAt: new Date().toISOString(), factories: [] };

  try {
    const factories = (typeof FactoryDB !== 'undefined') ? FactoryDB.getFactories() : [];
    factories.forEach(f => {
      try {
        CURRENT_FACTORY = f;
        if (f.ownerUid) EFFECTIVE_OWNER_UID = f.ownerUid;
        ctx.factories.push({
          id: f.id, name: f.name, type: f.type || 'layer',
          data: getBusinessContextForAI()
        });
      } catch (e) {
        ctx.factories.push({ id: f.id, name: f.name, error: String(e && e.message || e) });
      }
    });
  } finally {
    CURRENT_FACTORY = savedFactory;
    EFFECTIVE_OWNER_UID = savedOwner;
  }

  // ---- suppliers (دفعات الشراء) ----
  try {
    const sups = getSuppliers();
    const tx = getSupplierTx();
    const invs = getSupplierInvoices();
    ctx.suppliers = sups.map(s => {
      const mine = tx.filter(t => t.supplierId === s.id);
      return {
        name: s.name,
        balance: supplierBalance(s.id),
        totalGoods: mine.filter(t => t.kind === 'goods').reduce((a, t) => a + (Number(t.amount) || 0), 0),
        totalPaid: mine.filter(t => t.kind === 'payment').reduce((a, t) => a + (Number(t.amount) || 0), 0),
        transactionCount: mine.length,
        invoices: invs.filter(i => i.supplierId === s.id).map(i => ({
          date: i.date, goods: i.sumGoods, payments: i.sumPayments, balance: i.closingBalance
        })),
        recentTransactions: mine.slice(-40).map(t => ({
          date: t.date, kind: t.kind, amount: t.amount,
          warehouse: t.warehouse, note: t.note, invoiceDate: t.invoiceDate
        }))
      };
    });
  } catch (e) { ctx.suppliersError = String(e && e.message || e); }

  // ---- workers by type ----
  try {
    const types = getWorkerTypes();
    const months = getWorkerMonths();
    const draws = getWorkerDraws();
    ctx.workerTypes = types.map(t => {
      const tm = months.filter(m => m.typeId === t.id);
      const accounts = {};
      tm.forEach(m => {
        if (!accounts[m.accountKey]) {
          accounts[m.accountKey] = { name: m.name, assign: m.assign, months: [] };
        }
        accounts[m.accountKey].months.push({
          month: m.monthKey, wage: m.wage, withdrawn: m.total, balance: m.balance
        });
      });
      return {
        type: t.name,
        workerCount: Object.keys(accounts).length,
        totalWithdrawn: tm.reduce((a, m) => a + (Number(m.total) || 0), 0),
        workers: Object.keys(accounts).map(k => accounts[k]),
        drawCount: draws.filter(d => d.typeId === t.id).length
      };
    });
  } catch (e) { ctx.workersError = String(e && e.message || e); }

  // ---- بلاكة ----
  try {
    const locs = getPlakaLocations();
    const ptx = getPlakaTx();
    ctx.plaka = {
      suppliers: [...new Set(locs.map(l => l.supplier || 'سليم'))],
      totalGoods: locs.reduce((a, l) => a + (Number(l.fileGoods) || 0), 0),
      totalPaid: locs.reduce((a, l) => a + (Number(l.filePay) || 0), 0),
      balance: locs.reduce((a, l) => a + (Number(l.fileBalance) || 0), 0),
      locations: locs.map(l => ({
        name: l.name, goods: l.fileGoods, paid: l.filePay, balance: l.fileBalance,
        transactions: ptx.filter(t => t.locationId === l.id).length
      }))
    };
  } catch (e) { ctx.plakaError = String(e && e.message || e); }

  return ctx;
}

function openAIAssistant() {
  const modal = document.getElementById('modal-ai-chat');
  if (!modal) return;
  modal.classList.add('open');
  // The assistant lives in a modal now (no more page-ai-chat), so nothing else
  // binds its buttons — wire them here on first open, otherwise the send
  // button, Enter key and suggestion chips stay dead.
  if (!_aiPageInitialized) {
    initAIChatPage();
    _aiPageInitialized = true;
  } else {
    checkAIStatus();
  }
  const input = document.getElementById('ai-input');
  if (input) setTimeout(() => input.focus(), 100);
}
window.openAIAssistant = openAIAssistant;

async function checkAIStatus() {
  const dot = document.querySelector('#ai-status-indicator .ai-status-dot');
  const text = document.getElementById('ai-status-text');
  const errBox = document.getElementById('ai-error-box');
  const errText = document.getElementById('ai-error-text');

  if (dot) { dot.className = 'ai-status-dot checking'; }
  if (text) text.textContent = 'جاري الفحص...';
  if (errBox) errBox.style.display = 'none';

  try {
    const res = await fetch(`${AI_BACKEND_URL}/api/ai/status`);
    const data = await res.json();

    if (data.online && data.modelInstalled) {
      _aiIsOnline = true;
      if (dot) dot.className = 'ai-status-dot online';
      if (text) text.textContent = `متصل — النموذج: ${data.model}`;
      if (errBox) errBox.style.display = 'none';
    } else if (data.online && !data.modelInstalled) {
      _aiIsOnline = false;
      if (dot) dot.className = 'ai-status-dot offline';
      if (text) text.textContent = 'النموذج غير مثبت';
      if (errBox) errBox.style.display = 'flex';
      if (errText) errText.textContent = data.error || 'النموذج غير مثبت.';
    } else {
      _aiIsOnline = false;
      if (dot) dot.className = 'ai-status-dot offline';
      if (text) text.textContent = 'غير متصل';
      if (errBox) errBox.style.display = 'flex';
      if (errText) errText.textContent = data.error || 'Ollama غير مشغل.';
    }
  } catch (err) {
    _aiIsOnline = false;
    if (dot) dot.className = 'ai-status-dot offline';
    if (text) text.textContent = 'غير متصل';
    if (errBox) errBox.style.display = 'flex';
    if (errText) errText.textContent = 'تعذر الاتصال بالسيرفر. تأكد من تشغيل Backend على المنفذ 5000.';
  }
}

function addAIChatMessage(role, content) {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;

  const welcome = container.querySelector('.ai-welcome-msg');
  if (welcome) welcome.remove();

  const msgDiv = document.createElement('div');
  msgDiv.className = `ai-msg ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'ai-msg-avatar';
  avatar.textContent = role === 'user' ? '👤' : '🤖';

  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';
  bubble.textContent = content;

  msgDiv.appendChild(avatar);
  msgDiv.appendChild(bubble);
  container.appendChild(msgDiv);

  container.scrollTop = container.scrollHeight;
}

function showAITyping() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;

  const existing = container.querySelector('.ai-typing');
  if (existing) existing.remove();

  const typing = document.createElement('div');
  typing.className = 'ai-typing';
  typing.innerHTML = '<div class="ai-typing-dots"><span></span><span></span><span></span></div><span>المساعد يفكر...</span>';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

function hideAITyping() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) {
    return;
  }
  const typing = container.querySelector('.ai-typing');
  if (typing) typing.remove();
}

async function sendAIMessage(messageText) {
  if (_aiIsSending || !messageText || messageText.trim().length === 0) return;

  const input = document.getElementById('ai-input');
  const sendBtn = document.getElementById('btn-ai-send');

  _aiIsSending = true;
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.value = '';
  updateAICharCount();

  addAIChatMessage('user', messageText.trim());
  showAITyping();

  try {
    // Global scope: the assistant answers about any factory, supplier,
    // worker or بلاكة record in the app, not only the open factory.
    const businessContext = getGlobalContextForAI();
    const res = await fetch(`${AI_BACKEND_URL}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: messageText.trim(),
        businessContext,
        history: _aiChatHistory.slice(-10)
      })
    });

    hideAITyping();

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData.error || 'حدث خطأ. حاول مرة أخرى.';
      addAIChatMessage('assistant', '⚠️ ' + errMsg);
      return;
    }

    const data = await res.json();
    const reply = data.reply || 'لم أستطع توليد رد.';

    addAIChatMessage('assistant', reply);
    _aiChatHistory.push({ role: 'user', content: messageText.trim() });
    _aiChatHistory.push({ role: 'assistant', content: reply });

    if (_aiChatHistory.length > 20) {
      _aiChatHistory = _aiChatHistory.slice(-20);
    }

  } catch (err) {
    hideAITyping();
    addAIChatMessage('assistant', '⚠️ تعذر الاتصال بالسيرفر. تأكد من تشغيل Backend وOllama.');
  } finally {
    _aiIsSending = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

function clearAIChat() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;
  container.innerHTML = `
    <div class="ai-welcome-msg">
      <div class="ai-welcome-icon">🤖</div>
      <div class="ai-welcome-title">مرحبا بك في مساعد مصنع البيض الذكي</div>
      <div class="ai-welcome-sub">اسألني عن الإنتاج، الأرباح، المصاريف، المخزون، أو أي شيء يخص مصنعك</div>
    </div>`;
  _aiChatHistory = [];
}

function updateAICharCount() {
  const input = document.getElementById('ai-input');
  const counter = document.getElementById('ai-char-count');
  if (input && counter) {
    counter.textContent = `${input.value.length} / 2000`;
  }
}

function initAIChatPage() {
  checkAIStatus();

  document.getElementById('btn-check-ai-status')?.addEventListener('click', checkAIStatus);

  document.getElementById('btn-ai-send')?.addEventListener('click', () => {
    const input = document.getElementById('ai-input');
    if (input && input.value.trim()) sendAIMessage(input.value);
  });

  document.getElementById('ai-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const input = document.getElementById('ai-input');
      if (input && input.value.trim()) sendAIMessage(input.value);
    }
  });

  document.getElementById('ai-input')?.addEventListener('input', updateAICharCount);

  document.getElementById('btn-ai-clear')?.addEventListener('click', clearAIChat);

  document.querySelectorAll('.ai-suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.getAttribute('data-q');
      if (q) sendAIMessage(q);
    });
  });
}

function renderAIChatPage() {
  if (!_aiPageInitialized) {
    initAIChatPage();
    _aiPageInitialized = true;
  } else {
    checkAIStatus();
  }
}

/* =====================================================================
   END AI CHAT MODULE
   ===================================================================== */

// Global Enter key navigation for inputs
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    const activeEl = document.activeElement;
    if (activeEl && ['INPUT', 'SELECT'].includes(activeEl.tagName)) {
      // Ignore if it has custom onkeydown matching Enter
      if (activeEl.hasAttribute('onkeydown') && activeEl.getAttribute('onkeydown').includes('Enter')) return;
      
      const form = activeEl.closest('form, .form-card, .modal-box, .section-card, .inline-form, .auth-form');
      if (!form) return;
      
      const focusable = Array.from(form.querySelectorAll('input:not([disabled]):not([type="hidden"]), select:not([disabled]), button[id^="btn-"]:not([disabled]), .btn:not([disabled])'))
                               .filter(el => el.offsetParent !== null && !el.classList.contains('btn-remove-adv') && !el.classList.contains('auth-eye-btn'));
      
      const idx = focusable.indexOf(activeEl);
      if (idx > -1 && idx < focusable.length - 1) {
        e.preventDefault();
        const nextEl = focusable[idx + 1];
        if (nextEl.tagName === 'BUTTON') {
          nextEl.click();
        } else {
          nextEl.focus();
        }
      }
    }
  }
});
/* =====================================================================
   EXIT FACTORY
   ===================================================================== */
function exitFactory() {
  document.getElementById('factory-screen').classList.remove('hidden');
  document.body.classList.remove('sidebar-open');
  CURRENT_FACTORY = null;
}

/* =====================================================================
   GLOBAL CREDITS SYSTEM
   ===================================================================== */
function toggleGlobalCreditsOLD() {
  const popup = document.getElementById('global-credits-popup');
  if (!popup) return;
  if (popup.style.display !== 'none') {
    popup.style.display = 'none';
  } else {
    popup.style.display = 'block';
    renderGlobalCredits();
  }
}

function getGlobalCreditsKey() {
  const uid = EFFECTIVE_OWNER_UID || CURRENT_USER?.uid;
  return `zohir_global_credits_${uid}`;
}

function getGlobalCredits() {
  return JSON.parse(localStorage.getItem(getGlobalCreditsKey()) || '[]');
}

function setGlobalCredits(arr) {
  localStorage.setItem(getGlobalCreditsKey(), JSON.stringify(arr));
}

function renderGlobalCredits() {
  const contentEl = document.getElementById('global-credits-content');
  if (!contentEl) return;
  const credits = getGlobalCredits();

  if (!credits.length) {
    contentEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px">لا توجد أي ديون مسجلة.</div>';
    return;
  }

  // Aggregate by client
  const clients = {};
  credits.forEach(c => {
    const name = c.clientName || 'بدون اسم';
    if (!clients[name]) clients[name] = 0;
    // debts are positive, payments are negative
    if (c.type === 'payment') {
      clients[name] -= Number(c.amount);
    } else {
      clients[name] += Number(c.amount);
    }
  });

  const activeClients = Object.keys(clients); // Fixed to include all clients

  if (!activeClients.length) {
    contentEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px">لا توجد ديون نشطة.</div>';
    return;
  }

  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:12px">';
  activeClients.forEach(clientName => {
    const totalDebt = clients[clientName];
    html += `
      <div class="kpi-card" style="cursor:pointer;border:1px solid rgba(72,187,120,0.3)" onclick="showClientDetails('${clientName}')">
        <div style="font-size:1.1rem;font-weight:700;margin-bottom:8px">👤 ${clientName}</div>
        <div style="color:var(--red);font-weight:800;font-size:1.2rem">${fmt(totalDebt, 'دج')}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px">انقر لعرض السجل بالتفصيل</div>
      </div>
    `;
  });
  html += '</div>';

  contentEl.innerHTML = html;
}

function addManualGlobalCredit() {
  const clientInput = document.getElementById('gcredit-client');
  const amountInput = document.getElementById('gcredit-amount');
  const descInput = document.getElementById('gcredit-desc');

  const clientName = clientInput.value.trim();
  const amount = Number(amountInput.value) || 0; // Fixed to allow 0 amount
  const desc = descInput.value.trim();

  if (!clientName) {
    return showToast('الرجاء إدخال اسم الزبون', 'error');
  }

  const credits = getGlobalCredits();
  credits.push({
    id: Date.now(),
    date: todayStr(),
    clientName,
    factoryId: 'manual',
    factoryName: 'إضافة يدوية',
    description: desc || 'دين من إضافة يدوية',
    amount,
    type: 'debt'
  });
  setGlobalCredits(credits);

  clientInput.value = '';
  amountInput.value = '';
  descInput.value = '';

  showToast('تم إضافة الدين بنجاح');
  renderGlobalCredits();
}

let _currentViewClient = null;

function showClientDetails(clientName) {
  _currentViewClient = clientName;
  const credits = getGlobalCredits().filter(c => c.clientName === clientName);
  
  // Sort by date desc
  credits.sort((a, b) => parseDateKey(b.date) - parseDateKey(a.date));

  const modal = document.getElementById('modal-client-credits');
  document.getElementById('client-credits-title').textContent = `سجل الديون لزبون: ${clientName}`;
  document.getElementById('client-pay-amount').value = '';

  let html = `
    <table class="data-table" style="margin-top:10px">
      <thead>
        <tr>
          <th>التاريخ</th>
          <th>المصدر</th>
          <th>الوصف</th>
          <th>دين (أخذ)</th>
          <th>سداد (دفع)</th>
        </tr>
      </thead>
      <tbody>
  `;

  let totalDebt = 0;
  credits.forEach(c => {
    const isPay = c.type === 'payment';
    if (isPay) totalDebt -= Number(c.amount);
    else totalDebt += Number(c.amount);

    html += `
      <tr>
        <td>${fmtDate(c.date)}</td>
        <td><span class="chip chip-gray">${c.factoryName || 'غير محدد'}</span></td>
        <td style="font-size:0.8rem">${c.description || '-'}</td>
        <td style="color:var(--red)">${!isPay ? fmt(c.amount) : '-'}</td>
        <td style="color:var(--green);font-weight:bold">${isPay ? fmt(c.amount) : '-'}</td>
      </tr>
    `;
  });

  html += `
      <tr style="background:rgba(0,0,0,0.2)">
        <td colspan="3" style="text-align:left;font-weight:bold">الرصيد الكلي:</td>
        <td colspan="2" style="font-weight:bold;font-size:1.1rem;color:var(--red)">${fmt(totalDebt, 'دج')}</td>
      </tr>
      </tbody>
    </table>
  `;

  document.getElementById('client-credits-history').innerHTML = html;
  modal.classList.add('open');
}

function addGlobalCreditPayment() {
  if (!_currentViewClient) return;
  const amountInput = document.getElementById('client-pay-amount');
  const amount = Number(amountInput.value);

  if (!amount || amount <= 0) {
    return showToast('الرجاء إدخال مبلغ صحيح', 'error');
  }

  const credits = getGlobalCredits();
  credits.push({
    id: Date.now(),
    date: todayStr(),
    clientName: _currentViewClient,
    factoryId: 'payment',
    factoryName: 'تسديد ديون',
    description: 'تسديد دفعة نقدية',
    amount,
    type: 'payment'
  });
  setGlobalCredits(credits);

  amountInput.value = '';
  showToast('تم تسجيل الدفعة بنجاح!');
  showClientDetails(_currentViewClient); // refresh modal
  renderGlobalCredits(); // refresh cards behind it
}

function deleteCurrentGlobalClient() {
  if (!_currentViewClient) return;
  if (!confirm(`هل أنت متأكد من حذف حساب الزبون "${_currentViewClient}" بجميع عملياته؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
  
  const credits = getGlobalCredits().filter(c => c.clientName !== _currentViewClient);
  setGlobalCredits(credits);
  
  document.getElementById('modal-client-credits').classList.remove('open');
  showToast('تم حذف حساب الزبون بنجاح');
  renderGlobalCredits();
}

function migrateCreditsOnce() {
  const uid = EFFECTIVE_OWNER_UID || CURRENT_USER?.uid;
  if (!uid) return;
  const migratedKey = `zohir_credits_migrated_${uid}`;
  if (localStorage.getItem(migratedKey)) return; // already migrated

  const factoriesKey = `zohir_factories_${uid}`;
  const factories = JSON.parse(localStorage.getItem(factoriesKey) || '[]');
  
  let globalCredits = getGlobalCredits();
  let migratedCount = 0;

  for (const f of factories) {
    const localDbKey = `zohir_${uid}_${f.id}`;
    const rawLocal = localStorage.getItem(localDbKey);
    if (!rawLocal) continue;
    
    try {
      const localObj = JSON.parse(rawLocal);
      if (localObj.credits && Array.isArray(localObj.credits) && localObj.credits.length > 0) {
        // Move local credits to global
        localObj.credits.forEach(c => {
          globalCredits.push({
            id: c.id || Date.now() + Math.random(),
            date: c.date || todayStr(),
            clientName: c.clientName || 'زبون من الأرشيف',
            factoryId: f.id,
            factoryName: f.name,
            description: c.description || 'نقل من النظام القديم',
            amount: c.amount,
            type: 'debt'
          });
          migratedCount++;
        });
        // Clear local credits
        localObj.credits = [];
        localStorage.setItem(localDbKey, JSON.stringify(localObj));
      }
    } catch(err) {
      console.warn("Migration error on factory", f.id, err);
    }
  }

  if (migratedCount > 0) {
    setGlobalCredits(globalCredits);
    console.log(`Migrated ${migratedCount} credits to global system.`);
  }

  localStorage.setItem(migratedKey, 'true');
}



window.factoryToDelete = null;
window.confirmDeleteFactory = function(e, id, name) {
  e.stopPropagation();
  e.preventDefault();
  window.factoryToDelete = { id: id, name: name };
  const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.getElementById('delete-factory-message').innerHTML = `هل أنت متأكد من حذف هذا المصنع "<b>${safeName}</b>"؟<br><strong style="color:var(--red)">تأكيد نهائي: سيتم مسح جميع بيانات المصنع بشكل دائم.</strong>`;
  document.getElementById('modal-delete-factory').classList.add('open');
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-confirm-delete-factory')?.addEventListener('click', () => {
    if (!window.factoryToDelete) return;
    document.getElementById('modal-delete-factory').classList.remove('open');
    FactoryDB.deleteFactory(window.factoryToDelete.id);
    renderFactoryScreen();
    showToast('تم حذف المصنع بنجاح', 'warning');
    window.factoryToDelete = null;
  });
});


window.toggleProfitSummary = function() {
  const popup = document.getElementById('profit-summary-popup');
  if (popup.style.display === 'none' || popup.style.display === '') {
    popup.style.display = 'block';
    renderGlobalProfitSummary();
  } else {
    popup.style.display = 'none';
  }
};

window.renderGlobalProfitSummary = function() {
  const container = document.getElementById('profit-summary-content');
  if (!container) return;
  
  const allFactories = FactoryDB.getFactories();
  let totalFaida = 0;
  
  allFactories.forEach(f => {
    try {
      const logs = JSON.parse(localStorage.getItem(`zohir_${f.id}_daily_logs`)) || [];
      const settings = JSON.parse(localStorage.getItem(`zohir_${f.id}_settings`)) || {};
      
      if (f.type === 'broiler') {
        const cycles = JSON.parse(localStorage.getItem(`zohir_${f.id}_broiler_cycles`)) || [];
        // calculate broiler profit...
      } else {
        const summary = sumLayerLogs(logs);
        totalFaida += (summary.baseProfit || 0);
      }
    } catch(e){}
  });
  
  container.innerHTML = `<div style="text-align:center">
    <h3>إجمالي الأرباح لجميع المصانع</h3>
    <p style="font-size:1.5rem;color:var(--gold);margin-top:10px">${fmt(totalFaida, 'دج')}</p>
  </div>`;
};


/* ===================== SMART EXCEL FACTORY IMPORT ===================== */
/**
 * Smart import from Excel:
 * - Reads all sheets in the file
 * - Detects data type from sheet name or column headers
 *   (production/daily_logs, workers, credits/debts, settings, broiler_cycles, etc.)
 * - Groups rows by factory name column if present (separates multi-factory sheets)
 * - Creates or updates a factory per unique factory name found
 * - Saves data to localStorage and optionally syncs to cloud
 */




document.addEventListener('DOMContentLoaded', () => {
  const btnImport = document.getElementById('btn-import-factory');
  const inputImport = document.getElementById('factory-import-input');
  if (btnImport && inputImport) {
    // Keep the original input. Cloning it here can detach a listener that
    // another page initializer has already attached, leaving the button
    // apparently unresponsive.
    btnImport.addEventListener('click', () => {
      inputImport.value = '';
      inputImport.click();
    });

    inputImport.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleFactoryImport(file);
    });
  }
});


/* ===================== SMART EXCEL EXPORT ===================== */
window.exportFactoryData = function() {
  if (typeof XLSX === 'undefined') {
    showToast('مكتبة Excel غير محملة. يرجى التحقق من اتصالك.', 'error');
    return;
  }
  
  const uid = CURRENT_USER?.uid;
  if (!uid) {
    showToast('يجب تسجيل الدخول أولاً', 'error');
    return;
  }

  showToast('جاري تجهيز بيانات المصانع للتصدير...', 'info');
  try {
    const allFactories = JSON.parse(localStorage.getItem(`zohir_factories_${uid}`)) || [];
    if (!allFactories.length) {
      showToast('لا توجد مصانع لتصديرها.', 'error');
      return;
    }

    const wb = XLSX.utils.book_new();

    let allDaily = [];
    let allWorkers = [];
    let allCredits = [];
    let allSettings = [];

    allFactories.forEach(f => {
      const logs = JSON.parse(localStorage.getItem(`zohir_${f.id}_daily_logs`)) || [];
      const workers = JSON.parse(localStorage.getItem(`zohir_${f.id}_workers`)) || [];
      const credits = JSON.parse(localStorage.getItem(`zohir_${f.id}_credits`)) || [];
      const settings = JSON.parse(localStorage.getItem(`zohir_${f.id}_settings`)) || {};
      
      logs.forEach(l => { l['المصنع'] = f.name; allDaily.push(l); });
      workers.forEach(w => { w['المصنع'] = f.name; allWorkers.push(w); });
      credits.forEach(c => { c['المصنع'] = f.name; allCredits.push(c); });
      settings['المصنع'] = f.name;
      allSettings.push(settings);
    });

    if (allDaily.length) {
      const wsDaily = XLSX.utils.json_to_sheet(allDaily);
      XLSX.utils.book_append_sheet(wb, wsDaily, 'الإنتاج_والمبيعات');
    }
    if (allWorkers.length) {
      const wsWorkers = XLSX.utils.json_to_sheet(allWorkers);
      XLSX.utils.book_append_sheet(wb, wsWorkers, 'العمال');
    }
    if (allCredits.length) {
      const wsCredits = XLSX.utils.json_to_sheet(allCredits);
      XLSX.utils.book_append_sheet(wb, wsCredits, 'الديون_والتسديدات');
    }
    if (allSettings.length) {
      const wsSettings = XLSX.utils.json_to_sheet(allSettings);
      XLSX.utils.book_append_sheet(wb, wsSettings, 'إعدادات_المصانع');
    }

    XLSX.writeFile(wb, 'Zohir_Factories_Export_' + new Date().toISOString().slice(0,10) + '.xlsx');
    showToast('تم تصدير البيانات بنجاح!', 'success');

  } catch(e) {
    console.error(e);
    showToast('حدث خطأ أثناء التصدير: ' + e.message, 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const btnExport = document.getElementById('btn-export-factory');
  if (btnExport) {
    const newExportBtn = btnExport.cloneNode(true);
    btnExport.parentNode.replaceChild(newExportBtn, btnExport);
    newExportBtn.addEventListener('click', () => {
      exportFactoryData();
    });
  }
});
/* ===================== END SMART EXCEL EXPORT ===================== */

async function handleFactoryImport(file) {
  if (typeof XLSX === 'undefined') {
    showToast('مكتبة Excel غير محملة', 'error');
    return;
  }
  
  showToast('جاري قراءة الملف وتحليل البيانات...', 'info');
  
  try {
    const arrayBuffer = await file.arrayBuffer();
    // Keep Excel dates as serial numbers.  Converting them to JavaScript
    // Date objects first makes midnight timezone-dependent and shifts a
    // row such as 23/07 to 22/07.  normalizeDate converts the serial using
    // the Excel epoch in UTC instead.
    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
    
    const allLogs = {};
    
    function normAr(s) {
      return String(s).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
    }
    
    function parseNumber(val) {
      if (val === null || val === undefined || val === '') return 0;
      if (typeof val === 'number') return val;
      const s = String(val).replace(/,/g, '.').replace(/[^\d.\-]/g, '');
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    }
    
    function normalizeDate(d) {
      if (!d) return null;
      // SheetJS returns Excel dates as Date objects.  Do not use
      // toISOString() here: it converts local midnight to the previous
      // calendar day in time zones east of UTC (e.g. Algeria/France).
      const excelDateKey = (date) => {
        if (!(date instanceof Date) || isNaN(date.getTime())) return null;
        // SheetJS may materialize an Excel date at local midnight.  Reading
        // its local fields or calling toISOString() can move it one day.
        // UTC fields preserve the calendar date encoded by Excel.
        return date.getUTCFullYear() + '-' +
          String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
          String(date.getUTCDate()).padStart(2, '0');
      };

      if (d instanceof Date) return excelDateKey(d);
      
      const s = String(d).trim();
      
      // French & Arabic dates: "1 juillet 2026" or "1 جويلية 2026"
      const frMonths = {
        'janvier':'01','fevrier':'02','février':'02','mars':'03','avril':'04',
        'mai':'05','juin':'06','juillet':'07','aout':'08','août':'08',
        'septembre':'09','octobre':'10','novembre':'11','decembre':'12','décembre':'12',
        'جانفي':'01','فيفري':'02','مارس':'03','افريل':'04','أفريل':'04',
        'ماي':'05','جوان':'06','جويلية':'07','اوت':'08','أوت':'08',
        'سبتمبر':'09','اكتوبر':'10','أكتوبر':'10','نوفمبر':'11','ديسمبر':'12'
      };
      
      const textMatch = s.match(/(\d{1,2})\s+([a-zéûôàèأ-ي]+)\s+(\d{4})/i);
      if (textMatch) {
        const day = textMatch[1].padStart(2,'0');
        const month = frMonths[textMatch[2].toLowerCase()];
        if (month) return textMatch[3] + '-' + month + '-' + day;
      }
      
      // dd/mm/yyyy or dd-mm-yyyy
      const parts = s.split(/[\/\-]/);
      if (parts.length === 3) {
        const a = parts[0].trim(), b = parts[1].trim(), c = parts[2].trim();
        if (a.length === 4) return a + '-' + b.padStart(2,'0') + '-' + c.padStart(2,'0');
        if (c.length === 4) return c + '-' + b.padStart(2,'0') + '-' + a.padStart(2,'0');
        if (c.length === 2) return '20' + c + '-' + b.padStart(2,'0') + '-' + a.padStart(2,'0');
      }
      
      // Excel serial number (e.g. 46205)
      if (/^\d{4,5}$/.test(s)) {
        const jsDate = new Date(Date.UTC(1899, 11, 30) + parseInt(s) * 86400000);
        return excelDateKey(jsDate);
      }
      
      return null;
    }

    // اسم المصنع = اسم الملف بدون الامتداد
    const mainFactoryName = file.name.replace(/\.xlsx?|\.csv/i, '').trim();
    const isMultiSheet = workbook.SheetNames.length > 1;
    const childGroupNames = {};

    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rawRows.length) return;
      
      // === إيجاد سطر العناوين (يحتوي على تاريخ) ===
      let H = 0;
      for (let i = 0; i < Math.min(30, rawRows.length); i++) {
        const rStr = rawRows[i].map(x => normAr(String(x || ''))).join(' ');
        if (rStr.includes('تاريخ')) {
          H = i;
          break;
        }
      }
      
      const headers = rawRows[H].map(h => String(h || '').trim());
      
      // === إيجاد عمود التاريخ ===
      let dateCol = headers.findIndex(h => normAr(h).includes('تاريخ'));
      if (dateCol === -1) dateCol = 0;
      
      // === إيجاد بداية قسم "دوبل جون" ===
      let djStartCol = -1;
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < rawRows[r].length; c++) {
          const val = normAr(String(rawRows[r][c] || ''));
          if (val.includes('دوبل') || val.includes('double')) {
            djStartCol = c;
            break;
          }
        }
        if (djStartCol >= 0) break;
      }
      
      // === تقسيم الأعمدة: رئيسية و خاصة ===
      const mainCols = [];
      const specialCols = [];
      for (let c = 0; c < headers.length; c++) {
        if (c === dateCol || !headers[c]) continue;
        if (djStartCol >= 0 && c >= djStartCol) {
          specialCols.push(c);
        } else {
          mainCols.push(c);
        }
      }
      
      const targetFactoryName = isMultiSheet ? sheetName : mainFactoryName;
      childGroupNames[targetFactoryName] = mainFactoryName;
      if (!allLogs[targetFactoryName]) allLogs[targetFactoryName] = [];
      
      const dataRows = rawRows.slice(H + 1);
      // Some workbooks keep the opening balance in the row immediately
      // before the first dated row (for example: 431 dead birds, 37 kg
      // feed-in and 5 special eggs).  It must be included in the import,
      // while the undated rows after the last day must remain ignored.
      const firstDatedIndex = dataRows.findIndex(row => normalizeDate(row[dateCol]));
      const openingRow = firstDatedIndex > 0 ? dataRows[firstDatedIndex - 1] : null;
      const openingValue = (keywords) => {
        if (!openingRow) return 0;
        for (const k of keywords) {
          const nk = normAr(k);
          for (let c = 0; c < headers.length; c++) {
            if (normAr(headers[c]).includes(nk)) {
              return parseNumber(openingRow[c]);
            }
          }
        }
        return 0;
      };
      let runningProduction = openingValue(['الانتاج الاجمالي', 'الاجمالي']);
      
      dataRows.forEach((rowArr, rowIndex) => {
        const dateRaw = rowArr[dateCol];
        const dateStr = normalizeDate(dateRaw);
        if (!dateStr) return;
        
        // بناء كائن الصف الرئيسي
        const mainRow = {};
        const mainH = [];
        for (const c of mainCols) {
          mainRow[headers[c]] = rowArr[c];
          mainH.push(headers[c]);
        }
        
        const getMain = (keywords) => {
          for (const k of keywords) {
            const nk = normAr(k);
            for (const h of mainH) {
              if (normAr(h).includes(nk)) {
                const v = mainRow[h];
                return (v !== undefined && v !== null && v !== '') ? v : null;
              }
            }
          }
          return null;
        };
        
        // === قراءة الكميات (بدون أسعار) ===
        
        // الإنتاج اليومي (بالبلاكات)
        const producedPlates = parseNumber(getMain(['الانتاج اليومي', 'انتاج يومي', 'انتاج']));
        // الإنتاج الإجمالي (التراكمي)
        const importedTotalProd = parseNumber(getMain(['الانتاج الاجمالي', 'الاجمالي']));
        const totalProd = importedTotalProd > 0 ? importedTotalProd : runningProduction + producedPlates;
        runningProduction = totalProd;
        // الوفيات
        const isFirstDatedRow = rowIndex === firstDatedIndex;
        const dead = parseNumber(getMain(['وفيات', 'وفاه', 'نفوق', 'موت'])) +
          (isFirstDatedRow ? openingValue(['وفيات', 'وفاه', 'نفوق', 'موت']) : 0);
        // الشعير الداخل
        const feedIn = parseNumber(getMain(['دخول العلف', 'دخول'])) +
          (isFirstDatedRow ? openingValue(['دخول العلف', 'دخول']) : 0);
        // الشعير المستهلك
        const feedUsed = parseNumber(getMain(['استهلاك العلف', 'استهلاك']));
        // شراء البلاكة (مصاريف)
        const expenses = parseNumber(getMain(['شراء البلاكه', 'شراء']));
        // ملاحظات
        const notes = String(getMain(['ملاحظات', 'ملاحظه']) || '');
        
        // بيع البيض (كمية فقط، ليس مبلغ مالي)
        // إذا أقل من 10 = مكسور، أو إذا الملاحظة فيها "اكاص" أو "طيشوها"
        const rawSale = getMain(['بيع البيض', 'بيع']);
        const saleNum = parseNumber(rawSale);
        const notesNorm = normAr(notes);
        const isBroken = notesNorm.includes('اكاص') || notesNorm.includes('طيشوها') || notesNorm.includes('مكسور');
        
        let soldQty = 0, broken = 0;
        if (isBroken) {
          broken = saleNum;
        } else if (saleNum > 0 && saleNum < 10) {
          // أقل من 10 يعتبر بيض مكسور
          broken = saleNum;
        } else {
          soldQty = saleNum;
        }
        
        // 12 بلاكة = 1 كرطونة — نحسبها من المنتج اليومي
        const soldGroups = Math.floor(producedPlates / 12);
        const soldSingle = producedPlates % 12;
        
        // تخطي الصفوف الفارغة تماماً (يجب أن يكون هناك قيمة واحدة على الأقل)
        // نتحقق أيضاً من الملاحظات لأن اليوم الأخير قد يكون له ملاحظة فقط
        const hasData = producedPlates > 0 || saleNum > 0 || dead > 0 || 
                        feedIn > 0 || feedUsed > 0 || totalProd > 0 || notes.trim().length > 0;
        if (!hasData) return;
        
        // === بيض خاص (دوبل جون) ===
        let specialQty = 0;
        let specialSoldQty = 0;
        let specNotes = '';
        if (specialCols.length > 0) {
          const specRow = {};
          const specH = [];
          for (const c of specialCols) {
            specRow[headers[c]] = rowArr[c];
            specH.push(headers[c]);
          }
          const getSpec = (keywords) => {
            for (const k of keywords) {
              const nk = normAr(k);
              for (const h of specH) {
                if (normAr(h).includes(nk)) {
                  const v = specRow[h];
                  return (v !== undefined && v !== null && v !== '') ? v : null;
                }
              }
            }
            return null;
          };
          specialQty = parseNumber(getSpec(['كميه', 'كمية'])) +
            (isFirstDatedRow ? openingValue(['كميه', 'كمية']) : 0);
          specialSoldQty = parseNumber(getSpec(['بيع البيض', 'بيع']));
          specNotes = String(getSpec(['ملاحظات', 'ملاحظه']) || '');
        }
        
        const entry = {
          id: Date.now() + Math.random(),
          date: dateStr,
          produced: producedPlates,
          broken: broken,
          price: 0,
          netEggs: producedPlates > 0 ? producedPlates - broken : 0,
          soldGroups: soldGroups,
          soldSingle: soldSingle,
          income: 0,
          specialSold: specialSoldQty || 0,
          specialIncome: 0,
          dead: dead,
          feedUsed: feedUsed,
          feedCost: 0,
          waterCost: 0,
          expenses: 0,
          baseProfit: 0,
          profit: 0,
          ownerAdvance: 0,
          notes: specNotes ? (notes + (notes ? ' | ' : '') + 'دوبل جون: ' + specNotes) : notes,
          eggs: producedPlates,
          mortality: dead,
          isPaid: true,
          feedIn: feedIn,
          totalProduction: totalProd,
          soldEggs: soldQty,
          brokenEggs: broken,
          specialEggs: specialQty
        };
        
        allLogs[targetFactoryName].push(entry);
      });
    });

    // === حفظ البيانات ===
    const names = Object.keys(allLogs).filter(n => allLogs[n].length > 0);
    if (!names.length) {
      showToast('لم يتم العثور على بيانات صالحة.', 'error');
      return;
    }

    let created = 0, updated = 0;
    const uid = CURRENT_USER?.uid;
    if (!uid) { showToast('يرجى تسجيل الدخول أولاً', 'error'); return; }

    let allFactories = [];
    try { allFactories = JSON.parse(localStorage.getItem('zohir_factories_' + uid)) || []; } catch(e) {}

    for (const fname of names) {
      const groupName = childGroupNames[fname];
      let parentFactory = null;
      if (isMultiSheet) {
        parentFactory = allFactories.find(f => !f.parentId && normAr(f.name) === normAr(groupName));
        if (parentFactory && !parentFactory.isGroup) {
          parentFactory.isGroup = true;
          parentFactory.type = 'group';
          parentFactory.icon = '📁';
        }
        if (!parentFactory) {
          const usedColors = allFactories.map(f => f.color);
          const color = CARD_COLORS.find(c => !usedColors.includes(c)) || CARD_COLORS[allFactories.length % CARD_COLORS.length];
          parentFactory = {
            id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name: groupName,
            icon: '📁', color, type: 'group', isGroup: true,
            ownerUid: uid, createdAt: new Date().toISOString()
          };
          allFactories.push(parentFactory);
          created++;
        }
      }
      let factory = allFactories.find(f => {
        if (isMultiSheet) return f.parentId === parentFactory.id && normAr(f.name) === normAr(fname);
        return !f.parentId && normAr(f.name) === normAr(fname);
      });
      if (!factory) {
        const usedColors = allFactories.map(f => f.color);
        const color = CARD_COLORS.find(c => !usedColors.includes(c)) || CARD_COLORS[allFactories.length % CARD_COLORS.length];
        factory = {
          id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          name: fname,
          icon: '🥚',
          color: color,
          type: 'layer',
          ...(isMultiSheet ? { parentId: parentFactory.id } : {}),
          ownerUid: uid,
          createdAt: new Date().toISOString()
        };
        allFactories.push(factory);
        created++;
      } else {
        updated++;
      }

      const fid = factory.id;
      let existing = [];
      try { existing = JSON.parse(localStorage.getItem('zohir_' + fid + '_daily_logs')) || []; } catch(e) {}
      
      // دمج ذكي: البيانات الجديدة تحل محل القديمة لنفس التاريخ
      const byDate = {};
      // أولاً: نضع البيانات القديمة
      existing.forEach(e => { if (e.date) byDate[e.date] = e; });
      // ثانياً: البيانات الجديدة تستبدل القديمة (هذا يضمن ظهور الأيام الأخيرة الجديدة)
      allLogs[fname].forEach(e => { if (e.date) byDate[e.date] = e; });
      const merged = Object.values(byDate).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      
      localStorage.setItem('zohir_' + fid + '_daily_logs', JSON.stringify(merged));
      if (typeof fs !== 'undefined' && auth.currentUser) {
        fs.collection('app_data').doc(fid + '_daily_logs').set({ data: merged }).catch(function(){});
      }
    }

    localStorage.setItem('zohir_factories_' + uid, JSON.stringify(allFactories));
    if (typeof fs !== 'undefined' && auth.currentUser) {
      fs.collection('app_data').doc('factories_list_' + uid).set({ data: allFactories }).catch(function(){});
    }

    renderFactoryScreen();

    const msg = [];
    if (created) msg.push('تم إنشاء ' + created + ' مصانع');
    if (updated) msg.push('تم تحديث ' + updated + ' مصانع');
    const total_logs = names.reduce(function(s, n) { return s + allLogs[n].length; }, 0);
    if (total_logs) msg.push(total_logs + ' سجل يومي');
    showToast(msg.join(' | '), 'success');

  } catch (err) {
    console.error('[handleFactoryImport] Error:', err);
    showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
  }
}

/* ===================== END SMART EXCEL IMPORT ===================== */


function togglePurchaseBatches() {
  const popup = document.getElementById('global-credits-popup');
  if (popup) {
    if (popup.style.display === 'none' || popup.style.display === '') {
      popup.style.display = 'block';
      if (typeof renderSuppliersList === 'function') renderSuppliersList();
    } else {
      popup.style.display = 'none';
    }
  }
}

function toggleGlobalWorkersPanel() {
  const p = document.getElementById('global-workers-panel');
  if (p) {
    if (p.style.display === 'none' || p.style.display === '') {
      p.style.display = 'block';
      if (typeof renderWorkerTypes === 'function') renderWorkerTypes();
    } else {
      p.style.display = 'none';
    }
  }
}


/* =====================================================================
   دفعات الشراء — دفتر حسابات الموردين
   Suppliers ledger + Excel invoice import.
   Storage is global (per owner), mirroring the factory-list pattern.
   ===================================================================== */

const SUP_COLL = { suppliers: 'supplier_list', tx: 'supplier_tx', invoices: 'supplier_invoices' };

function supOwnerUid() {
  return EFFECTIVE_OWNER_UID || (CURRENT_USER && CURRENT_USER.uid) || 'default';
}
function supStoreKey(coll) { return `zohir_${coll}_${supOwnerUid()}`; }
function supCloudId(coll) { return `${coll}_${supOwnerUid()}`; }

function supRead(coll) {
  try { return JSON.parse(localStorage.getItem(supStoreKey(coll))) || []; }
  catch (e) { return []; }
}
let _ledgerCloudWarned = false;
function warnLedgerCloudFailure(coll, e) {
  console.warn('[ledgers] cloud sync failed for', coll, e);
  if (_ledgerCloudWarned) return;
  _ledgerCloudWarned = true;
  // Silent local-only saves are how data "disappears" on another device.
  const msg = (e && e.code === 'permission-denied')
    ? '⚠️ لم تُحفظ البيانات في السحابة — سجّل الدخول، وإلا ستبقى على هذا الجهاز فقط'
    : '⚠️ تعذّر الحفظ في السحابة — البيانات محفوظة محلياً فقط حالياً';
  try { showToast(msg, 'error'); } catch (_) {}
}

function supWrite(coll, arr) {
  localStorage.setItem(supStoreKey(coll), JSON.stringify(arr));
  try {
    fs.collection('app_data').doc(supCloudId(coll))
      .set({ data: arr, lastUpdated: new Date().toISOString() })
      .catch(e => warnLedgerCloudFailure(coll, e));
  } catch (e) { warnLedgerCloudFailure(coll, e); }
}

function getSuppliers() { return supRead(SUP_COLL.suppliers); }
function setSuppliers(a) { supWrite(SUP_COLL.suppliers, a); }
function getSupplierTx() { return supRead(SUP_COLL.tx); }
function setSupplierTx(a) { supWrite(SUP_COLL.tx, a); }
function getSupplierInvoices() { return supRead(SUP_COLL.invoices); }
function setSupplierInvoices(a) { supWrite(SUP_COLL.invoices, a); }

let _currentSupplierId = null;
let _supplierLedgerPage = 0;
let _supplierImportPreview = null;

/* ---------------------------------------------------------------
   Balance:  goods (+) and adjustments (+) raise what we owe,
             payments (−) reduce it.
   Positive = the factory owes the supplier.
   --------------------------------------------------------------- */
function supplierTxOf(supplierId) {
  return getSupplierTx().filter(t => t.supplierId === supplierId);
}
function supplierBalance(supplierId) {
  const sup = getSuppliers().find(s => s.id === supplierId);
  let bal = Number(sup && sup.openingBalance) || 0;
  supplierTxOf(supplierId).forEach(t => {
    const amt = Number(t.amount) || 0;
    bal += (t.kind === 'payment') ? -amt : amt;
  });
  return bal;
}

/* =====================================================================
   INVOICE FILE PARSER
   ---------------------------------------------------------------------
   Input: rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' })
   Columns: A=0 التاريخ | B=1 المستودع | C=2 الكمية | D=3 السعر
            E=4 الناتج | F=5 الدفع    | G=6 الملاحظات      (H+ ignored)

   Each block is one weekly invoice, anchored on a row whose column E
   starts with "Facture". Blocks are processed in PHYSICAL order — the
   dates contain entry errors and duplicates, so sorting by date would
   break the carry-over chain.
   ===================================================================== */
const SUP_COL = { DATE: 0, WH: 1, QTY: 2, PRICE: 3, GOODS: 4, PAY: 5, NOTE: 6 };
const SUP_EPS = 0.005;

function supCell(row, i) {
  if (!row) return '';
  const v = row[i];
  return (v === null || v === undefined) ? '' : v;
}
function supStr(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
function supNormAr(v) {
  return supStr(v).toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}
function supEq(a, b) { return Math.abs(a - b) < SUP_EPS; }
function supBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

// Handles 448400, "448,400.00", "1 605 000,00", "(1200)", "1200-"
function supParseNum(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0;
  if (raw instanceof Date) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  let sign = 1;
  let m = s.match(/^\(\s*(.+?)\s*\)$/);
  if (m) { sign = -1; s = m[1]; }
  m = s.match(/^(.+?)\s*-$/);
  if (m) { sign = -1; s = m[1]; }
  if (/^-/.test(s)) { sign = -1; s = s.replace(/^-\s*/, ''); }

  s = s.replace(/[\s  ٬]/g, '');
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return 0;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (commas) {
    const parts = s.split(',');
    if (commas > 1 || parts[parts.length - 1].length === 3) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (dots > 1) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : sign * n;
}

const SUP_MONTHS = {
  'janvier': 1, 'janv': 1, 'fevrier': 2, 'février': 2, 'fevr': 2, 'mars': 3,
  'avril': 4, 'avr': 4, 'mai': 5, 'juin': 6, 'juillet': 7, 'juil': 7,
  'aout': 8, 'août': 8, 'septembre': 9, 'sept': 9, 'octobre': 10, 'oct': 10,
  'novembre': 11, 'nov': 11, 'decembre': 12, 'décembre': 12, 'dec': 12, 'déc': 12,
  'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6,
  'july': 7, 'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12,
  'جانفي': 1, 'يناير': 1, 'فيفري': 2, 'فبراير': 2, 'مارس': 3, 'افريل': 4, 'ابريل': 4,
  'ماي': 5, 'مايو': 5, 'جوان': 6, 'يونيو': 6, 'جويلية': 7, 'يوليو': 7,
  'اوت': 8, 'اغسطس': 8, 'سبتمبر': 9, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12
};

// Returns null for impossible dates (month 47, day 0, ...). Hand-typed
// sheets contain them, and silently accepting one poisons every downstream
// sort, grouping and month check.
function supIso(y, mo, d) {
  if (!(y >= 1900 && y <= 2999) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  return String(y).padStart(4, '0') + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function supFromSerial(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  if (isNaN(d.getTime())) return null;
  return supIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// → 'YYYY-MM-DD' or null. Day always comes first (d/m/yyyy).
function supParseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return supIso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number') return (v > 20000 && v < 80000) ? supFromSerial(v) : null;

  const s = String(v).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return supIso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})\s+([^\s\d]+)\.?\s+(\d{4})$/);
  if (m) {
    const mo = SUP_MONTHS[m[2].toLowerCase()];
    if (mo) return supIso(+m[3], mo, +m[1]);
  }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return supIso(y, +m[2], +m[1]);
  }

  if (/^\d{5}$/.test(s)) return supFromSerial(+s);
  return null;
}

function supIsAnchor(row) { return /^facture/i.test(supStr(supCell(row, SUP_COL.GOODS))); }
function supIsHeader(row) { return supNormAr(supCell(row, SUP_COL.DATE)) === 'التاريخ'; }
function supIsTotalRow(row) { return supNormAr(supCell(row, SUP_COL.NOTE)) === 'المجموع'; }
function supIsBalanceRow(row) { return supNormAr(supCell(row, SUP_COL.NOTE)) === 'الباقي'; }
function supIsEmptyRow(row) {
  if (!row) return true;
  for (let i = SUP_COL.DATE; i <= SUP_COL.NOTE; i++) if (!supBlank(supCell(row, i))) return false;
  return true;
}
// "Reste" / "Rerste" in column B is a carry marker, not a warehouse.
function supIsResteMarker(v) { return /^re+r?ste$/i.test(supStr(v).replace(/\s+/g, '')); }

function supInvoiceDateFrom(text) {
  const m = String(text).match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return supIso(y, +m[2], +m[1]);
  }
  return supParseDate(String(text).replace(/^[^:]*:\s*/, '').trim());
}

function parseSupplierSheet(rows, supplierName, options) {
  options = options || {};
  rows = rows || [];

  const warnings = [];
  const transactions = [];
  const invoices = [];
  const warn = (code, message, row) => warnings.push({ code, message, row: row == null ? null : row });

  /* 1. every block anchor, in physical order */
  const anchors = [];
  for (let r = 0; r < rows.length; r++) if (supIsAnchor(rows[r])) anchors.push(r);

  if (!anchors.length) {
    return {
      ok: false, supplierName, invoices: [], transactions: [],
      warnings: [{ code: 'no-invoices', message: 'لم يُعثر على أي فاتورة — لا يوجد صف يبدأ بـ «Facture» في العمود E.', row: null }],
      warehouses: [], totals: { goods: 0, payments: 0, goodsCount: 0, paymentCount: 0, adjustCount: 0 },
      finalBalance: 0
    };
  }

  /* name written inside the file (row just above the first anchor) */
  let declaredName = '';
  for (let k = anchors[0] - 1; k >= 0 && k >= anchors[0] - 4; k--) {
    const nm = supStr(supCell(rows[k], SUP_COL.DATE));
    if (nm) { declaredName = nm; break; }
  }
  if (declaredName && supplierName && supNormAr(declaredName) !== supNormAr(supplierName)) {
    warn('name-mismatch',
      `اسم المورد داخل الملف («${declaredName}») يخالف اسم الملف («${supplierName}»). تم اعتماد اسم الملف.`,
      anchors[0]);
  }

  let running = Number(options.openingBalance) || 0;
  let totalGoods = 0, totalPayments = 0;
  let goodsCount = 0, paymentCount = 0, adjustCount = 0;
  const warehouses = {};
  const thisYear = new Date().getFullYear();

  for (let bi = 0; bi < anchors.length; bi++) {
    const start = anchors[bi];
    const end = (bi + 1 < anchors.length) ? anchors[bi + 1] - 1 : rows.length - 1;

    const invoiceDate = supInvoiceDateFrom(supStr(supCell(rows[start], SUP_COL.GOODS)));
    if (!invoiceDate) {
      warn('bad-invoice-date',
        `تعذّر قراءة تاريخ الفاتورة من «${supStr(supCell(rows[start], SUP_COL.GOODS))}».`, start);
    }

    let headerIdx = -1, totalIdx = -1, balanceIdx = -1;
    for (let i = start; i <= end; i++) {
      if (headerIdx === -1 && supIsHeader(rows[i])) headerIdx = i;
      if (totalIdx === -1 && supIsTotalRow(rows[i])) totalIdx = i;
      if (balanceIdx === -1 && supIsBalanceRow(rows[i])) balanceIdx = i;
    }

    const dataStart = (headerIdx !== -1 ? headerIdx : start) + 1;
    const dataEnd = (totalIdx !== -1 ? totalIdx : (balanceIdx !== -1 ? balanceIdx : end + 1)) - 1;

    if (headerIdx === -1) warn('no-header', `فاتورة ${invoiceDate || '?'}: لا يوجد صف رأس (التاريخ).`, start);
    if (totalIdx === -1) warn('no-total', `فاتورة ${invoiceDate || '?'}: لا يوجد صف «المجموع».`, start);

    const fileTotalGoods = totalIdx !== -1 ? supParseNum(supCell(rows[totalIdx], SUP_COL.GOODS)) : 0;
    const fileTotalPay = totalIdx !== -1 ? supParseNum(supCell(rows[totalIdx], SUP_COL.PAY)) : 0;

    const hasFileBalance = balanceIdx !== -1;
    let fileBalance = 0;
    if (hasFileBalance) fileBalance = supParseNum(supCell(rows[balanceIdx], SUP_COL.PAY));
    else warn('no-balance', `فاتورة ${invoiceDate || '?'}: لا يوجد صف «الباقي» — اعتُمد الرصيد المحسوب.`, start);

    const dataRows = [];
    for (let d = dataStart; d <= dataEnd && d < rows.length; d++) {
      if (supIsEmptyRow(rows[d])) continue;
      dataRows.push({
        idx: d,
        goods: supParseNum(supCell(rows[d], SUP_COL.GOODS)),
        pay: supParseNum(supCell(rows[d], SUP_COL.PAY)),
        qty: supParseNum(supCell(rows[d], SUP_COL.QTY)),
        price: supParseNum(supCell(rows[d], SUP_COL.PRICE)),
        rawDate: supCell(rows[d], SUP_COL.DATE),
        warehouse: supStr(supCell(rows[d], SUP_COL.WH)),
        note: supStr(supCell(rows[d], SUP_COL.NOTE))
      });
    }

    /* carry-over line: the previous invoice's balance re-entered by hand.
       Not a real transaction — excluding it is what keeps the total honest. */
    let carryRowIdx = -1, carrySide = null;
    if (!supEq(running, 0)) {
      const wantGoods = running > 0;
      const target = Math.abs(running);
      for (let c = 0; c < dataRows.length; c++) {
        const dr = dataRows[c];
        if (!supEq(dr.qty, 0) || !supEq(dr.price, 0)) continue;   // a real goods line
        if (wantGoods ? supEq(dr.goods, target) : supEq(dr.pay, target)) {
          carryRowIdx = dr.idx;
          carrySide = wantGoods ? 'goods' : 'pay';
          break;
        }
      }
      if (carryRowIdx === -1) {
        warn('carry-not-found',
          `فاتورة ${invoiceDate || '?'}: لم يُعثر على سطر ترحيل الرصيد السابق (${fmt(running)}) — سيُعالَج الفرق بسطر تسوية.`,
          start);
      }
    }

    let sumGoods = 0, sumPay = 0, seq = 0;
    for (const row of dataRows) {
      let g = row.goods, p = row.pay;
      if (row.idx === carryRowIdx) {
        if (carrySide === 'goods') g = 0; else p = 0;
      }

      const rowDate = supParseDate(row.rawDate);
      if (rowDate) {
        const yr = +rowDate.slice(0, 4);
        if (yr < 2000 || yr > thisYear + 2) {
          warn('date-out-of-range',
            `تاريخ خارج المدى المعقول (${rowDate}) في فاتورة ${invoiceDate || '?'} — استُورد كما هو.`, row.idx);
        }
      }
      const effDate = rowDate || invoiceDate;

      // E and F are independent — one row can yield two movements.
      if (!supEq(g, 0)) {
        if (row.warehouse && !supIsResteMarker(row.warehouse)) {
          const key = supNormAr(row.warehouse);
          if (!warehouses[key]) warehouses[key] = { label: row.warehouse, count: 0 };
          warehouses[key].count++;
        }
        transactions.push({
          kind: 'goods', date: effDate, warehouse: row.warehouse,
          qty: supEq(row.qty, 0) ? null : row.qty,
          price: supEq(row.price, 0) ? null : row.price,
          amount: g, note: row.note,
          invoiceDate, invoiceIndex: bi, excelRow: row.idx + 1, seq: seq++
        });
        sumGoods += g; totalGoods += g; goodsCount++;
      }
      if (!supEq(p, 0)) {
        transactions.push({
          kind: 'payment', date: effDate, warehouse: '', qty: null, price: null,
          amount: p, note: row.note,
          invoiceDate, invoiceIndex: bi, excelRow: row.idx + 1, seq: seq++
        });
        sumPay += p; totalPayments += p; paymentCount++;
      }
    }

    /* reconcile against the file's own «الباقي» */
    const computed = running + sumGoods - sumPay;
    const effectiveBalance = hasFileBalance ? fileBalance : computed;
    let adjustment = 0;

    if (!supEq(computed, effectiveBalance)) {
      adjustment = effectiveBalance - computed;
      transactions.push({
        kind: 'adjust', date: invoiceDate, warehouse: '', qty: null, price: null,
        amount: adjustment,
        note: 'تسوية افتتاحية للفاتورة ' + (invoiceDate || '?'),
        invoiceDate, invoiceIndex: bi,
        excelRow: (balanceIdx !== -1 ? balanceIdx : end) + 1, seq: seq++
      });
      adjustCount++;
    }

    if (totalIdx !== -1 &&
        !supEq(fileTotalGoods, sumGoods + (carrySide === 'goods' ? Math.abs(running) : 0))) {
      warn('total-mismatch',
        `فاتورة ${invoiceDate || '?'}: مجموع الأسطر لا يطابق صف «المجموع» — اعتُمدت قيمة «الباقي».`, totalIdx);
    }

    invoices.push({
      index: bi, date: invoiceDate, anchorRow: start + 1,
      openingBalance: running, sumGoods, sumPayments: sumPay,
      fileTotalGoods, fileTotalPayments: fileTotalPay,
      fileBalance: hasFileBalance ? fileBalance : null,
      computedBalance: computed, adjustment, closingBalance: effectiveBalance,
      carryRow: carryRowIdx === -1 ? null : carryRowIdx + 1, carrySide
    });

    // MANDATORY: pin the running balance to the file's own value.
    running = effectiveBalance;
  }

  return {
    ok: true, supplierName, declaredName, invoices, transactions, warnings,
    warehouses: Object.keys(warehouses).map(k => warehouses[k].label)
      .sort((a, b) => a.localeCompare(b)),
    totals: {
      goods: totalGoods, payments: totalPayments,
      goodsCount, paymentCount, adjustCount
    },
    finalBalance: running
  };
}

/* =====================================================================
   IMPORT FLOW
   ===================================================================== */
async function handleSupplierExcelImport(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') {
    showToast('مكتبة Excel غير محمّلة — تحقّق من الاتصال بالإنترنت', 'error');
    return;
  }
  if (!_currentSupplierId) {
    showToast('افتح دفتر المورد أولاً', 'error');
    return;
  }

  showToast('جاري تحليل الملف...', 'info');
  try {
    let workbook;
    if (/\.csv$/i.test(file.name)) {
      workbook = XLSX.read(await file.text(), { type: 'string', raw: true });
    } else {
      workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    }

    // Always the first sheet.
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    if (!ws) { showToast('الملف لا يحتوي على أي ورقة', 'error'); return; }
    // range:0 — see wpReadWorkbook: without it the sheet's !ref shifts every row index.
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range: 0 });

    // Supplier name comes from the FILE NAME (one file = one supplier).
    const fileSupplierName = file.name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '').trim();
    const sup = getSuppliers().find(s => s.id === _currentSupplierId);

    const result = parseSupplierSheet(rows, fileSupplierName, { openingBalance: 0 });

    if (!result.ok) {
      showToast(result.warnings[0].message, 'error');
      return;
    }
    if (sup && supNormAr(sup.name) !== supNormAr(fileSupplierName)) {
      result.warnings.unshift({
        code: 'target-mismatch',
        message: `اسم الملف («${fileSupplierName}») يخالف اسم المورد المفتوح («${sup.name}»). سيُستورد إلى «${sup.name}».`,
        row: null
      });
    }

    // Known warehouses → flag genuinely new ones.
    const known = new Set(
      getSupplierTx().filter(t => t.kind === 'goods' && t.warehouse)
        .map(t => supNormAr(t.warehouse))
    );
    result.newWarehouses = result.warehouses.filter(w => !known.has(supNormAr(w)));

    _supplierImportPreview = { result, fileName: file.name, supplierId: _currentSupplierId };
    showSupplierImportPreview();
  } catch (err) {
    console.error('[handleSupplierExcelImport]', err);
    showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
  }
}

const SUP_WARN_LABEL = {
  'name-mismatch': '⚠️ اسم المورد',
  'target-mismatch': '⚠️ المورد الهدف',
  'date-out-of-range': '📅 تاريخ شاذّ',
  'carry-not-found': '🔗 ترحيل مفقود',
  'total-mismatch': '➕ فرق في المجموع',
  'no-total': '❓ بدون مجموع',
  'no-balance': '❓ بدون باقي',
  'no-header': '❓ بدون رأس',
  'bad-invoice-date': '📅 تاريخ فاتورة'
};

function showSupplierImportPreview() {
  const p = _supplierImportPreview;
  if (!p) return;
  const r = p.result;
  const inv = r.invoices;
  const lastBalance = inv.length ? inv[inv.length - 1].closingBalance : 0;

  const chip = (label, value, color) => `
    <div style="flex:1;min-width:130px;background:rgba(0,0,0,0.25);border-radius:8px;padding:10px 12px;text-align:center">
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:4px">${label}</div>
      <div style="font-weight:800;font-size:1.05rem;color:${color || 'var(--text-primary)'}">${value}</div>
    </div>`;

  document.getElementById('import-preview-summary').innerHTML =
    chip('الملف', p.fileName, 'var(--blue)') +
    chip('عدد الفواتير', inv.length) +
    chip('حركات بضاعة', r.totals.goodsCount, 'var(--gold)') +
    chip('حركات دفع', r.totals.paymentCount, 'var(--green)') +
    chip('إجمالي البضاعة', fmt(r.totals.goods)) +
    chip('إجمالي المدفوع', fmt(r.totals.payments)) +
    chip('أسطر تسوية', r.totals.adjustCount, r.totals.adjustCount ? 'var(--gold)' : 'var(--text-secondary)') +
    chip('الرصيد النهائي', fmt(lastBalance, 'دج'), lastBalance < 0 ? 'var(--red)' : 'var(--green)');

  /* warnings, grouped by code */
  const wEl = document.getElementById('import-preview-warnings');
  if (r.warnings.length || (r.newWarehouses || []).length) {
    const groups = {};
    r.warnings.forEach(w => { (groups[w.code] = groups[w.code] || []).push(w); });
    let h = `<div style="border:1px solid rgba(245,197,24,0.35);background:rgba(245,197,24,0.07);border-radius:10px;padding:12px">
      <div style="font-weight:800;color:var(--gold);margin-bottom:8px">التحذيرات (${r.warnings.length})</div>`;
    Object.keys(groups).forEach(code => {
      const list = groups[code];
      h += `<details style="margin-bottom:6px">
        <summary style="cursor:pointer;color:var(--text-secondary);font-size:0.85rem">
          ${SUP_WARN_LABEL[code] || code} — ${list.length}
        </summary>
        <div style="max-height:130px;overflow-y:auto;font-size:0.78rem;color:var(--text-secondary);padding:6px 10px 0">
          ${list.slice(0, 60).map(w => `<div>• ${w.message}${w.row != null ? ` <span style="opacity:.6">(سطر ${w.row + 1})</span>` : ''}</div>`).join('')}
          ${list.length > 60 ? `<div style="opacity:.6">… و${list.length - 60} أخرى</div>` : ''}
        </div></details>`;
    });
    if ((r.newWarehouses || []).length) {
      h += `<div style="margin-top:8px;font-size:0.82rem;color:var(--text-secondary)">
        🏬 مستودعات جديدة (${r.newWarehouses.length}): ${r.newWarehouses.join('، ')}</div>`;
    }
    h += '</div>';
    wEl.innerHTML = h;
  } else {
    wEl.innerHTML = '';
  }

  /* replace-mode switch */
  const own = supplierTxOf(p.supplierId);
  const existing = own.filter(t => t.source === 'import').length;
  const manualCount = own.filter(t => t.source !== 'import').length;
  const sup = getSuppliers().find(s => s.id === p.supplierId);
  const opening = Number(sup && sup.openingBalance) || 0;

  let extra = '';
  if (manualCount || opening) {
    extra = `<div style="margin-top:8px;font-size:0.8rem;color:var(--gold)">
      ℹ️ رصيد المورد المعروض سيساوي «الباقي» في الملف زائد
      ${opening ? `الرصيد الافتتاحي (${fmt(opening)})` : ''}${opening && manualCount ? ' و' : ''}${manualCount ? `${manualCount} حركة يدوية` : ''}.
    </div>`;
  }

  document.getElementById('import-preview-suspect').innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.2);border-radius:8px;padding:10px 12px;cursor:pointer">
      <input type="checkbox" id="sup-import-replace" ${existing ? 'checked' : ''} style="width:16px;height:16px" />
      <span style="font-size:0.86rem">استبدال بيانات هذا المورد بالكامل
        <span style="color:var(--text-secondary)">(يوجد حالياً ${existing} حركة مستوردة)</span></span>
    </label>${extra}`;

  /* per-invoice table — the app balance next to the file's own «الباقي» */
  let t = `<table class="data-table" style="width:100%;font-size:0.8rem">
    <thead><tr>
      <th>#</th><th>تاريخ الفاتورة</th><th>بضاعة</th><th>دفع</th>
      <th>الباقي (الملف)</th><th>رصيد التطبيق</th><th>تسوية</th>
    </tr></thead><tbody>`;
  inv.forEach(i => {
    const match = i.fileBalance === null || supEq(i.closingBalance, i.fileBalance);
    t += `<tr${i.adjustment ? ' style="background:rgba(245,197,24,0.07)"' : ''}>
      <td>${i.index + 1}</td>
      <td>${i.date || '—'}</td>
      <td style="color:var(--gold)">${fmt(i.sumGoods)}</td>
      <td style="color:var(--green)">${fmt(i.sumPayments)}</td>
      <td>${i.fileBalance === null ? '—' : fmt(i.fileBalance)}</td>
      <td style="font-weight:700;color:${i.closingBalance < 0 ? 'var(--red)' : 'inherit'}">${fmt(i.closingBalance)}</td>
      <td>${i.adjustment ? fmt(i.adjustment) : '—'} ${match ? '✅' : '❌'}</td>
    </tr>`;
  });
  t += '</tbody></table>';
  document.getElementById('import-preview-table').innerHTML = t;
  document.getElementById('import-preview-pagination').innerHTML = '';

  document.getElementById('modal-import-preview').classList.add('open');
}

/* Atomic commit: build everything in memory, verify, then write once. */
function commitSupplierImport() {
  const p = _supplierImportPreview;
  if (!p) return;
  const r = p.result;
  const supplierId = p.supplierId;
  const sup = getSuppliers().find(s => s.id === supplierId);
  if (!sup) { showToast('المورد غير موجود', 'error'); return; }

  const replace = !!(document.getElementById('sup-import-replace') || {}).checked;

  const allTx = getSupplierTx();
  const allInv = getSupplierInvoices();

  // Rows belonging to this supplier that we keep.
  const keptTx = allTx.filter(t => t.supplierId !== supplierId ||
    (!replace ? true : t.source !== 'import'));
  const keptInv = allInv.filter(i => i.supplierId !== supplierId || !replace);

  // Unique key: supplier + invoice date + row inside the invoice + kind.
  const seen = new Set(
    keptTx.filter(t => t.supplierId === supplierId && t.source === 'import')
      .map(t => t.importKey)
  );

  const newTx = [];
  let skipped = 0;
  r.transactions.forEach(t => {
    const key = `${supplierId}|${t.invoiceDate}|${t.invoiceIndex}|${t.seq}|${t.kind}`;
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);
    newTx.push({
      id: 'stx_' + t.invoiceIndex + '_' + t.seq + '_' + t.kind + '_' + Date.now().toString(36),
      supplierId, source: 'import', importKey: key,
      kind: t.kind, date: t.date, warehouse: t.warehouse,
      qty: t.qty, price: t.price, amount: t.amount, note: t.note,
      invoiceDate: t.invoiceDate, invoiceIndex: t.invoiceIndex,
      excelRow: t.excelRow, seq: t.seq
    });
  });

  const newInv = r.invoices.map(i => ({
    id: 'sinv_' + supplierId + '_' + i.index,
    supplierId, index: i.index, date: i.date,
    fileTotalGoods: i.fileTotalGoods, fileTotalPayments: i.fileTotalPayments,
    fileBalance: i.fileBalance, computedBalance: i.computedBalance,
    adjustment: i.adjustment, closingBalance: i.closingBalance,
    openingBalance: i.openingBalance, sumGoods: i.sumGoods, sumPayments: i.sumPayments,
    carryRow: i.carryRow, anchorRow: i.anchorRow
  })).filter(i => !keptInv.some(k => k.id === i.id));

  /* MANDATORY verification — replay the imported rows exactly the way the
     ledger will, and check EVERY invoice against the file's own «الباقي»,
     not just the last one. Abort the whole import on any mismatch. */
  const importRows = keptTx
    .filter(t => t.supplierId === supplierId && t.source === 'import')
    .concat(newTx);

  let replay = 0;
  let badInvoice = null;
  for (const i of r.invoices) {
    importRows.filter(t => t.invoiceIndex === i.index).forEach(t => {
      const a = Number(t.amount) || 0;
      replay += (t.kind === 'payment') ? -a : a;
    });
    if (!supEq(replay, i.closingBalance)) { badInvoice = { i, replay }; break; }
  }

  const expected = r.invoices.length ? r.invoices[r.invoices.length - 1].closingBalance : 0;
  if (badInvoice || !supEq(replay, expected)) {
    document.getElementById('modal-import-preview').classList.remove('open');
    const msg = badInvoice
      ? `❌ فشل التحقّق عند فاتورة ${badInvoice.i.date}: رصيد التطبيق ${fmt(badInvoice.replay)} لا يطابق «الباقي» ${fmt(badInvoice.i.closingBalance)}. أُلغي الاستيراد.`
      : `❌ فشل التحقّق: الرصيد النهائي ${fmt(replay)} لا يطابق آخر «الباقي» ${fmt(expected)}. أُلغي الاستيراد.`;
    showToast(msg, 'error');
    console.error('[supplier import] verification failed', { badInvoice, replay, expected });
    return;
  }

  // Single write per collection — nothing is persisted before this point.
  setSupplierTx(keptTx.concat(newTx));
  setSupplierInvoices(keptInv.concat(newInv));

  _supplierImportPreview = null;
  document.getElementById('modal-import-preview').classList.remove('open');
  const fileInput = document.getElementById('buyer-excel-input');
  if (fileInput) fileInput.value = '';

  openSupplierLedger(supplierId);
  renderSuppliersList();
  showToast(`✅ تم الاستيراد: ${newInv.length} فاتورة، ${newTx.length} حركة` +
    (skipped ? ` (تُخُطّي ${skipped} مكرّرة)` : '') + ` — الرصيد ${fmt(expected, 'دج')}`);
}

/* =====================================================================
   SUPPLIERS LIST
   ===================================================================== */
function renderSuppliersList() {
  const el = document.getElementById('global-credits-content');
  if (!el) return;
  const list = getSuppliers();

  if (!list.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px">
      لا يوجد موردين مسجلين حالياً.<br><br>
      💡 لاستيراد ملف Excel خاص بمورد، أضف المورد أولاً من زر (+ إضافة مورد)،
      ثم اضغط على بطاقته لفتح الدفتر وستجد زر الاستيراد هناك.</div>`;
    return;
  }

  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
    ${list.map(s => {
      const bal = supplierBalance(s.id);
      const txCount = supplierTxOf(s.id).length;
      const color = bal > 0 ? 'var(--red)' : (bal < 0 ? 'var(--green)' : 'var(--text-secondary)');
      return `<div onclick="openSupplierLedger('${s.id}')"
        style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(99,179,237,0.25);border-radius:12px;padding:14px">
        <div style="font-weight:800;font-size:1rem;margin-bottom:6px">${escapeHtmlSup(s.name)}</div>
        <div style="font-size:1.15rem;font-weight:800;color:${color}">${fmt(bal, 'دج')}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px">
          ${bal > 0 ? 'مستحق للمورد' : (bal < 0 ? 'دفعنا زيادة' : 'مُسوّى')} • ${txCount} حركة
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function escapeHtmlSup(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openAddBuyerModal() {
  const n = document.getElementById('buyer-name-input');
  const o = document.getElementById('buyer-opening-balance');
  const t = document.getElementById('buyer-notes-input');
  if (n) n.value = '';
  if (o) o.value = '';
  if (t) t.value = '';
  document.getElementById('modal-add-buyer').classList.add('open');
  if (n) n.focus();
}

function confirmAddSupplier() {
  const name = (document.getElementById('buyer-name-input').value || '').trim();
  if (!name) { showToast('أدخل اسم المورد', 'error'); return; }
  const list = getSuppliers();
  if (list.some(s => supNormAr(s.name) === supNormAr(name))) {
    showToast('يوجد مورد بنفس الاسم', 'error');
    return;
  }
  list.push({
    id: 'sup_' + Date.now(),
    name,
    openingBalance: Number(document.getElementById('buyer-opening-balance').value) || 0,
    notes: (document.getElementById('buyer-notes-input').value || '').trim(),
    createdAt: new Date().toISOString()
  });
  setSuppliers(list);
  document.getElementById('modal-add-buyer').classList.remove('open');
  renderSuppliersList();
  showToast('تمت إضافة المورد');
}

/* =====================================================================
   SUPPLIER LEDGER — grouped by invoice, exactly like the file
   ===================================================================== */
const SUP_INVOICES_PER_PAGE = 8;

function openSupplierLedger(supplierId) {
  _currentSupplierId = supplierId;
  _supplierLedgerPage = 0;
  renderSupplierLedger();
  document.getElementById('modal-buyer-ledger').classList.add('open');
}

function renderSupplierLedger() {
  const sup = getSuppliers().find(s => s.id === _currentSupplierId);
  if (!sup) return;

  document.getElementById('buyer-ledger-title').textContent = '📒 دفتر حساب: ' + sup.name;

  const tx = supplierTxOf(sup.id);
  const goods = tx.filter(t => t.kind === 'goods').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const paid = tx.filter(t => t.kind === 'payment').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const bal = supplierBalance(sup.id);

  const box = (label, val, color) => `
    <div style="flex:1;min-width:140px;background:rgba(0,0,0,0.25);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:0.75rem;color:var(--text-secondary)">${label}</div>
      <div style="font-weight:800;font-size:1.1rem;color:${color}">${val}</div>
    </div>`;

  document.getElementById('buyer-balance-summary').innerHTML =
    box('إجمالي البضاعة', fmt(goods, 'دج'), 'var(--gold)') +
    box('إجمالي المدفوع', fmt(paid, 'دج'), 'var(--green)') +
    box(bal >= 0 ? 'الرصيد (مستحق للمورد)' : 'الرصيد (دفعنا زيادة)', fmt(bal, 'دج'),
      bal > 0 ? 'var(--red)' : (bal < 0 ? 'var(--green)' : 'var(--text-secondary)'));

  const content = document.getElementById('buyer-ledger-content');
  if (!tx.length) {
    content.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:30px">
      لا توجد معاملات بعد. استخدم «📥 استيراد Excel» أو أضف حركة يدوياً.</div>`;
    document.getElementById('buyer-ledger-pagination').innerHTML = '';
    return;
  }

  const invoices = getSupplierInvoices()
    .filter(i => i.supplierId === sup.id)
    .sort((a, b) => b.index - a.index);        // newest invoice first

  // Invoice groups first (physical order), then any manual entries.
  const groups = invoices.map(i => ({
    invoice: i,
    rows: tx.filter(t => t.source === 'import' && t.invoiceIndex === i.index)
      .sort((a, b) => a.seq - b.seq)
  }));
  const manual = tx.filter(t => t.source !== 'import')
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (manual.length) groups.unshift({ invoice: null, rows: manual });

  const pages = Math.max(1, Math.ceil(groups.length / SUP_INVOICES_PER_PAGE));
  if (_supplierLedgerPage >= pages) _supplierLedgerPage = pages - 1;
  const slice = groups.slice(_supplierLedgerPage * SUP_INVOICES_PER_PAGE,
    (_supplierLedgerPage + 1) * SUP_INVOICES_PER_PAGE);

  content.innerHTML = slice.map(g => {
    const i = g.invoice;
    const head = i
      ? `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;background:rgba(99,179,237,0.1);padding:8px 12px;border-radius:8px 8px 0 0">
           <strong style="color:var(--blue)">🧾 فاتورة ${i.date || '—'}</strong>
           <span style="font-size:0.8rem;color:var(--text-secondary)">
             المجموع: <b style="color:var(--gold)">${fmt(i.sumGoods)}</b> /
             <b style="color:var(--green)">${fmt(i.sumPayments)}</b>
             &nbsp;•&nbsp; الباقي:
             <b style="color:${i.closingBalance < 0 ? 'var(--red)' : 'var(--text-primary)'}">${fmt(i.closingBalance, 'دج')}</b>
           </span>
         </div>`
      : `<div style="background:rgba(154,117,234,0.12);padding:8px 12px;border-radius:8px 8px 0 0">
           <strong style="color:#b794f4">✍️ حركات يدوية</strong></div>`;

    const body = g.rows.map(t => {
      const isPay = t.kind === 'payment';
      const isAdj = t.kind === 'adjust';
      const label = isAdj ? 'تسوية' : (isPay ? 'دفعة' : 'بضاعة');
      const color = isAdj ? 'var(--gold)' : (isPay ? 'var(--green)' : 'var(--text-primary)');
      return `<tr>
        <td style="white-space:nowrap">${t.date || '—'}</td>
        <td>${escapeHtmlSup(t.warehouse || '')}</td>
        <td>${t.qty == null ? '' : fmt(t.qty)}</td>
        <td>${t.price == null ? '' : fmt(t.price)}</td>
        <td style="color:${color};font-weight:700">${label}</td>
        <td style="text-align:left;font-weight:700;color:${color}">${fmt(t.amount)}</td>
        <td style="font-size:0.78rem;color:var(--text-secondary)">${escapeHtmlSup(t.note || '')}</td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:14px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden">
      ${head}
      <table class="data-table" style="width:100%;font-size:0.8rem">
        <thead><tr><th>التاريخ</th><th>المستودع</th><th>الكمية</th><th>السعر</th><th>النوع</th><th>المبلغ</th><th>الملاحظات</th></tr></thead>
        <tbody>${body || '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary)">لا أسطر</td></tr>'}</tbody>
      </table>
    </div>`;
  }).join('');

  document.getElementById('buyer-ledger-pagination').innerHTML = pages > 1
    ? `<button class="btn btn-outline btn-sm" ${_supplierLedgerPage === 0 ? 'disabled' : ''}
         onclick="supplierLedgerPage(-1)">‹ السابق</button>
       <span style="align-self:center;color:var(--text-secondary);font-size:0.85rem">
         ${_supplierLedgerPage + 1} / ${pages}</span>
       <button class="btn btn-outline btn-sm" ${_supplierLedgerPage >= pages - 1 ? 'disabled' : ''}
         onclick="supplierLedgerPage(1)">التالي ›</button>`
    : '';
}

function supplierLedgerPage(delta) {
  _supplierLedgerPage += delta;
  if (_supplierLedgerPage < 0) _supplierLedgerPage = 0;
  renderSupplierLedger();
}

function deleteCurrentSupplier() {
  const sup = getSuppliers().find(s => s.id === _currentSupplierId);
  if (!sup) return;
  if (!confirm(`حذف المورد «${sup.name}» وجميع معاملاته؟ لا يمكن التراجع.`)) return;
  setSuppliers(getSuppliers().filter(s => s.id !== sup.id));
  setSupplierTx(getSupplierTx().filter(t => t.supplierId !== sup.id));
  setSupplierInvoices(getSupplierInvoices().filter(i => i.supplierId !== sup.id));
  _currentSupplierId = null;
  document.getElementById('modal-buyer-ledger').classList.remove('open');
  renderSuppliersList();
  showToast('تم حذف المورد');
}

/* ---------------- manual entries ---------------- */
function updatePickupCalc() {
  const q = Number((document.getElementById('pickup-quantity') || {}).value) || 0;
  const p = Number((document.getElementById('pickup-unit-price') || {}).value) || 0;
  const el = document.getElementById('pickup-total-preview');
  if (el) el.textContent = (q && p) ? fmt(q * p, 'دج') : '—';
}

function openPickupModal() {
  if (!_currentSupplierId) return;
  const sel = document.getElementById('pickup-factory-select');
  if (sel) {
    const facs = (typeof FactoryDB !== 'undefined') ? FactoryDB.getFactories() : [];
    sel.innerHTML = '<option value="">— اختر المصنع —</option>' +
      facs.map(f => `<option value="${f.id}">${escapeHtmlSup(f.name)}</option>`).join('');
  }
  const d = document.getElementById('pickup-date');
  if (d) d.value = todayStr();
  ['pickup-quantity', 'pickup-unit-price', 'pickup-category'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  updatePickupCalc();
  document.getElementById('modal-add-pickup').classList.add('open');
}

function confirmAddPickup() {
  if (!_currentSupplierId) return;
  const qty = Number(document.getElementById('pickup-quantity').value) || 0;
  const price = Number(document.getElementById('pickup-unit-price').value) || 0;
  const date = document.getElementById('pickup-date').value || todayStr();
  const cat = (document.getElementById('pickup-category').value || '').trim();
  const sel = document.getElementById('pickup-factory-select');
  const facName = sel && sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : '';
  if (!qty || !price) { showToast('أدخل الكمية والسعر', 'error'); return; }

  const list = getSupplierTx();
  list.push({
    id: 'stx_m_' + Date.now(), supplierId: _currentSupplierId, source: 'manual',
    kind: 'goods', date, warehouse: facName || cat, qty, price,
    amount: qty * price, note: cat, invoiceDate: null, invoiceIndex: null,
    excelRow: null, seq: null
  });
  setSupplierTx(list);
  document.getElementById('modal-add-pickup').classList.remove('open');
  renderSupplierLedger();
  renderSuppliersList();
  showToast('تم تسجيل السحب');
}

function openSupplierPaymentModal() {
  if (!_currentSupplierId) return;
  const d = document.getElementById('payment-date');
  if (d) d.value = todayStr();
  ['payment-amount', 'payment-note'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  document.getElementById('modal-add-payment').classList.add('open');
}

function confirmAddSupplierPayment() {
  if (!_currentSupplierId) return;
  const amount = Number(document.getElementById('payment-amount').value) || 0;
  if (!amount) { showToast('أدخل المبلغ', 'error'); return; }
  const list = getSupplierTx();
  list.push({
    id: 'stx_p_' + Date.now(), supplierId: _currentSupplierId, source: 'manual',
    kind: 'payment', date: document.getElementById('payment-date').value || todayStr(),
    warehouse: '', qty: null, price: null, amount,
    note: (document.getElementById('payment-note').value || '').trim(),
    invoiceDate: null, invoiceIndex: null, excelRow: null, seq: null
  });
  setSupplierTx(list);
  document.getElementById('modal-add-payment').classList.remove('open');
  renderSupplierLedger();
  renderSuppliersList();
  showToast('تم تسجيل الدفعة');
}

/* =====================================================================
   WIRING
   ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };

  on('btn-confirm-add-buyer', 'click', confirmAddSupplier);
  on('btn-delete-buyer', 'click', deleteCurrentSupplier);
  on('btn-add-pickup-for-buyer', 'click', openPickupModal);
  on('btn-confirm-add-pickup', 'click', confirmAddPickup);
  on('btn-add-payment-for-buyer', 'click', openSupplierPaymentModal);
  on('btn-confirm-add-payment', 'click', confirmAddSupplierPayment);
  on('btn-confirm-import', 'click', commitSupplierImport);
  on('buyer-excel-input', 'change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) handleSupplierExcelImport(f);
  });
});


/* =====================================================================
   العمال (حسب النوع)  +  بلاكة
   Panel-based Excel importers. Both workbooks lay data out as panels
   scattered over a grid, so everything is discovered by LABEL, never by
   fixed row numbers (the rows genuinely move between sheets).
   ===================================================================== */

/* ---------- shared grid helpers (0-based rows/cols) ---------- */
function wpCell(rows, r, c) {
  const row = rows[r];
  if (!row) return null;
  const v = row[c];
  return (v === undefined || v === '') ? null : v;
}
function wpLabel(rows, r, c) { return supNormAr(wpCell(rows, r, c)); }

// Excel-style address for messages: (0,0) -> A1
function wpAddr(r, c) {
  let s = '', n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s + (r + 1);
}

// Numeric cell, or null when blank/non-numeric. Blank must stay distinct
// from 0 — an empty wage means "no fixed wage", not "wage of zero".
function wpNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const n = supParseNum(v);
  return (n === 0 && !/\d/.test(String(v))) ? null : n;
}
function wpEq(a, b) { return Math.abs((a || 0) - (b || 0)) < 0.005; }

const WP_MONTHS = {
  'septembre': 9, 'séptembre': 9, 'octobre': 10, 'novembre': 11,
  'decembre': 12, 'décembre': 12, 'janvier': 1, 'fevrier': 2, 'février': 2,
  'mars': 3, 'avril': 4, 'mai': 5, 'juin': 6,
  'juillet': 7, 'juillrt': 7, 'aout': 8, 'août': 8
};

// Sheet name -> {month, year|null}. Tolerates the misspellings in the files
// (Séptembre / AVril / Juillrt / Fevrier).
function wpParseSheetName(name) {
  const s = String(name || '').trim();
  const ym = s.match(/(19|20)\d{2}/);
  const year = ym ? +ym[0] : null;
  const word = s.replace(/[\d\s]+/g, '').toLowerCase();
  let month = null;
  for (const k in WP_MONTHS) {
    if (word && (word.indexOf(k) === 0 || k.indexOf(word) === 0)) { month = WP_MONTHS[k]; break; }
  }
  if (month === null) {
    for (const k in WP_MONTHS) if (s.toLowerCase().indexOf(k) >= 0) { month = WP_MONTHS[k]; break; }
  }
  return { month, year };
}

/* Fill in missing years by walking the sheets in PHYSICAL order and
   bumping the year whenever the month goes backwards (Dec -> Jan). */
function wpResolveMonths(sheetNames) {
  const parsed = sheetNames.map(wpParseSheetName);
  let anchor = -1;
  for (let i = 0; i < parsed.length; i++) if (parsed[i].year) { anchor = i; break; }
  if (anchor === -1) return parsed.map(p => ({ month: p.month, year: null }));

  const years = new Array(parsed.length).fill(null);
  let cur = parsed[anchor].year;
  years[anchor] = cur;
  for (let i = anchor - 1; i >= 0; i--) {
    if (parsed[i].month !== null && parsed[i + 1].month !== null &&
        parsed[i].month > parsed[i + 1].month) cur--;
    years[i] = parsed[i].year || cur;
  }
  cur = parsed[anchor].year;
  for (let i = anchor + 1; i < parsed.length; i++) {
    if (parsed[i].year) cur = parsed[i].year;
    else if (parsed[i].month !== null && parsed[i - 1].month !== null &&
             parsed[i].month < parsed[i - 1].month) cur++;
    years[i] = cur;
  }
  return parsed.map((p, i) => ({ month: p.month, year: years[i] }));
}

function wpMonthKey(m) {
  if (!m || m.month === null || !m.year) return null;
  return m.year + '-' + String(m.month).padStart(2, '0');
}

/* =====================================================================
   WORKER WORKBOOK PARSER
   Panel anchor = a cell reading «الأجرة» at (r, c):
     name (r-3,c) | assignment (r-2,c) | wage (r+1,c) | balance (r+1,c+1)
     header  = first row > r in column c reading «التاريخ»
     closing = first row > r in column c reading «المجموع», total at (row,c+1)
   ===================================================================== */
function parseWorkerWorkbook(sheets, typeName) {
  // sheets: [{ name, rows }]
  const warnings = [];
  const panels = [];
  const inherited = {};      // "band|col" -> last name seen at that slot
  const months = wpResolveMonths(sheets.map(s => s.name));
  const warn = (code, message, sheet) => warnings.push({ code, message, sheet: sheet || null });

  sheets.forEach((sh, si) => {
    const rows = sh.rows || [];
    const mo = months[si];
    const monthKey = wpMonthKey(mo);
    if (!monthKey) warn('bad-sheet-name', `تعذّر استنتاج الشهر من اسم الورقة «${sh.name}».`, sh.name);

    // find every «الأجرة» anchor
    const anchors = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (supNormAr(row[c]) === supNormAr('الأجرة')) anchors.push([r, c]);
      }
    }
    const bandRows = [...new Set(anchors.map(a => a[0]))].sort((a, b) => a - b);

    anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([r, c]) => {
      const band = bandRows.indexOf(r);
      const slot = band + '|' + c;
      let name = supStr(wpCell(rows, r - 3, c));
      let assign = supStr(wpCell(rows, r - 2, c));

      // «العلف» panels are paid by tonnage: wage = qty * price
      const isFeed = supNormAr(assign) === supNormAr('العلف');
      let qty = null, price = null;
      if (isFeed) {
        qty = wpNum(wpCell(rows, r - 2, c + 1));
        price = wpNum(wpCell(rows, r - 2, c + 2));
        if (qty === null && price === null) {
          qty = wpNum(wpCell(rows, r - 3, c + 1));
          price = wpNum(wpCell(rows, r - 3, c + 2));
        }
        assign = '';
      }

      if (name) {
        inherited[slot] = name;
      } else if (inherited[slot]) {
        name = inherited[slot];
        warn('inherited-name',
          `${sh.name}: لوحة بلا اسم في ${wpAddr(r, c)} — ورثت الاسم «${name}» من ورقة سابقة.`, sh.name);
      } else {
        warn('no-name',
          `${sh.name}: لوحة بلا اسم في ${wpAddr(r, c)} ولا يوجد اسم سابق في نفس الموضع — مُستبعَدة.`, sh.name);
        panels.push({ sheet: sh.name, monthKey, col: c, band, anchorRow: r,
                      name: '', assign, isFeed, qty, price, skipped: true, draws: [] });
        return;
      }

      const wage = wpNum(wpCell(rows, r + 1, c));
      const fileBalance = wpNum(wpCell(rows, r + 1, c + 1));

      let headRow = -1, closeRow = -1;
      for (let rr = r + 1; rr < rows.length; rr++) {
        const lab = wpLabel(rows, rr, c);
        if (headRow === -1 && lab === supNormAr('التاريخ')) headRow = rr;
        if (closeRow === -1 && lab === supNormAr('المجموع')) { closeRow = rr; break; }
      }
      if (headRow === -1 || closeRow === -1) {
        warn('bad-panel', `${sh.name}: لوحة «${name}» في ${wpAddr(r, c)} ينقصها صف الرأس أو المجموع — مُستبعَدة.`, sh.name);
        return;
      }

      const fileTotal = wpNum(wpCell(rows, closeRow, c + 1));
      const draws = [];
      for (let rr = headRow + 1; rr < closeRow; rr++) {
        const amt = wpNum(wpCell(rows, rr, c + 1));
        if (amt === null) continue;               // blank line inside the panel
        const rawDate = wpCell(rows, rr, c);
        const date = supParseDate(rawDate);
        if (rawDate !== null && !date) {
          warn('bad-date',
            `${sh.name}/${name}: تاريخ غير صالح «${supStr(rawDate)}» في ${wpAddr(rr, c)} — استُورد السحب بلا تاريخ.`, sh.name);
        }
        draws.push({
          excelRow: rr + 1, date, amount: amt,
          note: supStr(wpCell(rows, rr, c + 2)), seq: draws.length
        });
      }

      const calcTotal = draws.reduce((s, d) => s + d.amount, 0);
      const effTotal = (fileTotal === null) ? calcTotal : fileTotal;
      const calcBalance = (wage || 0) - effTotal;

      if (fileTotal !== null && !wpEq(calcTotal, fileTotal)) {
        warn('total-mismatch',
          `${sh.name}/${name}: مجموع الأسطر ${fmt(calcTotal)} لا يطابق «المجموع» ${fmt(fileTotal)}.`, sh.name);
      }
      if (fileBalance === null) {
        warn('empty-balance',
          `${sh.name}: خانة «الباقي» فارغة في ${wpAddr(r + 1, c + 1)} للعامل «${name}» — حُسبت (${fmt(calcBalance)}).`, sh.name);
      } else if (!wpEq(calcBalance, fileBalance)) {
        warn('balance-mismatch',
          `${sh.name}/${name}: الباقي المحسوب ${fmt(calcBalance)} لا يطابق المكتوب ${fmt(fileBalance)}.`, sh.name);
      }
      if (isFeed && wage !== null && !wpEq((qty || 0) * (price || 0), wage)) {
        warn('feed-mismatch',
          `${sh.name}/${name}: ${fmt(qty)}×${fmt(price)} لا يساوي الأجرة ${fmt(wage)}.`, sh.name);
      }
      if (isFeed && qty === null) {
        warn('feed-no-qty', `${sh.name}/${name}: عدد القناطير فارغ — الأجرة 0.`, sh.name);
      }
      // A withdrawal dated in the following month is normal (end-of-month
      // settlement). Only flag dates that are genuinely far from the sheet.
      draws.forEach(d => {
        if (!d.date || !monthKey) return;
        const dm = (+d.date.slice(0, 4)) * 12 + (+d.date.slice(5, 7));
        const sm = (+monthKey.slice(0, 4)) * 12 + (+monthKey.slice(5, 7));
        if (dm - sm > 1 || dm - sm < -1) {
          warn('date-far-outside-month',
            `${sh.name}/${name}: سحب بتاريخ ${d.date} بعيد عن شهر الورقة (${monthKey}) — تحقّق منه.`, sh.name);
        }
      });

      panels.push({
        sheet: sh.name, monthKey, col: c, band, anchorRow: r, headRow, closeRow,
        name, assign, isFeed, qty, price,
        wage: wage === null ? null : wage,
        fileTotal, fileBalance,
        calcTotal, calcBalance,
        balance: fileBalance === null ? calcBalance : fileBalance,
        draws, skipped: false
      });
    });
  });

  const kept = panels.filter(p => !p.skipped);
  const accounts = {};
  kept.forEach(p => {
    const key = supNormAr(p.name) + '|' + supNormAr(p.assign);
    if (!accounts[key]) accounts[key] = { key, name: p.name, assign: p.assign, months: 0 };
    accounts[key].months++;
  });

  return {
    ok: kept.length > 0,
    typeName,
    months,
    sheetNames: sheets.map(s => s.name),
    panels, kept,
    skipped: panels.filter(p => p.skipped),
    accounts: Object.keys(accounts).map(k => accounts[k]),
    names: [...new Set(kept.map(p => supNormAr(p.name)))],
    warnings,
    totals: {
      wage: kept.reduce((s, p) => s + (p.wage || 0), 0),
      draws: kept.reduce((s, p) => s + p.draws.reduce((a, d) => a + d.amount, 0), 0),
      drawRows: kept.reduce((s, p) => s + p.draws.length, 0)
    }
  };
}

/* =====================================================================
   PLAKA WORKBOOK PARSER
   Panel header = a cell reading «التاريخ» at (r, c); location name at (r-1, c).
   Columns: c التاريخ | c+1 النوعية | c+2 الكمية | c+3 السعر
            c+4 الناتج | c+5 الدفع  | c+6 ملاحظات   («الباقي» sits under c+6)
   ===================================================================== */
// Feuil1 columns I and Q repeat the standalone 24500 / 23000 sheets.
const PLAKA_DUPLICATE_PANELS = [{ sheet: 'Feuil1', col: 8 }, { sheet: 'Feuil1', col: 16 }];

function parsePlakaWorkbook(sheets, supplierName, options) {
  options = options || {};
  const includeDuplicates = !!options.includeDuplicates;
  const warnings = [];
  const panels = [];
  const warn = (code, message, sheet) => warnings.push({ code, message, sheet: sheet || null });

  sheets.forEach(sh => {
    const rows = sh.rows || [];
    const heads = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (supNormAr(row[c]) === supNormAr('التاريخ')) heads.push([r, c]);
      }
    }

    heads.sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([r, c]) => {
      const name = supStr(wpCell(rows, r - 1, c)) || sh.name;
      let closeRow = -1;
      for (let rr = r + 1; rr < rows.length; rr++) {
        if (wpLabel(rows, rr, c) === supNormAr('المجموع')) { closeRow = rr; break; }
      }
      if (closeRow === -1) {
        warn('no-total', `${sh.name}: لوحة «${name}» بلا صف «المجموع» — مُستبعَدة.`, sh.name);
        return;
      }

      const moves = [];
      let lastDate = null;
      for (let rr = r + 1; rr < closeRow; rr++) {
        const rawDate = wpCell(rows, rr, c);
        const material = supStr(wpCell(rows, rr, c + 1));
        const qty = wpNum(wpCell(rows, rr, c + 2));
        const price = wpNum(wpCell(rows, rr, c + 3));
        const goods = wpNum(wpCell(rows, rr, c + 4)) || 0;
        const pay = wpNum(wpCell(rows, rr, c + 5)) || 0;
        const note = supStr(wpCell(rows, rr, c + 6));
        if (rawDate === null && !material && qty === null && price === null &&
            goods === 0 && pay === 0 && !note) continue;

        const d = supParseDate(rawDate);
        if (d) lastDate = d;                      // blank date inherits from the row above
        if (goods === 0 && qty !== null) {
          warn('unpriced',
            `${sh.name}/${name} صف ${rr + 1}: كمية ${fmt(qty)} بلا ناتج — تسليم غير مسعّر.`, sh.name);
        }
        moves.push({
          excelRow: rr + 1, date: d || lastDate, material, qty, price,
          goods, pay, note, seq: moves.length
        });
      }

      const fileGoods = wpNum(wpCell(rows, closeRow, c + 4)) || 0;
      const filePay = wpNum(wpCell(rows, closeRow, c + 5)) || 0;
      const fileBalance = wpNum(wpCell(rows, closeRow, c + 6)) || 0;

      // Everything below «المجموع» inside the panel's columns is the owner's
      // scratch arithmetic (sums of two related sites) — never data.
      for (let rr = closeRow + 1; rr < rows.length; rr++) {
        for (let cc = c; cc <= c + 6; cc++) {
          const v = wpCell(rows, rr, cc);
          if (typeof v === 'number' && v !== 0) {
            warn('below-total',
              `${sh.name}/${name}: القيمة ${fmt(v)} في ${wpAddr(rr, cc)} أسفل صف «المجموع» — ملاحظة حسابية، مُتجاهَلة.`, sh.name);
          }
        }
      }

      const calcGoods = moves.reduce((s, m) => s + m.goods, 0);
      const calcPay = moves.reduce((s, m) => s + m.pay, 0);
      if (!wpEq(calcGoods, fileGoods)) {
        warn('goods-mismatch',
          `${sh.name}/${name}: مجموع الناتج ${fmt(calcGoods)} لا يطابق المكتوب ${fmt(fileGoods)}.`, sh.name);
      }
      if (!wpEq(calcPay, filePay)) {
        warn('pay-mismatch',
          `${sh.name}/${name}: مجموع الدفع ${fmt(calcPay)} لا يطابق المكتوب ${fmt(filePay)}.`, sh.name);
      }
      if (!wpEq(fileGoods - filePay, fileBalance)) {
        warn('balance-mismatch',
          `${sh.name}/${name}: الباقي المكتوب ${fmt(fileBalance)} لا يساوي الناتج − الدفع (${fmt(fileGoods - filePay)}).`, sh.name);
      }

      const dup = PLAKA_DUPLICATE_PANELS.some(d => d.sheet === sh.name && d.col === c);
      if (dup) {
        warn('duplicate-panel',
          `${sh.name}: لوحة «${name}» في العمود ${wpAddr(r, c).replace(/\d+/, '')} مكرّرة مع ورقة «${name}» المستقلّة — ` +
          (includeDuplicates ? 'أُدرجت بطلبك (يرفع الرصيد خطأً).' : 'مُستبعَدة.'), sh.name);
      }

      panels.push({
        sheet: sh.name, col: c, headRow: r, closeRow, name,
        moves, fileGoods, filePay, fileBalance, calcGoods, calcPay,
        excluded: dup && !includeDuplicates
      });
    });
  });

  const kept = panels.filter(p => !p.excluded);
  let txCount = 0, deliveries = 0;
  kept.forEach(p => p.moves.forEach(m => {
    if (m.goods !== 0) txCount++;
    if (m.pay !== 0) txCount++;
    if (m.goods === 0 && m.pay === 0) deliveries++;
  }));

  return {
    ok: kept.length > 0,
    supplierName: supplierName || 'سليم',
    panels, kept,
    excluded: panels.filter(p => p.excluded),
    warnings,
    totals: {
      goods: kept.reduce((s, p) => s + p.fileGoods, 0),
      pay: kept.reduce((s, p) => s + p.filePay, 0),
      balance: kept.reduce((s, p) => s + p.fileBalance, 0),
      txCount, deliveries, locations: kept.length
    }
  };
}

/* =====================================================================
   WORKBOOK READING
   ===================================================================== */
async function wpReadWorkbook(file) {
  if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير محمّلة');
  let wb;
  if (/\.csv$/i.test(file.name)) {
    wb = XLSX.read(await file.text(), { type: 'string', raw: true });
  } else {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  }
  // sheet_to_json returns cached formula RESULTS, never the formulas themselves.
  // range:0 forces the array to start at Excel row 1. Without it SheetJS honours
  // the sheet's declared !ref (e.g. "A3:G423") and every row index — and so every
  // row number we report or key on — silently shifts.
  return wb.SheetNames.map(n => ({
    name: n,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: true, range: 0 })
  }));
}


/* =====================================================================
   STORAGE — workers by type, and the بلاكة supplier
   ===================================================================== */
const WP_COLL = {
  types: 'worker_types', months: 'worker_months', draws: 'worker_draws',
  locs: 'plaka_locations', ptx: 'plaka_tx'
};

function getWorkerTypes() { return supRead(WP_COLL.types); }
function setWorkerTypes(a) { supWrite(WP_COLL.types, a); }
function getWorkerMonths() { return supRead(WP_COLL.months); }
function setWorkerMonths(a) { supWrite(WP_COLL.months, a); }
function getWorkerDraws() { return supRead(WP_COLL.draws); }
function setWorkerDraws(a) { supWrite(WP_COLL.draws, a); }
function getPlakaLocations() { return supRead(WP_COLL.locs); }
function setPlakaLocations(a) { supWrite(WP_COLL.locs, a); }
function getPlakaTx() { return supRead(WP_COLL.ptx); }
function setPlakaTx(a) { supWrite(WP_COLL.ptx, a); }

let _wpPreview = null;          // pending import awaiting confirmation
let _currentWorkerType = null;
let _currentPlakaSupplier = null;
let _currentWorkerAccount = null;

function wpAccountKey(name, assign) { return supNormAr(name) + '|' + supNormAr(assign); }

/* The months are independent — summing wages across them is meaningless.
   A worker's wage is a MONTHLY figure: the most recently recorded one. */
function wpMonthlyWage(months) {
  const withWage = months
    .filter(m => m.wage !== null && m.wage !== undefined)
    .sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)) || ((a.col || 0) - (b.col || 0)));
  return withWage.length ? Number(withWage[withWage.length - 1].wage) || 0 : 0;
}
function wpMonthLabel(key) {
  if (!key) return '—';
  const AR = ['', 'جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان',
              'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const m = +key.slice(5, 7);
  return (AR[m] || key.slice(5, 7)) + ' ' + key.slice(0, 4);
}

/* =====================================================================
   WORKERS — import
   ===================================================================== */
async function handleWorkerTypeImport(file) {
  if (!file) return;
  showToast('جاري تحليل ملف العمال...', 'info');
  try {
    const sheets = await wpReadWorkbook(file);
    const typeName = file.name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '').trim();
    const result = parseWorkerWorkbook(sheets, typeName);
    if (!result.ok) {
      showToast('لم يُعثر على أي لوحة عامل في هذا الملف (لا توجد خلية «الأجرة»).', 'error');
      return;
    }
    _wpPreview = { mode: 'workers', result, fileName: file.name, typeName };
    showWpPreview();
  } catch (err) {
    console.error('[handleWorkerTypeImport]', err);
    showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
  }
}

function commitWorkerImport() {
  const p = _wpPreview;
  if (!p || p.mode !== 'workers') return;
  const r = p.result;
  const replace = !!(document.getElementById('wp-import-replace') || {}).checked;

  /* MANDATORY verification: every panel's arithmetic must agree with the
     numbers written in the file. Any disagreement aborts the whole import. */
  const bad = [];
  r.kept.forEach(pl => {
    const calc = pl.draws.reduce((s, d) => s + d.amount, 0);
    if (pl.fileTotal !== null && !wpEq(calc, pl.fileTotal)) {
      bad.push(`${pl.sheet} / ${pl.name}: المجموع المحسوب ${fmt(calc)} ≠ المكتوب ${fmt(pl.fileTotal)}`);
    }
    if (pl.fileBalance !== null && !wpEq((pl.wage || 0) - (pl.fileTotal === null ? calc : pl.fileTotal), pl.fileBalance)) {
      bad.push(`${pl.sheet} / ${pl.name}: الباقي المحسوب ${fmt((pl.wage || 0) - calc)} ≠ المكتوب ${fmt(pl.fileBalance)}`);
    }
  });
  if (bad.length) {
    document.getElementById('modal-wp-preview').classList.remove('open');
    showToast('❌ أُلغي الاستيراد — ' + bad.length + ' لوحة لا تطابق الملف. أوّلها: ' + bad[0], 'error');
    console.error('[worker import] verification failed', bad);
    return;
  }

  const types = getWorkerTypes();
  let type = types.find(t => supNormAr(t.name) === supNormAr(p.typeName));
  if (!type) {
    type = { id: 'wt_' + Date.now(), name: p.typeName, fileName: p.fileName };
    types.push(type);
  }
  type.fileName = p.fileName;
  type.importedAt = new Date().toISOString();

  const allMonths = getWorkerMonths();
  const allDraws = getWorkerDraws();
  const keptMonths = allMonths.filter(m => m.typeId !== type.id || !replace);
  const keptDraws = allDraws.filter(d => d.typeId !== type.id || !replace);
  const seenM = new Set(keptMonths.filter(m => m.typeId === type.id).map(m => m.importKey));
  const seenD = new Set(keptDraws.filter(d => d.typeId === type.id).map(d => d.importKey));

  const newMonths = [], newDraws = [];
  let skipped = 0;
  r.kept.forEach(pl => {
    const accountKey = wpAccountKey(pl.name, pl.assign);
    const mKey = `${type.id}|${accountKey}|${pl.monthKey}|${pl.sheet}|${pl.col}`;
    if (!seenM.has(mKey)) {
      seenM.add(mKey);
      newMonths.push({
        id: 'wm_' + newMonths.length + '_' + Date.now().toString(36),
        typeId: type.id, importKey: mKey, accountKey,
        name: pl.name, assign: pl.assign, isFeed: pl.isFeed,
        qty: pl.qty, price: pl.price, wage: pl.wage,
        monthKey: pl.monthKey, sheet: pl.sheet, col: pl.col,
        fileTotal: pl.fileTotal, fileBalance: pl.fileBalance,
        total: pl.fileTotal === null ? pl.calcTotal : pl.fileTotal,
        balance: pl.balance
      });
    } else { skipped++; }

    pl.draws.forEach(d => {
      const dKey = `${type.id}|${accountKey}|${pl.monthKey}|${pl.sheet}|${pl.col}|${d.seq}`;
      if (seenD.has(dKey)) { skipped++; return; }
      seenD.add(dKey);
      newDraws.push({
        id: 'wd_' + newDraws.length + '_' + Date.now().toString(36),
        typeId: type.id, importKey: dKey, accountKey,
        monthKey: pl.monthKey, sheet: pl.sheet, col: pl.col,
        date: d.date, amount: d.amount, note: d.note,
        excelRow: d.excelRow, seq: d.seq
      });
    });
  });

  setWorkerTypes(types);
  setWorkerMonths(keptMonths.concat(newMonths));
  setWorkerDraws(keptDraws.concat(newDraws));

  _wpPreview = null;
  document.getElementById('modal-wp-preview').classList.remove('open');
  const inp = document.getElementById('worker-type-import-input');
  if (inp) inp.value = '';
  renderWorkerTypes();
  showToast(`✅ ${p.typeName}: ${newMonths.length} لوحة و${newDraws.length} سحب` +
    (skipped ? ` (تُخُطّي ${skipped} مكرّرة)` : ''));
}

/* =====================================================================
   PLAKA — import
   ===================================================================== */
async function handlePlakaImport(file) {
  if (!file) return;
  showToast('جاري تحليل ملف البلاكة...', 'info');
  try {
    const sheets = await wpReadWorkbook(file);
    const supplierName = 'سليم';
    const includeDuplicates = !!(document.getElementById('plaka-include-dupes') || {}).checked;
    const result = parsePlakaWorkbook(sheets, supplierName, { includeDuplicates });
    if (!result.ok) {
      showToast('لم يُعثر على أي لوحة في ملف البلاكة (لا توجد خلية «التاريخ»).', 'error');
      return;
    }
    _wpPreview = { mode: 'plaka', result, fileName: file.name, supplierName };
    showWpPreview();
  } catch (err) {
    console.error('[handlePlakaImport]', err);
    showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
  }
}

function commitPlakaImport() {
  const p = _wpPreview;
  if (!p || p.mode !== 'plaka') return;
  const r = p.result;
  const replace = !!(document.getElementById('wp-import-replace') || {}).checked;

  /* MANDATORY verification against the file's own «المجموع» / «الباقي». */
  const bad = [];
  r.kept.forEach(loc => {
    if (!wpEq(loc.calcGoods, loc.fileGoods)) {
      bad.push(`${loc.sheet} / ${loc.name}: الناتج المحسوب ${fmt(loc.calcGoods)} ≠ المكتوب ${fmt(loc.fileGoods)}`);
    }
    if (!wpEq(loc.calcPay, loc.filePay)) {
      bad.push(`${loc.sheet} / ${loc.name}: الدفع المحسوب ${fmt(loc.calcPay)} ≠ المكتوب ${fmt(loc.filePay)}`);
    }
    if (!wpEq(loc.fileGoods - loc.filePay, loc.fileBalance)) {
      bad.push(`${loc.sheet} / ${loc.name}: الباقي المكتوب ${fmt(loc.fileBalance)} ≠ الناتج − الدفع`);
    }
  });
  if (bad.length) {
    document.getElementById('modal-wp-preview').classList.remove('open');
    showToast('❌ أُلغي الاستيراد — ' + bad.length + ' اختلاف عن الملف. أوّلها: ' + bad[0], 'error');
    console.error('[plaka import] verification failed', bad);
    return;
  }

  const allLocs = replace ? [] : getPlakaLocations();
  const allTx = replace ? [] : getPlakaTx();
  const seen = new Set(allTx.map(t => t.importKey));

  const newLocs = [], newTx = [];
  let skipped = 0;
  r.kept.forEach(loc => {
    const locId = 'pl_' + supNormAr(loc.name).replace(/\s+/g, '_') + '_' + supNormAr(loc.sheet).replace(/\s+/g, '_');
    if (!allLocs.some(l => l.id === locId) && !newLocs.some(l => l.id === locId)) {
      newLocs.push({
        id: locId, supplierId: plakaEnsureSupplier(p.supplierName), source: 'import',
        supplier: p.supplierName, name: loc.name, sheet: loc.sheet,
        fileGoods: loc.fileGoods, filePay: loc.filePay, fileBalance: loc.fileBalance
      });
    }
    loc.moves.forEach(m => {
      const push = (kind, amount) => {
        const key = `${p.supplierName}|${loc.name}|${loc.sheet}|${m.seq}|${kind}`;
        if (seen.has(key)) { skipped++; return; }
        seen.add(key);
        newTx.push({
          id: 'ptx_' + newTx.length + '_' + Date.now().toString(36),
          locationId: locId, importKey: key, kind, amount,
          date: m.date, material: m.material, qty: m.qty, price: m.price,
          note: m.note, excelRow: m.excelRow, seq: m.seq
        });
      };
      if (m.goods !== 0) push('goods', m.goods);
      if (m.pay !== 0) push('payment', m.pay);
      // an unpriced delivery still happened — keep it visible, at zero value
      if (m.goods === 0 && m.pay === 0 && m.qty !== null) push('delivery', 0);
    });
  });

  setPlakaLocations(allLocs.concat(newLocs));
  setPlakaTx(allTx.concat(newTx));

  _wpPreview = null;
  document.getElementById('modal-wp-preview').classList.remove('open');
  const inp = document.getElementById('plaka-import-input');
  if (inp) inp.value = '';
  renderPlakaPanel();
  showToast(`✅ بلاكة: ${newLocs.length} موقع و${newTx.length} حركة` +
    (skipped ? ` (تُخُطّي ${skipped} مكرّرة)` : ''));
}

/* =====================================================================
   SHARED PREVIEW
   ===================================================================== */
const WP_WARN_LABEL = {
  'no-name': '👤 لوحات بلا اسم (مُستبعَدة)',
  'inherited-name': '👤 اسم موروث من ورقة سابقة',
  'empty-balance': '🧮 خانة «الباقي» فارغة (حُسبت)',
  'total-mismatch': '❌ فرق في «المجموع»',
  'balance-mismatch': '❌ فرق في «الباقي»',
  'feed-mismatch': '❌ قناطير × سعر ≠ الأجرة',
  'feed-no-qty': '🌾 عدد القناطير فارغ (أجرة 0)',
  'date-far-outside-month': '📅 تاريخ بعيد عن شهر الورقة',
  'bad-date': '📅 تاريخ غير صالح',
  'bad-sheet-name': '📄 تعذّر استنتاج الشهر',
  'bad-panel': '⚠️ لوحة ناقصة',
  'unpriced': '🏷️ تسليم غير مسعّر',
  'below-total': '🧾 قيمة أسفل «المجموع» (مُتجاهَلة)',
  'duplicate-panel': '♻️ لوحة مكرّرة',
  'goods-mismatch': '❌ فرق في الناتج',
  'pay-mismatch': '❌ فرق في الدفع',
  'no-total': '❓ بلا صف «المجموع»',
  'no-item': '💊 مبلغ بلا اسم دواء',
  'unknown-site': '❔ جهة مجهولة (??????)',
  'note-is-serial': '📅 ملاحظة تبدو رقم تاريخ Excel',
  'formula-mismatch': '❌ الكمية × السعر ≠ الناتج',
  'no-date': '📅 سطر بلا تاريخ ولا تاريخ سابق',
  'no-blocks': '❓ لا توجد كتل في الورقة',
  'computed-values': '🧮 صيغ بلا قيم محفوظة — حُسبت',
  'totals-computed': '🧮 إجماليات محسوبة من الأسطر',
  'opening-balance': '📌 رصيد افتتاحي مُرحَّل',
  'inferred-item': '🏷️ صنف مُستنتَج من السعر',
  'date-out-of-order': '📅 تاريخ خارج التسلسل',
  'inherit-date': '📅 تاريخ موروث من السطر الأعلى',
  'rest-mismatch': '❌ «الباقي» لا يساوي الفرق',
  'bad-file': '📄 ملف غير صالح'
};

function showWpPreview() {
  const p = _wpPreview;
  if (!p) return;
  const r = p.result;
  const isW = p.mode === 'workers';
  const isV = p.mode === 'vet';
  const isR = p.mode === 'raha';

  const chip = (label, value, color) => `
    <div style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border-radius:8px;padding:10px 12px;text-align:center">
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:4px">${label}</div>
      <div style="font-weight:800;font-size:1.02rem;color:${color || 'var(--text-primary)'}">${value}</div>
    </div>`;

  document.getElementById('modal-wp-preview-title').textContent =
    isW ? `👷 معاينة استيراد عمال: ${p.typeName}`
        : isV ? '🩺 معاينة استيراد البيطرة'
        : isR ? '⚙️ معاينة استيراد الرحى'
        : '🧱 معاينة استيراد بلاكة';

  let summary = chip('الملف', escapeHtmlSup(p.fileName), 'var(--blue)');
  if (isW) {
    summary +=
      chip('الأوراق (الأشهر)', r.sheetNames.length) +
      chip('لوحات مستوردة', r.kept.length) +
      chip('لوحات مستبعَدة', r.skipped.length, r.skipped.length ? 'var(--gold)' : 'var(--text-secondary)') +
      chip('حسابات', r.accounts.length) +
      chip('أسطر السحب', r.totals.drawRows) +
      chip('إجمالي الأجرة', fmt(r.totals.wage), 'var(--green)') +
      chip('إجمالي السحوبات', fmt(r.totals.draws), 'var(--gold)');
  } else if (isR) {
    summary +=
      chip('الحسابات', r.accounts.length) +
      chip('حركات بضاعة/بيع', r.totals.buys, '#f6ad55') +
      chip('حركات دفع/تحصيل', r.totals.pays, 'var(--green)') +
      chip('مشتريات — مستحقّ', fmt(r.totals.rest, 'دج'), 'var(--red)') +
      chip('النخالة — الفارق', fmt(r.totals.saleRest, 'دج'),
           r.totals.saleRest === 0 ? 'var(--green)' : 'var(--red)') +
      (r.totals.labour ? chip('خدامة (خارج الرصيد)', fmt(r.totals.labour), '#f6ad55') : '');
  } else if (isV) {
    summary +=
      chip('الحسابات', r.accounts.length) +
      chip('حركات شراء', r.totals.buys, 'var(--gold)') +
      chip('حركات دفع', r.totals.pays, 'var(--green)') +
      chip('إجمالي الحركات', r.totals.txCount) +
      chip('إجمالي الناتج', fmt(r.totals.goods)) +
      chip('إجمالي الدفع', fmt(r.totals.pay)) +
      chip('الرصيد', fmt(r.totals.balance, 'دج'), r.totals.balance < 0 ? 'var(--green)' : 'var(--red)');
  } else {
    summary +=
      chip('المواقع', r.totals.locations) +
      chip('الحركات', r.totals.txCount) +
      chip('تسليمات غير مسعّرة', r.totals.deliveries, r.totals.deliveries ? 'var(--gold)' : 'var(--text-secondary)') +
      chip('إجمالي الناتج', fmt(r.totals.goods), 'var(--gold)') +
      chip('إجمالي الدفع', fmt(r.totals.pay), 'var(--green)') +
      chip('الرصيد', fmt(r.totals.balance, 'دج'), r.totals.balance < 0 ? 'var(--red)' : 'var(--red)');
  }
  document.getElementById('wp-preview-summary').innerHTML = summary;

  /* warnings grouped by code */
  const groups = {};
  r.warnings.forEach(w => { (groups[w.code] = groups[w.code] || []).push(w); });
  const codes = Object.keys(groups);
  document.getElementById('wp-preview-warnings').innerHTML = codes.length ? `
    <div style="border:1px solid rgba(245,197,24,0.35);background:rgba(245,197,24,0.07);border-radius:10px;padding:12px">
      <div style="font-weight:800;color:var(--gold);margin-bottom:8px">التحذيرات (${r.warnings.length})</div>
      ${codes.map(code => `
        <details style="margin-bottom:6px">
          <summary style="cursor:pointer;color:var(--text-secondary);font-size:0.85rem">
            ${WP_WARN_LABEL[code] || code} — ${groups[code].length}</summary>
          <div style="max-height:150px;overflow-y:auto;font-size:0.78rem;color:var(--text-secondary);padding:6px 10px 0">
            ${groups[code].slice(0, 60).map(w => `<div>• ${escapeHtmlSup(w.message)}</div>`).join('')}
            ${groups[code].length > 60 ? `<div style="opacity:.6">… و${groups[code].length - 60} أخرى</div>` : ''}
          </div>
        </details>`).join('')}
    </div>` : '';

  /* replace switch + plaka duplicate toggle */
  const existing = isR
    ? getRahaTx().length
    : isV
    ? getVetTx().length
    : isW
    ? getWorkerMonths().filter(m => {
        const t = getWorkerTypes().find(x => supNormAr(x.name) === supNormAr(p.typeName));
        return t && m.typeId === t.id;
      }).length
    : getPlakaLocations().length;
  document.getElementById('wp-preview-options').innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.2);border-radius:8px;padding:10px 12px;cursor:pointer">
      <input type="checkbox" id="wp-import-replace" ${existing ? 'checked' : ''} style="width:16px;height:16px" />
      <span style="font-size:0.86rem">استبدال بيانات ${isW ? 'هذا النوع' : 'هذا المورد'} بالكامل
        <span style="color:var(--text-secondary)">(موجود حالياً: ${existing})</span></span>
    </label>
    ${(p.mode === 'plaka' && r.excluded && r.excluded.length) ? `
      <label style="display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.2);border-radius:8px;padding:10px 12px;cursor:pointer;margin-top:8px">
        <input type="checkbox" id="plaka-include-dupes" style="width:16px;height:16px"
          onchange="reparsePlakaWithDupes(this.checked)" />
        <span style="font-size:0.86rem">إدراج اللوحتين المكرّرتين في Feuil1
          <span style="color:var(--red)">(يرفع الرصيد خطأً إلى ${fmt(r.totals.balance + r.excluded.reduce((s, e) => s + e.fileBalance, 0))})</span></span>
      </label>` : ''}`;

  /* detail table */
  let t;
  if (isR) {
    t = `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr><th>الحساب</th><th>النوع</th><th>الفترة</th><th>الكمية</th>
        <th>بضاعة/بيع</th><th>دفع/تحصيل</th><th>الباقي</th></tr></thead><tbody>
      ${r.accounts.map(acc => {
        const dated = acc.moves.filter(m => m.date);
        const period = dated.length ? `${dated[0].date} → ${dated[dated.length - 1].date}` : '—';
        const sale = acc.direction === 'sale';
        return `<tr>
          <td style="font-weight:700">${escapeHtmlSup(acc.name)}</td>
          <td style="color:${sale ? 'var(--green)' : '#f6ad55'}">${sale ? '📤 مبيعات' : '📥 مشتريات'}</td>
          <td style="white-space:nowrap">${period}</td>
          <td>${fmt(acc.calcQty)} ${escapeHtmlSup(acc.qtyUnit)}</td>
          <td style="color:#f6ad55">${fmt(acc.fileGoods)}</td>
          <td style="color:var(--green)">${fmt(acc.filePay)}</td>
          <td style="font-weight:800;color:${acc.fileRest === 0 ? 'var(--text-secondary)' : (sale ? 'var(--green)' : 'var(--red)')}">${fmt(acc.fileRest)}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } else if (isV) {
    t = `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr><th>الحساب</th><th>الفترة</th><th>شراء</th><th>دفع</th><th>الناتج</th><th>المدفوع</th><th>الباقي</th></tr></thead><tbody>
      ${r.accounts.map(acc => {
        const dated = acc.moves.filter(m => m.date);
        const period = dated.length ? `${dated[0].date} → ${dated[dated.length - 1].date}` : '—';
        return `<tr>
          <td style="font-weight:700">${escapeHtmlSup(acc.name)}</td>
          <td style="white-space:nowrap">${period}</td>
          <td>${acc.buys}</td><td>${acc.pays}</td>
          <td style="color:var(--gold)">${fmt(acc.fileGoods)}</td>
          <td style="color:var(--green)">${fmt(acc.filePay)}</td>
          <td style="font-weight:800;color:${acc.fileBalance < 0 ? 'var(--green)' : 'var(--red)'}">${fmt(acc.fileBalance)}</td>
        </tr>`;
      }).join('')}
      <tr style="background:rgba(255,255,255,0.05);font-weight:800">
        <td colspan="2">الإجمالي</td><td>${r.totals.buys}</td><td>${r.totals.pays}</td>
        <td>${fmt(r.totals.goods)}</td><td>${fmt(r.totals.pay)}</td><td>${fmt(r.totals.balance)}</td></tr>
      </tbody></table>`;
  } else if (isW) {
    const byAcc = {};
    r.kept.forEach(pl => {
      const k = wpAccountKey(pl.name, pl.assign);
      if (!byAcc[k]) byAcc[k] = { name: pl.name, assign: pl.assign, months: 0, wage: 0, draws: 0, bal: 0 };
      byAcc[k].months++;
      byAcc[k].rows = byAcc[k].rows || [];
      byAcc[k].rows.push(pl);
      byAcc[k].draws += pl.draws.reduce((s, d) => s + d.amount, 0);
      byAcc[k].bal += pl.balance;
    });
    Object.keys(byAcc).forEach(k => { byAcc[k].wage = wpMonthlyWage(byAcc[k].rows); });
    t = `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr><th>العامل</th><th>التكليف</th><th>أشهر</th><th>الأجرة الشهرية</th><th>السحب</th><th>مج. الباقي</th></tr></thead><tbody>
      ${Object.keys(byAcc).map(k => {
        const a = byAcc[k];
        return `<tr><td>${escapeHtmlSup(a.name)}</td><td>${escapeHtmlSup(a.assign || (a.isFeed ? 'العلف' : '—'))}</td>
          <td>${a.months}</td><td style="color:var(--green)">${fmt(a.wage)}</td>
          <td style="color:var(--gold)">${fmt(a.draws)}</td>
          <td style="font-weight:700;color:${a.bal < 0 ? 'var(--red)' : 'inherit'}">${fmt(a.bal)}</td></tr>`;
      }).join('')}</tbody></table>`;
  } else {
    t = `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr><th>الموقع</th><th>الورقة</th><th>الناتج</th><th>الدفع</th><th>الباقي</th><th>حركات</th></tr></thead><tbody>
      ${r.kept.map(loc => {
        const n = loc.moves.filter(m => m.goods !== 0).length + loc.moves.filter(m => m.pay !== 0).length;
        return `<tr><td>${escapeHtmlSup(loc.name)}</td><td>${escapeHtmlSup(loc.sheet)}</td>
          <td style="color:var(--gold)">${fmt(loc.fileGoods)}</td>
          <td style="color:var(--green)">${fmt(loc.filePay)}</td>
          <td style="font-weight:700;color:${loc.fileBalance < 0 ? 'var(--red)' : 'inherit'}">${fmt(loc.fileBalance)}</td>
          <td>${n}</td></tr>`;
      }).join('')}
      <tr style="background:rgba(255,255,255,0.05);font-weight:800">
        <td colspan="2">الإجمالي</td><td>${fmt(r.totals.goods)}</td><td>${fmt(r.totals.pay)}</td>
        <td>${fmt(r.totals.balance)}</td><td>${r.totals.txCount}</td></tr>
      </tbody></table>`;
  }
  document.getElementById('wp-preview-table').innerHTML = t;
  document.getElementById('modal-wp-preview').classList.add('open');
}

function reparsePlakaWithDupes(include) {
  const p = _wpPreview;
  if (!p || p.mode !== 'plaka' || !p.sheets) return;
  p.result = parsePlakaWorkbook(p.sheets, p.supplierName, { includeDuplicates: include });
  showWpPreview();
  const cb = document.getElementById('plaka-include-dupes');
  if (cb) cb.checked = include;
}

function confirmWpImport() {
  if (!_wpPreview) return;
  if (_wpPreview.mode === 'workers') commitWorkerImport();
  else if (_wpPreview.mode === 'vet') commitVetImport();
  else if (_wpPreview.mode === 'raha') commitRahaImport();
  else commitPlakaImport();
}

/* =====================================================================
   WORKERS — UI
   ===================================================================== */
function renderWorkerTypes() {
  const el = document.getElementById('global-workers-content');
  if (!el) return;
  const types = getWorkerTypes();
  const months = getWorkerMonths();

  if (!types.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px">
      لا يوجد أنواع عمال بعد.<br><br>
      💡 اضغط «📥 استيراد ملف نوع» واختر ملف Excel من مجلد «خدامة» —
      اسم الملف يصبح اسم النوع.</div>`;
    return;
  }

  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px">
    ${types.map(t => {
      const mine = months.filter(m => m.typeId === t.id);
      const accounts = new Set(mine.map(m => m.accountKey)).size;
      const monthsN = new Set(mine.map(m => m.monthKey)).size;
      const byAcc = {};
      mine.forEach(m => { (byAcc[m.accountKey] = byAcc[m.accountKey] || []).push(m); });
      const wage = Object.keys(byAcc).reduce((s, k) => s + wpMonthlyWage(byAcc[k]), 0);
      const draws = mine.reduce((s, m) => s + (Number(m.total) || 0), 0);
      return `<div onclick="openWorkerType('${t.id}')"
        style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(154,117,234,0.3);border-radius:12px;padding:14px">
        <div style="font-weight:800;font-size:1rem;margin-bottom:8px">${escapeHtmlSup(t.name)}</div>
        <div style="font-size:0.78rem;color:var(--text-secondary)">${accounts} عامل • ${monthsN} شهر</div>
        <div style="font-size:0.78rem;color:var(--green);margin-top:4px">أجرة شهرية: ${fmt(wage, 'دج')}</div>
        <div style="font-size:0.78rem;color:var(--gold)">إجمالي السحب: ${fmt(draws, 'دج')}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function openWorkerType(typeId) {
  _currentWorkerType = typeId;
  renderWorkerType();
  document.getElementById('modal-worker-type').classList.add('open');
}

function renderWorkerType() {
  const t = getWorkerTypes().find(x => x.id === _currentWorkerType);
  if (!t) return;
  document.getElementById('worker-type-title').textContent = '👷 عمال: ' + t.name;

  const months = getWorkerMonths().filter(m => m.typeId === t.id);
  const acc = {};
  months.forEach(m => {
    if (!acc[m.accountKey]) {
      acc[m.accountKey] = { key: m.accountKey, name: m.name, assign: m.assign, isFeed: m.isFeed,
                            months: 0, wage: 0, draws: 0, bal: 0, rows: [] };
    }
    const a = acc[m.accountKey];
    a.months++;
    a.rows.push(m);
    a.draws += Number(m.total) || 0;
    a.bal += Number(m.balance) || 0;
  });
  Object.keys(acc).forEach(k => {
    acc[k].wage = wpMonthlyWage(acc[k].rows);
    acc[k].lastMonth = acc[k].rows.reduce((mx, m) =>
      String(m.monthKey) > String(mx) ? m.monthKey : mx, '');
  });
  // "this month" = the newest month present in this type's data, so the
  // split stays correct whatever today's calendar date happens to be.
  const currentMonth = months.reduce((mx, m) => String(m.monthKey) > String(mx) ? m.monthKey : mx, '');
  const all = Object.keys(acc).map(k => acc[k])
    .sort((a, b) => String(b.lastMonth).localeCompare(String(a.lastMonth)) || a.name.localeCompare(b.name));
  const list = all.filter(a => a.lastMonth === currentMonth);
  const former = all.filter(a => a.lastMonth !== currentMonth);
  _workerTypeFormer = former;

  const rowHtml = a => `
          <tr style="cursor:pointer" onclick="openWorkerAccount('${a.key.replace(/'/g, "\\'")}')">
            <td style="font-weight:700">${escapeHtmlSup(a.name)}</td>
            <td>${escapeHtmlSup(a.assign || (a.isFeed ? 'العلف' : '—'))}</td>
            <td>${a.months}</td>
            <td style="color:var(--green)">${fmt(a.wage)}</td>
            <td style="color:var(--gold)">${fmt(a.draws)}</td>
            <td style="font-weight:800;color:${a.bal < 0 ? 'var(--red)' : 'inherit'}">${fmt(a.bal)}</td>
          </tr>`;

  document.getElementById('worker-type-content').innerHTML = !all.length
    ? '<div style="text-align:center;color:var(--text-secondary);padding:24px">لا توجد بيانات — استورد ملف هذا النوع.</div>'
    : `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
         <strong style="color:#b794f4">👷 عمال هذا الشهر (${wpMonthLabel(currentMonth)}) — ${list.length}</strong>
         ${former.length ? `<button class="btn btn-outline btn-sm" onclick="toggleFormerWorkers()">
           <span id="former-workers-label">👴 عمال قدامى (${former.length})</span></button>` : ''}
       </div>
       <table class="data-table" style="width:100%;font-size:0.84rem">
        <thead><tr><th>العامل</th><th>التكليف</th><th>أشهر</th><th>الأجرة الشهرية</th><th>إجمالي السحب</th><th>مجموع الباقي</th></tr></thead>
        <tbody>${list.length ? list.map(rowHtml).join('')
          : '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary)">لا أحد يعمل هذا الشهر</td></tr>'}</tbody></table>
      <div id="former-workers-section" style="display:none;margin-top:14px"></div>
      <div style="font-size:0.76rem;color:var(--text-secondary);margin-top:10px">
        ℹ️ الأشهر مستقلّة — لا يوجد ترحيل رصيد بين شهر وآخر. «مجموع الباقي» هنا حاصل جمع أرصدة الأشهر للاطّلاع فقط.
      </div>`;
}

function openWorkerAccount(accountKey) {
  _currentWorkerAccount = accountKey;
  renderWorkerAccount();
  document.getElementById('modal-worker-detail').classList.add('open');
}

function renderWorkerAccount() {
  const months = getWorkerMonths()
    .filter(m => m.typeId === _currentWorkerType && m.accountKey === _currentWorkerAccount)
    .sort((a, b) => String(b.monthKey).localeCompare(String(a.monthKey)) || (a.col - b.col));
  if (!months.length) return;

  const first = months[0];
  document.getElementById('worker-detail-title').textContent =
    '👤 ' + first.name + (first.assign ? ' — ' + first.assign : (first.isFeed ? ' — العلف' : ''));

  const draws = getWorkerDraws()
    .filter(d => d.typeId === _currentWorkerType && d.accountKey === _currentWorkerAccount);

  const totWage = months.reduce((s, m) => s + (Number(m.wage) || 0), 0);
  const totDraw = months.reduce((s, m) => s + (Number(m.total) || 0), 0);
  const totBal = months.reduce((s, m) => s + (Number(m.balance) || 0), 0);

  const box = (l, v, c) => `<div style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;text-align:center">
      <div style="font-size:0.72rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;color:${c}">${v}</div></div>`;
  document.getElementById('worker-detail-summary').innerHTML =
    box('عدد الأشهر', months.length, 'var(--text-primary)') +
    box('الأجرة الشهرية', fmt(wpMonthlyWage(months), 'دج'), 'var(--green)') +
    box('إجمالي السحب', fmt(totDraw, 'دج'), 'var(--gold)') +
    box('مجموع الباقي', fmt(totBal, 'دج'), totBal < 0 ? 'var(--red)' : 'var(--text-primary)');

  document.getElementById('worker-detail-content').innerHTML = months.map(m => {
    const rows = draws.filter(d => d.monthKey === m.monthKey && d.sheet === m.sheet && d.col === m.col)
      .sort((a, b) => a.seq - b.seq);
    return `<div style="margin-bottom:14px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;background:rgba(154,117,234,0.12);padding:8px 12px">
        <strong style="color:#b794f4">🗓️ ${wpMonthLabel(m.monthKey)}
          <span style="font-weight:400;font-size:0.78rem;color:var(--text-secondary)">(${escapeHtmlSup(m.sheet)})</span></strong>
        <span style="font-size:0.8rem;color:var(--text-secondary)">
          ${m.isFeed && m.qty != null ? `${fmt(m.qty)} × ${fmt(m.price)} = ` : ''}
          الأجرة: <b style="color:var(--green)">${m.wage == null ? '—' : fmt(m.wage)}</b> •
          المجموع: <b style="color:var(--gold)">${fmt(m.total)}</b> •
          الباقي: <b style="color:${m.balance < 0 ? 'var(--red)' : 'var(--text-primary)'}">${fmt(m.balance)}</b>
          ${m.edited ? ' <span style="color:var(--gold)">(معدّل)</span>' : (m.fileBalance === null ? ' <span style="color:var(--gold)">(محسوب)</span>' : '')}
        </span>
        <span style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" onclick="openEditWage('${m.id}')">✏️ الأجرة</button>
          <button class="btn btn-outline btn-sm" style="color:var(--gold)" onclick="openWorkerDrawModal('${m.id}')">+ سحب</button>
        </span>
      </div>
      <table class="data-table" style="width:100%;font-size:0.8rem">
        <thead><tr><th>التاريخ</th><th>السحب</th><th>ملاحظات</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(d => `<tr>
            <td style="white-space:nowrap">${d.date || '—'}</td>
            <td style="font-weight:700;color:var(--gold)">${fmt(d.amount)}</td>
            <td style="color:var(--text-secondary)">${escapeHtmlSup(d.note || '')}</td>
            <td><button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deleteWorkerDraw('${d.id}')">حذف</button></td>
          </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary)">لا سحوبات</td></tr>'}
        </tbody></table>
    </div>`;
  }).join('');
}

function deleteCurrentWorkerType() {
  const t = getWorkerTypes().find(x => x.id === _currentWorkerType);
  if (!t) return;
  if (!confirm(`حذف نوع العمال «${t.name}» وكل بياناته؟ لا يمكن التراجع.`)) return;
  setWorkerTypes(getWorkerTypes().filter(x => x.id !== t.id));
  setWorkerMonths(getWorkerMonths().filter(m => m.typeId !== t.id));
  setWorkerDraws(getWorkerDraws().filter(d => d.typeId !== t.id));
  document.getElementById('modal-worker-type').classList.remove('open');
  renderWorkerTypes();
  showToast('تم حذف النوع');
}

/* =====================================================================
   PLAKA — UI
   ===================================================================== */
function togglePlakaPanel() {
  const p = document.getElementById('plaka-panel');
  if (!p) return;
  if (p.style.display === 'none' || p.style.display === '') {
    p.style.display = 'block';
    renderPlakaPanel();
  } else {
    p.style.display = 'none';
  }
}

function renderPlakaPanel() {
  const el = document.getElementById('plaka-content');
  if (!el) return;
  const sups = getPlakaSuppliers();

  if (!sups.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px">
      لا يوجد موردون بعد.<br><br>
      💡 أضف مورداً من زر «+ إضافة مورد»، أو استورد ملف البلاكة من مجلد «Plaka».</div>`;
    return;
  }

  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
    ${sups.map(sup => {
      const locs = plakaLocationsOf(sup.id);
      const tot = locs.reduce((a, l) => {
        const t = plakaLocTotals(l);
        a.goods += t.goods; a.pay += t.pay; a.balance += t.balance;
        return a;
      }, { goods: 0, pay: 0, balance: 0 });
      return `<div onclick="openPlakaSupplier('${sup.id}')"
        style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(237,137,54,0.3);border-radius:12px;padding:14px">
        <div style="font-weight:800;font-size:1rem;margin-bottom:8px">${escapeHtmlSup(sup.name)}</div>
        <div style="font-size:1.05rem;font-weight:800;color:${tot.balance < 0 ? 'var(--green)' : 'var(--red)'}">
          ${fmt(tot.balance, 'دج')}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px">
          ${locs.length} موقع • ناتج ${fmt(tot.goods)} • دفع ${fmt(tot.pay)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function openPlakaLocation(locId) {
  const loc = getPlakaLocations().find(l => l.id === locId);
  if (!loc) return;
  const tx = getPlakaTx().filter(t => t.locationId === locId)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.seq - a.seq));

  const T = plakaLocTotals(loc);
  document.getElementById('plaka-location-title').innerHTML =
    '🧱 ' + escapeHtmlSup(loc.name) +
    ` <button class="btn btn-primary btn-sm" style="margin-inline-start:10px" onclick="openPlakaRecordModal('${loc.id}')">+ إضافة سجل</button>`;
  document.getElementById('plaka-location-summary').innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${['الناتج|' + fmt(T.goods) + '|var(--gold)',
         'الدفع|' + fmt(T.pay) + '|var(--green)',
         'الباقي|' + fmt(T.balance) + '|' + (T.balance < 0 ? 'var(--green)' : 'var(--red)')]
        .map(s => { const [l, v, c] = s.split('|');
          return `<div style="flex:1;min-width:110px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;text-align:center">
            <div style="font-size:0.72rem;color:var(--text-secondary)">${l}</div>
            <div style="font-weight:800;color:${c}">${v}</div></div>`; }).join('')}
    </div>`;

  document.getElementById('plaka-location-content').innerHTML = `
    <table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr><th>التاريخ</th><th>النوعية</th><th>الكمية</th><th>السعر</th><th>النوع</th><th>المبلغ</th><th>ملاحظات</th><th></th></tr></thead>
      <tbody>${tx.map(t => {
        const isPay = t.kind === 'payment';
        const isDel = t.kind === 'delivery';
        const color = isPay ? 'var(--green)' : (isDel ? 'var(--text-secondary)' : 'var(--gold)');
        return `<tr>
          <td style="white-space:nowrap">${t.date || '—'}</td>
          <td>${escapeHtmlSup(t.material || '')}</td>
          <td>${t.qty == null ? '' : fmt(t.qty)}</td>
          <td>${t.price == null ? '' : fmt(t.price)}</td>
          <td style="color:${color};font-weight:700">${isPay ? 'دفع' : (isDel ? 'تسليم غير مسعّر' : 'بضاعة')}</td>
          <td style="font-weight:700;color:${color}">${fmt(t.amount)}</td>
          <td style="color:var(--text-secondary)">${escapeHtmlSup(t.note || '')}</td>
          <td>${t.source === 'manual' ? `<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deletePlakaTx('${t.id}')">حذف</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  document.getElementById('modal-plaka-location').classList.add('open');
}

/* =====================================================================
   WIRING
   ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  on('worker-type-import-input', 'change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) handleWorkerTypeImport(f);
  });
  on('plaka-import-input', 'change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    // keep the sheets so the duplicate-panel toggle can re-parse instantly
    try {
      const sheets = await wpReadWorkbook(f);
      _wpPreview = { mode: 'plaka', sheets, fileName: f.name, supplierName: 'سليم',
                     result: parsePlakaWorkbook(sheets, 'سليم', {}) };
      if (!_wpPreview.result.ok) {
        showToast('لم يُعثر على أي لوحة في ملف البلاكة.', 'error');
        _wpPreview = null;
        return;
      }
      showWpPreview();
    } catch (err) {
      console.error('[plaka import]', err);
      showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
    }
  });
  on('btn-wp-confirm-import', 'click', confirmWpImport);
  on('btn-delete-worker-type', 'click', deleteCurrentWorkerType);
});

/* =====================================================================
   MODAL CLOSE BUTTONS — always at the TOP of the box, never the bottom.
   Applied centrally so every modal (including any added later) gets one.
   ===================================================================== */
function installModalCloseButtons(root) {
  (root || document).querySelectorAll('.modal-overlay').forEach(overlay => {
    const box = overlay.querySelector('.modal-box');
    if (!box || box.querySelector('.modal-close-x')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-close-x';
    btn.textContent = '✕';
    btn.title = 'إغلاق';
    btn.setAttribute('aria-label', 'إغلاق');
    btn.addEventListener('click', () => {
      overlay.classList.remove('open');
      if (overlay.style.display && overlay.style.display !== 'none') overlay.style.display = 'none';
    });
    box.insertBefore(btn, box.firstChild);

    // drop the redundant bottom "إغلاق" button (keep "إلغاء" — cancelling a
    // form is a different action from closing the window)
    box.querySelectorAll('.modal-actions button, .modal-close-row button').forEach(b => {
      if ((b.textContent || '').trim().replace(/^✕\s*/, '') === 'إغلاق') b.remove();
    });
    box.querySelectorAll('.modal-actions, .modal-close-row').forEach(row => {
      if (!row.children.length) row.remove();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  installModalCloseButtons();
  // modals created at runtime get one too
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('modal-overlay')) installModalCloseButtons(n.parentElement || document);
        else if (n.querySelector && n.querySelector('.modal-overlay')) installModalCloseButtons(n);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
});


/* =====================================================================
   MANUAL ENTRY — workers added/edited by hand, and بلاكة records.
   Manual rows live in the same collections as imported ones and are
   recomputed from their own withdrawals (the file's numbers no longer
   govern a month once it has been edited).
   ===================================================================== */
const WP_MANUAL_SHEET = 'يدوي';

function wpRecalcMonth(rec) {
  const draws = getWorkerDraws().filter(d =>
    d.typeId === rec.typeId && d.accountKey === rec.accountKey &&
    d.monthKey === rec.monthKey && d.sheet === rec.sheet && d.col === rec.col);
  rec.total = draws.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  rec.balance = (Number(rec.wage) || 0) - rec.total;
  return rec;
}

function wpSaveMonths(list) { setWorkerMonths(list); }

/* ---------- add a worker by hand ---------- */
function openAddWorkerModal() {
  if (!_currentWorkerType) { showToast('افتح نوع العمال أولاً', 'error'); return; }
  ['mw-name', 'mw-assign', 'mw-wage'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  const mo = document.getElementById('mw-month');
  if (mo) mo.value = todayStr().slice(0, 7);
  document.getElementById('modal-add-worker').classList.add('open');
  const n = document.getElementById('mw-name');
  if (n) setTimeout(() => n.focus(), 80);
}

function confirmAddWorker() {
  const name = (document.getElementById('mw-name').value || '').trim();
  if (!name) { showToast('أدخل اسم العامل', 'error'); return; }
  const assign = (document.getElementById('mw-assign').value || '').trim();
  const wage = Number(document.getElementById('mw-wage').value) || 0;
  const monthKey = document.getElementById('mw-month').value || todayStr().slice(0, 7);

  const accountKey = wpAccountKey(name, assign);
  const months = getWorkerMonths();
  if (months.some(m => m.typeId === _currentWorkerType && m.accountKey === accountKey &&
                       m.monthKey === monthKey)) {
    showToast('هذا العامل له سجل في هذا الشهر بالفعل', 'error');
    return;
  }
  months.push({
    id: 'wm_man_' + Date.now(), typeId: _currentWorkerType, source: 'manual',
    importKey: `${_currentWorkerType}|${accountKey}|${monthKey}|${WP_MANUAL_SHEET}|manual`,
    accountKey, name, assign, isFeed: false, qty: null, price: null,
    wage, monthKey, sheet: WP_MANUAL_SHEET, col: -1,
    fileTotal: null, fileBalance: null, total: 0, balance: wage
  });
  wpSaveMonths(months);
  document.getElementById('modal-add-worker').classList.remove('open');
  renderWorkerType();
  renderWorkerTypes();
  showToast('تمت إضافة العامل');
}

/* ---------- add a month to an existing worker ---------- */
function openAddWorkerMonthModal() {
  if (!_currentWorkerAccount) return;
  const mo = document.getElementById('mwm-month');
  if (mo) mo.value = todayStr().slice(0, 7);
  const existing = getWorkerMonths()
    .filter(m => m.typeId === _currentWorkerType && m.accountKey === _currentWorkerAccount);
  const w = document.getElementById('mwm-wage');
  if (w) w.value = wpMonthlyWage(existing) || '';
  document.getElementById('modal-add-worker-month').classList.add('open');
}

function confirmAddWorkerMonth() {
  const monthKey = document.getElementById('mwm-month').value;
  if (!monthKey) { showToast('اختر الشهر', 'error'); return; }
  const wage = Number(document.getElementById('mwm-wage').value) || 0;
  const months = getWorkerMonths();
  const sample = months.find(m => m.typeId === _currentWorkerType && m.accountKey === _currentWorkerAccount);
  if (!sample) return;
  if (months.some(m => m.typeId === _currentWorkerType && m.accountKey === _currentWorkerAccount &&
                       m.monthKey === monthKey && m.sheet === WP_MANUAL_SHEET)) {
    showToast('هذا الشهر مسجّل بالفعل', 'error');
    return;
  }
  months.push({
    id: 'wm_man_' + Date.now(), typeId: _currentWorkerType, source: 'manual',
    importKey: `${_currentWorkerType}|${_currentWorkerAccount}|${monthKey}|${WP_MANUAL_SHEET}|manual`,
    accountKey: _currentWorkerAccount, name: sample.name, assign: sample.assign,
    isFeed: false, qty: null, price: null,
    wage, monthKey, sheet: WP_MANUAL_SHEET, col: -1,
    fileTotal: null, fileBalance: null, total: 0, balance: wage
  });
  wpSaveMonths(months);
  document.getElementById('modal-add-worker-month').classList.remove('open');
  renderWorkerAccount();
  renderWorkerType();
  renderWorkerTypes();
  showToast('تمت إضافة الشهر');
}

/* ---------- edit a month's wage (imported months included) ---------- */
let _editWageTarget = null;
function openEditWage(monthId) {
  const rec = getWorkerMonths().find(m => m.id === monthId);
  if (!rec) return;
  _editWageTarget = monthId;
  document.getElementById('edit-wage-sub').textContent =
    `${rec.name} — ${wpMonthLabel(rec.monthKey)}`;
  document.getElementById('ew-wage').value = rec.wage == null ? '' : rec.wage;
  document.getElementById('modal-edit-wage').classList.add('open');
}

function confirmEditWage() {
  if (!_editWageTarget) return;
  const months = getWorkerMonths();
  const rec = months.find(m => m.id === _editWageTarget);
  if (!rec) return;
  const v = document.getElementById('ew-wage').value;
  rec.wage = v === '' ? null : Number(v) || 0;
  rec.edited = true;
  rec.fileBalance = null;          // the file no longer governs this month
  wpRecalcMonth(rec);
  wpSaveMonths(months);
  _editWageTarget = null;
  document.getElementById('modal-edit-wage').classList.remove('open');
  renderWorkerAccount();
  renderWorkerType();
  renderWorkerTypes();
  showToast('تم تعديل الأجرة');
}

/* ---------- add a withdrawal ---------- */
let _drawTarget = null;
function openWorkerDrawModal(monthId) {
  const rec = getWorkerMonths().find(m => m.id === monthId);
  if (!rec) return;
  _drawTarget = monthId;
  document.getElementById('worker-draw-sub').textContent =
    `${rec.name} — ${wpMonthLabel(rec.monthKey)}`;
  document.getElementById('wd-date').value = (rec.monthKey || todayStr().slice(0, 7)) + '-01';
  document.getElementById('wd-amount').value = '';
  document.getElementById('wd-note').value = '';
  document.getElementById('modal-worker-draw').classList.add('open');
}

function confirmWorkerDraw() {
  if (!_drawTarget) return;
  const months = getWorkerMonths();
  const rec = months.find(m => m.id === _drawTarget);
  if (!rec) return;
  const amount = Number(document.getElementById('wd-amount').value) || 0;
  if (!amount) { showToast('أدخل المبلغ', 'error'); return; }

  const draws = getWorkerDraws();
  const mine = draws.filter(d => d.typeId === rec.typeId && d.accountKey === rec.accountKey &&
                                 d.monthKey === rec.monthKey && d.sheet === rec.sheet && d.col === rec.col);
  const seq = mine.length ? Math.max(...mine.map(d => Number(d.seq) || 0)) + 1 : 0;
  draws.push({
    id: 'wd_man_' + Date.now(), typeId: rec.typeId, source: 'manual',
    importKey: `${rec.typeId}|${rec.accountKey}|${rec.monthKey}|${rec.sheet}|${rec.col}|man${seq}`,
    accountKey: rec.accountKey, monthKey: rec.monthKey, sheet: rec.sheet, col: rec.col,
    date: document.getElementById('wd-date').value || null,
    amount, note: (document.getElementById('wd-note').value || '').trim(),
    excelRow: null, seq
  });
  setWorkerDraws(draws);

  rec.edited = true;
  rec.fileTotal = null;
  rec.fileBalance = null;
  wpRecalcMonth(rec);
  wpSaveMonths(months);

  _drawTarget = null;
  document.getElementById('modal-worker-draw').classList.remove('open');
  renderWorkerAccount();
  renderWorkerType();
  renderWorkerTypes();
  showToast('تم تسجيل السحب');
}

function deleteWorkerDraw(drawId) {
  const draws = getWorkerDraws();
  const d = draws.find(x => x.id === drawId);
  if (!d) return;
  if (!confirm('حذف هذا السحب؟')) return;
  setWorkerDraws(draws.filter(x => x.id !== drawId));
  const months = getWorkerMonths();
  const rec = months.find(m => m.typeId === d.typeId && m.accountKey === d.accountKey &&
                               m.monthKey === d.monthKey && m.sheet === d.sheet && m.col === d.col);
  if (rec) { rec.edited = true; rec.fileTotal = null; rec.fileBalance = null; wpRecalcMonth(rec); }
  wpSaveMonths(months);
  renderWorkerAccount();
  renderWorkerType();
  renderWorkerTypes();
  showToast('تم الحذف');
}

/* =====================================================================
   PLAKA — suppliers, locations and manual records
   ===================================================================== */
function getPlakaSuppliers() {
  const list = supRead('plaka_suppliers');
  if (list.length) return list;
  // migrate the imported locations' supplier name into a real record
  const names = [...new Set(getPlakaLocations().map(l => l.supplier || 'سليم'))];
  if (!names.length) return [];
  const seeded = names.map((n, i) => ({ id: 'ps_seed_' + i, name: n }));
  supWrite('plaka_suppliers', seeded);
  return seeded;
}
function setPlakaSuppliers(a) { supWrite('plaka_suppliers', a); }

function plakaSupplierOf(loc) { return loc.supplierId || null; }

function plakaLocationsOf(supplierId) {
  const sup = getPlakaSuppliers().find(s => s.id === supplierId);
  if (!sup) return [];
  return getPlakaLocations().filter(l =>
    l.supplierId ? l.supplierId === supplierId : supNormAr(l.supplier || 'سليم') === supNormAr(sup.name));
}

/* imported totals come from the file; manual rows are added on top */
function plakaLocTotals(loc) {
  const tx = getPlakaTx().filter(t => t.locationId === loc.id && t.source === 'manual');
  const goods = (Number(loc.fileGoods) || 0) + tx.filter(t => t.kind === 'goods').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const pay = (Number(loc.filePay) || 0) + tx.filter(t => t.kind === 'payment').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  return { goods, pay, balance: goods - pay };
}

function plakaEnsureSupplier(name) {
  const list = getPlakaSuppliers();
  let sup = list.find(s => supNormAr(s.name) === supNormAr(name));
  if (!sup) { sup = { id: 'ps_' + Date.now(), name }; list.push(sup); setPlakaSuppliers(list); }
  return sup.id;
}

function openAddPlakaSupplierModal() {
  const e = document.getElementById('ps-name');
  if (e) e.value = '';
  document.getElementById('modal-add-plaka-supplier').classList.add('open');
  if (e) setTimeout(() => e.focus(), 80);
}

function confirmAddPlakaSupplier() {
  const name = (document.getElementById('ps-name').value || '').trim();
  if (!name) { showToast('أدخل اسم المورد', 'error'); return; }
  const list = getPlakaSuppliers();
  if (list.some(s => supNormAr(s.name) === supNormAr(name))) {
    showToast('يوجد مورد بنفس الاسم', 'error'); return;
  }
  list.push({ id: 'ps_' + Date.now(), name });
  setPlakaSuppliers(list);
  document.getElementById('modal-add-plaka-supplier').classList.remove('open');
  renderPlakaPanel();
  showToast('تمت إضافة المورد');
}

function openPlakaSupplier(supplierId) {
  _currentPlakaSupplier = supplierId;
  renderPlakaSupplier();
  document.getElementById('modal-plaka-supplier').classList.add('open');
}

function renderPlakaSupplier() {
  const sup = getPlakaSuppliers().find(s => s.id === _currentPlakaSupplier);
  if (!sup) return;
  document.getElementById('plaka-supplier-title').textContent = '🧱 ' + sup.name;

  const locs = plakaLocationsOf(sup.id);
  const tot = locs.reduce((a, l) => {
    const t = plakaLocTotals(l);
    a.goods += t.goods; a.pay += t.pay; a.balance += t.balance;
    return a;
  }, { goods: 0, pay: 0, balance: 0 });

  const box = (l, v, c) => `<div style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;text-align:center">
      <div style="font-size:0.72rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;color:${c}">${v}</div></div>`;
  document.getElementById('plaka-supplier-summary').innerHTML =
    `<div style="display:flex;gap:10px;flex-wrap:wrap">
      ${box('المواقع', locs.length, 'var(--text-primary)')}
      ${box('إجمالي الناتج', fmt(tot.goods, 'دج'), 'var(--gold)')}
      ${box('إجمالي الدفع', fmt(tot.pay, 'دج'), 'var(--green)')}
      ${box('الرصيد', fmt(tot.balance, 'دج'), tot.balance < 0 ? 'var(--green)' : 'var(--red)')}
    </div>`;

  document.getElementById('plaka-supplier-content').innerHTML = !locs.length
    ? '<div style="text-align:center;color:var(--text-secondary);padding:24px">لا توجد مواقع — أضف موقعاً أو استورد الملف.</div>'
    : `<table class="data-table" style="width:100%;font-size:0.84rem">
        <thead><tr><th>الموقع</th><th>الناتج</th><th>الدفع</th><th>الباقي</th><th>حركات</th><th></th></tr></thead>
        <tbody>${locs.map(l => {
          const t = plakaLocTotals(l);
          const n = getPlakaTx().filter(x => x.locationId === l.id && x.kind !== 'delivery').length;
          return `<tr>
            <td style="font-weight:700;cursor:pointer" onclick="openPlakaLocation('${l.id}')">${escapeHtmlSup(l.name)}</td>
            <td style="color:var(--gold)">${fmt(t.goods)}</td>
            <td style="color:var(--green)">${fmt(t.pay)}</td>
            <td style="font-weight:800;color:${t.balance < 0 ? 'var(--green)' : 'var(--red)'}">${fmt(t.balance)}</td>
            <td>${n}</td>
            <td><button class="btn btn-outline btn-sm" onclick="openPlakaRecordModal('${l.id}')">+ سجل</button></td>
          </tr>`;
        }).join('')}
        <tr style="background:rgba(255,255,255,0.05);font-weight:800">
          <td>الإجمالي</td><td>${fmt(tot.goods)}</td><td>${fmt(tot.pay)}</td><td>${fmt(tot.balance)}</td><td></td><td></td>
        </tr></tbody></table>`;
}

function deleteCurrentPlakaSupplier() {
  const sup = getPlakaSuppliers().find(s => s.id === _currentPlakaSupplier);
  if (!sup) return;
  if (!confirm(`حذف المورد «${sup.name}» وكل مواقعه وسجلاته؟`)) return;
  const locs = plakaLocationsOf(sup.id).map(l => l.id);
  setPlakaTx(getPlakaTx().filter(t => locs.indexOf(t.locationId) === -1));
  setPlakaLocations(getPlakaLocations().filter(l => locs.indexOf(l.id) === -1));
  setPlakaSuppliers(getPlakaSuppliers().filter(s => s.id !== sup.id));
  document.getElementById('modal-plaka-supplier').classList.remove('open');
  renderPlakaPanel();
  showToast('تم حذف المورد');
}

function openAddPlakaLocation() {
  if (!_currentPlakaSupplier) return;
  const e = document.getElementById('pl-name');
  if (e) e.value = '';
  document.getElementById('modal-add-plaka-location').classList.add('open');
  if (e) setTimeout(() => e.focus(), 80);
}

function confirmAddPlakaLocation() {
  const name = (document.getElementById('pl-name').value || '').trim();
  if (!name) { showToast('أدخل اسم الموقع', 'error'); return; }
  const sup = getPlakaSuppliers().find(s => s.id === _currentPlakaSupplier);
  if (!sup) return;
  const locs = getPlakaLocations();
  if (plakaLocationsOf(sup.id).some(l => supNormAr(l.name) === supNormAr(name))) {
    showToast('يوجد موقع بنفس الاسم', 'error'); return;
  }
  locs.push({
    id: 'pl_man_' + Date.now(), supplierId: sup.id, supplier: sup.name,
    name, sheet: WP_MANUAL_SHEET, source: 'manual',
    fileGoods: 0, filePay: 0, fileBalance: 0
  });
  setPlakaLocations(locs);
  document.getElementById('modal-add-plaka-location').classList.remove('open');
  renderPlakaSupplier();
  renderPlakaPanel();
  showToast('تمت إضافة الموقع');
}

let _plakaRecordTarget = null;
function openPlakaRecordModal(locId) {
  _plakaRecordTarget = locId;
  const loc = getPlakaLocations().find(l => l.id === locId);
  document.getElementById('plaka-record-sub').textContent = loc ? '📍 ' + loc.name : '';
  document.getElementById('pr-date').value = todayStr();
  ['pr-material', 'pr-qty', 'pr-price', 'pr-goods', 'pr-pay', 'pr-note']
    .forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  document.getElementById('modal-plaka-record').classList.add('open');
}

function updatePlakaRecordCalc() {
  const q = Number(document.getElementById('pr-qty').value) || 0;
  const p = Number(document.getElementById('pr-price').value) || 0;
  const g = document.getElementById('pr-goods');
  if (g && q && p) g.value = q * p;
}

function confirmPlakaRecord() {
  if (!_plakaRecordTarget) return;
  const loc = getPlakaLocations().find(l => l.id === _plakaRecordTarget);
  if (!loc) return;
  const goods = Number(document.getElementById('pr-goods').value) || 0;
  const pay = Number(document.getElementById('pr-pay').value) || 0;
  const qty = document.getElementById('pr-qty').value === '' ? null : Number(document.getElementById('pr-qty').value);
  const price = document.getElementById('pr-price').value === '' ? null : Number(document.getElementById('pr-price').value);
  if (!goods && !pay && qty === null) { showToast('أدخل الناتج أو الدفع', 'error'); return; }

  const tx = getPlakaTx();
  const mine = tx.filter(t => t.locationId === loc.id);
  const seq = mine.length ? Math.max(...mine.map(t => Number(t.seq) || 0)) + 1 : 0;
  const base = {
    locationId: loc.id, source: 'manual',
    date: document.getElementById('pr-date').value || todayStr(),
    material: (document.getElementById('pr-material').value || '').trim(),
    qty, price, note: (document.getElementById('pr-note').value || '').trim(),
    excelRow: null, seq
  };
  // E and F stay independent — one row may produce two movements
  if (goods) tx.push(Object.assign({}, base, { id: 'ptx_man_g' + Date.now(), kind: 'goods', amount: goods, importKey: `manual|${loc.id}|${seq}|goods` }));
  if (pay) tx.push(Object.assign({}, base, { id: 'ptx_man_p' + (Date.now() + 1), kind: 'payment', amount: pay, importKey: `manual|${loc.id}|${seq}|payment` }));
  if (!goods && !pay) tx.push(Object.assign({}, base, { id: 'ptx_man_d' + Date.now(), kind: 'delivery', amount: 0, importKey: `manual|${loc.id}|${seq}|delivery` }));
  setPlakaTx(tx);

  document.getElementById('modal-plaka-record').classList.remove('open');
  if (document.getElementById('modal-plaka-location').classList.contains('open')) openPlakaLocation(loc.id);
  renderPlakaSupplier();
  renderPlakaPanel();
  showToast('تم تسجيل الحركة');
}

function deletePlakaTx(txId) {
  const tx = getPlakaTx();
  const t = tx.find(x => x.id === txId);
  if (!t || t.source !== 'manual') { showToast('لا يمكن حذف حركة مستوردة', 'error'); return; }
  if (!confirm('حذف هذه الحركة؟')) return;
  setPlakaTx(tx.filter(x => x.id !== txId));
  openPlakaLocation(t.locationId);
  renderPlakaSupplier();
  renderPlakaPanel();
  showToast('تم الحذف');
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('btn-confirm-add-worker', 'click', confirmAddWorker);
  on('btn-confirm-add-worker-month', 'click', confirmAddWorkerMonth);
  on('btn-confirm-edit-wage', 'click', confirmEditWage);
  on('btn-confirm-worker-draw', 'click', confirmWorkerDraw);
  on('btn-confirm-add-plaka-supplier', 'click', confirmAddPlakaSupplier);
  on('btn-confirm-add-plaka-location', 'click', confirmAddPlakaLocation);
  on('btn-confirm-plaka-record', 'click', confirmPlakaRecord);
  on('btn-delete-plaka-supplier', 'click', deleteCurrentPlakaSupplier);
});


/* =====================================================================
   البيطرة — Vétérinaire ledger import
   ---------------------------------------------------------------------
   One sheet, two stacked blocks; each block is an independent account.
   Columns: A التاريخ | B النوعية | C الكمية | D السعر
            E الناتج  | F الدفع   | G ملاحظات (الجهة)
   The «المجموع» row is the reference: E = total goods, F = total paid,
   G = الباقي.
   ===================================================================== */
const VET_COL = { DATE: 0, ITEM: 1, QTY: 2, PRICE: 3, GOODS: 4, PAY: 5, NOTE: 6 };
const VET_EPS = 0.01;

// Amounts here are genuinely decimal (2208.65, 18400.17) and the file even
// carries float artefacts (6625.950000000001). Keep two decimals, never round
// to an integer.
function vetRound2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function vetEq(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < VET_EPS; }

function parseVetWorkbook(sheets, options) {
  options = options || {};
  const rows = (sheets[0] && sheets[0].rows) || [];
  const sheetName = (sheets[0] && sheets[0].name) || 'Feuil1';
  const warnings = [];
  const warn = (code, message, row) => warnings.push({ code, message, row: row == null ? null : row });

  /* --- locate the blocks by label, never by fixed row numbers --- */
  const headRows = [], totalRows = [];
  for (let r = 0; r < rows.length; r++) {
    const a = supNormAr(wpCell(rows, r, VET_COL.DATE));
    if (a === supNormAr('التاريخ')) headRows.push(r);
    else if (a === supNormAr('المجموع')) totalRows.push(r);
  }

  if (!headRows.length) {
    return {
      ok: false, accounts: [], warnings: [{ code: 'no-blocks',
        message: 'لم يُعثر على أي كتلة — لا يوجد صف رأس فيه «التاريخ» في العمود A.', row: null }],
      totals: { goods: 0, pay: 0, balance: 0, buys: 0, pays: 0, txCount: 0 }
    };
  }

  const accounts = [];
  headRows.forEach(h => {
    const close = totalRows.find(t => t > h);
    if (close === undefined) {
      warn('no-total', `صف الرأس ${h + 1}: لا يوجد صف «المجموع» بعده — الكتلة مُستبعَدة.`, h);
      return;
    }

    /* The account name sits on the row ABOVE the header, but not always in
       column A — the second block keeps it in D. Scan A..G. */
    let name = '', nameCell = '';
    for (let c = VET_COL.DATE; c <= VET_COL.NOTE; c++) {
      const v = supStr(wpCell(rows, h - 1, c));
      if (v) { name = v; nameCell = wpAddr(h - 1, c); break; }
    }
    if (!name) {
      name = 'حساب ' + (accounts.length + 1);
      warn('no-name', `الكتلة عند الصف ${h + 1}: لا يوجد اسم حساب في الصف الذي يسبق الرأس — سُمّي «${name}».`, h);
    }

    const moves = [];
    let lastDate = null;
    for (let r = h + 1; r < close; r++) {
      const rawDate = wpCell(rows, r, VET_COL.DATE);
      const item = supStr(wpCell(rows, r, VET_COL.ITEM));
      const qty = wpNum(wpCell(rows, r, VET_COL.QTY));
      const price = wpNum(wpCell(rows, r, VET_COL.PRICE));
      const goods = vetRound2(wpNum(wpCell(rows, r, VET_COL.GOODS)) || 0);
      const pay = vetRound2(wpNum(wpCell(rows, r, VET_COL.PAY)) || 0);
      const note = supStr(wpCell(rows, r, VET_COL.NOTE));

      // A blank date means "same receipt/day as the line above".
      let date = supParseDate(rawDate);
      if (date) lastDate = date;
      else date = lastDate;

      if (goods === 0 && pay === 0) continue;   // nothing to record

      if (goods && qty !== null && price !== null && !vetEq(qty * price, goods)) {
        warn('formula-mismatch',
          `صف ${r + 1}: ${fmt(qty)} × ${fmt(price)} لا يساوي الناتج ${fmt(goods)}.`, r);
      }
      if (goods && !item) {
        warn('no-item',
          `صف ${r + 1}: مبلغ ${fmt(goods)} بلا اسم دواء — استُورد كما هو (محتسَب في مجموع الملف).`, r);
      }
      if (note === '??????') {
        warn('unknown-site', `صف ${r + 1}: الجهة مجهولة («??????») — حُفظت كما هي.`, r);
      } else if (note && /^\d{4,6}$/.test(note)) {
        warn('note-is-serial',
          `صف ${r + 1}: خانة الملاحظات تحوي الرقم «${note}» (يبدو رقمًا تسلسليًا لتاريخ Excel) — حُفظ كنصّ.`, r);
      }
      if (!date) {
        warn('no-date', `صف ${r + 1}: بلا تاريخ ولا يوجد تاريخ سابق لوراثته.`, r);
      }

      moves.push({
        excelRow: r + 1, date, item, qty, price, goods, pay, note, seq: moves.length
      });
    }

    const fileGoods = vetRound2(wpNum(wpCell(rows, close, VET_COL.GOODS)) || 0);
    const filePay = vetRound2(wpNum(wpCell(rows, close, VET_COL.PAY)) || 0);
    const fileBalance = vetRound2(wpNum(wpCell(rows, close, VET_COL.NOTE)) || 0);

    const calcGoods = vetRound2(moves.reduce((s, m) => s + m.goods, 0));
    const calcPay = vetRound2(moves.reduce((s, m) => s + m.pay, 0));

    if (!vetEq(calcGoods, fileGoods)) {
      warn('goods-mismatch',
        `${name}: مجموع الناتج المحسوب ${fmt(calcGoods)} لا يطابق المكتوب ${fmt(fileGoods)}.`, close);
    }
    if (!vetEq(calcPay, filePay)) {
      warn('pay-mismatch',
        `${name}: مجموع الدفع المحسوب ${fmt(calcPay)} لا يطابق المكتوب ${fmt(filePay)}.`, close);
    }
    if (!vetEq(fileGoods - filePay, fileBalance)) {
      warn('balance-mismatch',
        `${name}: «الباقي» المكتوب ${fmt(fileBalance)} لا يساوي الناتج − الدفع (${fmt(fileGoods - filePay)}).`, close);
    }

    accounts.push({
      name, nameCell, sheet: sheetName, headRow: h + 1, totalRow: close + 1,
      moves, fileGoods, filePay, fileBalance, calcGoods, calcPay,
      buys: moves.filter(m => m.goods !== 0).length,
      pays: moves.filter(m => m.pay !== 0).length
    });
  });

  const totals = accounts.reduce((a, acc) => {
    a.goods += acc.fileGoods; a.pay += acc.filePay; a.balance += acc.fileBalance;
    a.buys += acc.buys; a.pays += acc.pays;
    return a;
  }, { goods: 0, pay: 0, balance: 0, buys: 0, pays: 0 });
  totals.goods = vetRound2(totals.goods);
  totals.pay = vetRound2(totals.pay);
  totals.balance = vetRound2(totals.balance);
  totals.txCount = totals.buys + totals.pays;

  return { ok: accounts.length > 0, accounts, warnings, totals };
}


/* =====================================================================
   البيطرة — storage, import and UI
   ===================================================================== */
const VET_COLL = { accounts: 'vet_accounts', tx: 'vet_tx' };

function getVetAccounts() { return supRead(VET_COLL.accounts); }
function setVetAccounts(a) { supWrite(VET_COLL.accounts, a); }
function getVetTx() { return supRead(VET_COLL.tx); }
function setVetTx(a) { supWrite(VET_COLL.tx, a); }

let _currentVetAccount = null;

function vetTxOf(accountId) {
  return getVetTx().filter(t => t.accountId === accountId);
}
function vetAccountTotals(acc) {
  const tx = vetTxOf(acc.id);
  const manual = tx.filter(t => t.source === 'manual');
  const goods = vetRound2((Number(acc.fileGoods) || 0) +
    manual.filter(t => t.kind === 'goods').reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const pay = vetRound2((Number(acc.filePay) || 0) +
    manual.filter(t => t.kind === 'payment').reduce((s, t) => s + (Number(t.amount) || 0), 0));
  return { goods, pay, balance: vetRound2(goods - pay) };
}

/* ---------------- import ---------------- */
async function handleVetImport(file) {
  if (!file) return;
  showToast('جاري تحليل ملف البيطرة...', 'info');
  try {
    const sheets = await wpReadWorkbook(file);          // always the first sheet
    const result = parseVetWorkbook(sheets);
    if (!result.ok) {
      showToast(result.warnings[0] ? result.warnings[0].message : 'الملف غير صالح', 'error');
      return;
    }
    _wpPreview = { mode: 'vet', result, fileName: file.name };
    showWpPreview();
  } catch (err) {
    console.error('[handleVetImport]', err);
    showToast('خطأ أثناء قراءة الملف: ' + err.message, 'error');
  }
}

function commitVetImport() {
  const p = _wpPreview;
  if (!p || p.mode !== 'vet') return;
  const r = p.result;
  const replace = !!(document.getElementById('wp-import-replace') || {}).checked;

  /* MANDATORY verification against the «المجموع» row — abort the whole
     import on any disagreement rather than saving silently. */
  const bad = [];
  r.accounts.forEach(acc => {
    if (!vetEq(acc.calcGoods, acc.fileGoods)) {
      bad.push(`${acc.name}: الناتج المحسوب ${fmt(acc.calcGoods)} ≠ المكتوب ${fmt(acc.fileGoods)} (فرق ${fmt(vetRound2(acc.calcGoods - acc.fileGoods))})`);
    }
    if (!vetEq(acc.calcPay, acc.filePay)) {
      bad.push(`${acc.name}: الدفع المحسوب ${fmt(acc.calcPay)} ≠ المكتوب ${fmt(acc.filePay)} (فرق ${fmt(vetRound2(acc.calcPay - acc.filePay))})`);
    }
    if (!vetEq(acc.fileGoods - acc.filePay, acc.fileBalance)) {
      bad.push(`${acc.name}: «الباقي» ${fmt(acc.fileBalance)} ≠ الناتج − الدفع ${fmt(vetRound2(acc.fileGoods - acc.filePay))}`);
    }
  });
  if (bad.length) {
    document.getElementById('modal-wp-preview').classList.remove('open');
    showToast('❌ أُلغي الاستيراد — ' + bad.length + ' اختلاف عن الملف. أوّلها: ' + bad[0], 'error');
    console.error('[vet import] verification failed', bad);
    return;
  }

  const allAcc = getVetAccounts();
  const allTx = getVetTx();
  const keptAcc = replace ? allAcc.filter(a => !r.accounts.some(x => supNormAr(x.name) === supNormAr(a.name))) : allAcc;
  const keptIds = new Set(keptAcc.map(a => a.id));
  const keptTx = allTx.filter(t => keptIds.has(t.accountId));
  const seen = new Set(keptTx.map(t => t.importKey));

  const newAcc = [], newTx = [];
  let skipped = 0;

  r.accounts.forEach(acc => {
    const id = 'vet_' + supNormAr(acc.name).replace(/\s+/g, '_');
    let record = keptAcc.find(a => a.id === id);
    if (!record) {
      record = {
        id, name: acc.name, nameCell: acc.nameCell, sheet: acc.sheet,
        headRow: acc.headRow, totalRow: acc.totalRow,
        fileGoods: acc.fileGoods, filePay: acc.filePay, fileBalance: acc.fileBalance,
        importedAt: new Date().toISOString()
      };
      newAcc.push(record);
    } else {
      record.fileGoods = acc.fileGoods;
      record.filePay = acc.filePay;
      record.fileBalance = acc.fileBalance;
    }

    acc.moves.forEach(m => {
      const push = (kind, amount) => {
        // unique per (account, sheet row, kind) — re-importing cannot double up
        const key = `${acc.name}|${m.excelRow}|${kind}`;
        if (seen.has(key)) { skipped++; return; }
        seen.add(key);
        newTx.push({
          id: 'vtx_' + newTx.length + '_' + Date.now().toString(36),
          accountId: id, importKey: key, source: 'import',
          kind, amount: vetRound2(amount),
          date: m.date, item: m.item, qty: m.qty, price: m.price,
          note: m.note, excelRow: m.excelRow, seq: m.seq
        });
      };
      // E and F are independent: one row can yield both a purchase and a payment
      if (m.goods !== 0) push('goods', m.goods);
      if (m.pay !== 0) push('payment', m.pay);
    });
  });

  setVetAccounts(keptAcc.concat(newAcc));
  setVetTx(keptTx.concat(newTx));

  _wpPreview = null;
  document.getElementById('modal-wp-preview').classList.remove('open');
  const inp = document.getElementById('vet-import-input');
  if (inp) inp.value = '';
  renderVetPanel();
  showToast(`✅ البيطرة: ${r.accounts.length} حساب و${newTx.length} حركة` +
    (skipped ? ` (تُخُطّي ${skipped} مكرّرة)` : '') +
    ` — الرصيد ${fmt(r.totals.balance, 'دج')}`);
}

/* ---------------- panel ---------------- */
function toggleVetPanel() {
  const p = document.getElementById('vet-panel');
  if (!p) return;
  if (p.style.display === 'none' || p.style.display === '') {
    p.style.display = 'block';
    renderVetPanel();
  } else {
    p.style.display = 'none';
  }
}

function renderVetPanel() {
  const el = document.getElementById('vet-content');
  if (!el) return;
  const accs = getVetAccounts();

  if (!accs.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px">
      لا توجد حسابات بيطرة بعد.<br><br>
      💡 اضغط «📥 استيراد ملف البيطرة» واختر الملف من مجلد «Vétérinaire».</div>`;
    return;
  }

  const tot = accs.reduce((a, acc) => {
    const t = vetAccountTotals(acc);
    a.goods += t.goods; a.pay += t.pay; a.balance += t.balance;
    return a;
  }, { goods: 0, pay: 0, balance: 0 });

  const box = (l, v, c) => `<div style="flex:1;min-width:130px;background:rgba(0,0,0,0.25);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:0.74rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;font-size:1.05rem;color:${c}">${v}</div></div>`;

  el.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${box('الحسابات', accs.length, 'var(--text-primary)')}
      ${box('إجمالي الناتج', fmt(vetRound2(tot.goods), 'دج'), 'var(--gold)')}
      ${box('إجمالي الدفع', fmt(vetRound2(tot.pay), 'دج'), 'var(--green)')}
      ${box('الرصيد المستحقّ', fmt(vetRound2(tot.balance), 'دج'), tot.balance < 0 ? 'var(--green)' : 'var(--red)')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
      ${accs.map(acc => {
        const t = vetAccountTotals(acc);
        const n = vetTxOf(acc.id).length;
        return `<div onclick="openVetAccount('${acc.id}')"
          style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(56,178,172,0.35);border-radius:12px;padding:14px">
          <div style="font-weight:800;font-size:1rem;margin-bottom:8px">${escapeHtmlSup(acc.name)}</div>
          <div style="font-size:1.05rem;font-weight:800;color:${t.balance < 0 ? 'var(--green)' : 'var(--red)'}">
            ${fmt(t.balance, 'دج')}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:6px">
            ${n} حركة • ناتج ${fmt(t.goods)} • دفع ${fmt(t.pay)}</div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ---------------- account ledger ---------------- */
function openVetAccount(accountId) {
  _currentVetAccount = accountId;
  renderVetAccount();
  document.getElementById('modal-vet-account').classList.add('open');
}

function renderVetAccount() {
  const acc = getVetAccounts().find(a => a.id === _currentVetAccount);
  if (!acc) return;
  const t = vetAccountTotals(acc);

  document.getElementById('vet-account-title').textContent = '🩺 ' + acc.name;

  const box = (l, v, c) => `<div style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;text-align:center">
      <div style="font-size:0.72rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;color:${c}">${v}</div></div>`;
  document.getElementById('vet-account-summary').innerHTML =
    `<div style="display:flex;gap:10px;flex-wrap:wrap">
      ${box('إجمالي الناتج', fmt(t.goods, 'دج'), 'var(--gold)')}
      ${box('إجمالي الدفع', fmt(t.pay, 'دج'), 'var(--green)')}
      ${box('الباقي', fmt(t.balance, 'دج'), t.balance < 0 ? 'var(--green)' : 'var(--red)')}
    </div>`;

  // chronological, grouped into receipts by shared date
  const tx = vetTxOf(acc.id).slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || (a.excelRow - b.excelRow) || (a.kind === b.kind ? 0 : a.kind === 'goods' ? -1 : 1));

  const groups = [];
  tx.forEach(row => {
    const last = groups[groups.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  });

  // The running balance is only meaningful chronologically, so compute it
  // forwards first, then present the receipts newest-first.
  let running = 0;
  groups.forEach(g => g.rows.forEach(row => {
    running = vetRound2(running + (row.kind === 'payment' ? -row.amount : row.amount));
    row._running = running;
  }));
  document.getElementById('vet-account-content').innerHTML = groups.slice().reverse().map(g => {
    const gGoods = vetRound2(g.rows.filter(r => r.kind === 'goods').reduce((s, r) => s + r.amount, 0));
    const gPay = vetRound2(g.rows.filter(r => r.kind === 'payment').reduce((s, r) => s + r.amount, 0));
    const body = g.rows.map(row => {
      const isPay = row.kind === 'payment';
      return `<tr>
        <td>${escapeHtmlSup(row.item || (isPay ? 'دفعة' : '—'))}</td>
        <td>${row.qty == null ? '' : fmt(row.qty)}</td>
        <td>${row.price == null ? '' : fmt(row.price)}</td>
        <td style="color:var(--gold);font-weight:700">${isPay ? '' : fmt(row.amount)}</td>
        <td style="color:var(--green);font-weight:700">${isPay ? fmt(row.amount) : ''}</td>
        <td style="color:var(--text-secondary)">${escapeHtmlSup(row.note || '')}</td>
        <td style="font-weight:700">${fmt(row._running)}</td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:12px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;background:rgba(56,178,172,0.12);padding:8px 12px">
        <strong style="color:#4fd1c5">🧾 ${g.date || 'بلا تاريخ'}</strong>
        <span style="font-size:0.8rem;color:var(--text-secondary)">
          ${g.rows.length} سطر
          ${gGoods ? ` • ناتج <b style="color:var(--gold)">${fmt(gGoods)}</b>` : ''}
          ${gPay ? ` • دفع <b style="color:var(--green)">${fmt(gPay)}</b>` : ''}
        </span>
      </div>
      <table class="data-table" style="width:100%;font-size:0.8rem">
        <thead><tr><th>الدواء</th><th>الكمية</th><th>السعر</th><th>الناتج</th><th>الدفع</th><th>الجهة</th><th>الرصيد</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }).join('');
}

/* ---------------- reports ---------------- */
function openVetReports() {
  const acc = getVetAccounts().find(a => a.id === _currentVetAccount);
  if (!acc) return;
  const tx = vetTxOf(acc.id).filter(t => t.kind === 'goods');

  // 1. consumption per drug
  const drugs = {};
  tx.forEach(t => {
    const key = supNormAr(t.item) || '—';
    if (!drugs[key]) drugs[key] = { label: t.item || '(بلا اسم)', qty: 0, amount: 0, times: 0, prices: new Set() };
    drugs[key].qty += Number(t.qty) || 0;
    drugs[key].amount = vetRound2(drugs[key].amount + t.amount);
    drugs[key].times++;
    if (t.price != null) drugs[key].prices.add(Number(t.price));
  });
  const drugRows = Object.keys(drugs).map(k => drugs[k]).sort((a, b) => b.amount - a.amount);

  // 2. spend per destination
  const sites = {};
  tx.forEach(t => {
    const key = (t.note || '').trim() || '(غير محدّدة)';
    if (!sites[key]) sites[key] = { label: key, amount: 0, times: 0 };
    sites[key].amount = vetRound2(sites[key].amount + t.amount);
    sites[key].times++;
  });
  const siteRows = Object.keys(sites).map(k => sites[k]).sort((a, b) => b.amount - a.amount);

  // 3. price history for drugs whose price moved
  const moved = drugRows.filter(d => d.prices.size > 1);

  const tbl = (head, rows) => `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  document.getElementById('vet-reports-title').textContent = '📊 تقارير: ' + acc.name;
  document.getElementById('vet-reports-content').innerHTML = `
    <h3 style="color:#4fd1c5;margin:0 0 8px">💊 استهلاك كل دواء (${drugRows.length})</h3>
    ${tbl(['الدواء', 'الكمية', 'مرّات', 'المبلغ', 'أسعار مختلفة'],
      drugRows.map(d => `<tr>
        <td>${escapeHtmlSup(d.label)}</td><td>${fmt(vetRound2(d.qty))}</td><td>${d.times}</td>
        <td style="color:var(--gold);font-weight:700">${fmt(d.amount)}</td>
        <td>${d.prices.size}</td></tr>`).join(''))}

    <h3 style="color:#4fd1c5;margin:18px 0 8px">🏠 مصروف البيطرة لكل جهة (${siteRows.length})</h3>
    ${tbl(['الجهة', 'مرّات', 'المبلغ'],
      siteRows.map(s => `<tr>
        <td>${escapeHtmlSup(s.label)}</td><td>${s.times}</td>
        <td style="color:var(--gold);font-weight:700">${fmt(s.amount)}</td></tr>`).join(''))}

    <h3 style="color:#4fd1c5;margin:18px 0 8px">📈 تطوّر أسعار الأدوية (${moved.length} دواء تغيّر سعره)</h3>
    ${moved.length ? tbl(['الدواء', 'الأسعار عبر الزمن'],
      moved.map(d => `<tr><td>${escapeHtmlSup(d.label)}</td>
        <td>${[...d.prices].sort((a, b) => a - b).map(p => fmt(p)).join(' ← ')}</td></tr>`).join(''))
      : '<div style="color:var(--text-secondary);padding:10px">لا يوجد دواء تغيّر سعره.</div>'}`;
  document.getElementById('modal-vet-reports').classList.add('open');
}

function deleteCurrentVetAccount() {
  const acc = getVetAccounts().find(a => a.id === _currentVetAccount);
  if (!acc) return;
  if (!confirm(`حذف حساب البيطرة «${acc.name}» وكل حركاته؟`)) return;
  setVetTx(getVetTx().filter(t => t.accountId !== acc.id));
  setVetAccounts(getVetAccounts().filter(a => a.id !== acc.id));
  _currentVetAccount = null;
  document.getElementById('modal-vet-account').classList.remove('open');
  renderVetPanel();
  showToast('تم حذف الحساب');
}

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('vet-import-input');
  if (inp) inp.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) handleVetImport(f);
  });
  const del = document.getElementById('btn-delete-vet-account');
  if (del) del.addEventListener('click', deleteCurrentVetAccount);
});

/* =====================================================================
   FORMER WORKERS — anyone with no record in the type's newest month.
   Hidden by default so the type screen shows only who is working now.
   ===================================================================== */
let _workerTypeFormer = [];

function toggleFormerWorkers() {
  const box = document.getElementById('former-workers-section');
  const label = document.getElementById('former-workers-label');
  if (!box) return;

  const showing = box.style.display !== 'none' && box.style.display !== '';
  if (showing) {
    box.style.display = 'none';
    if (label) label.textContent = `👴 عمال قدامى (${_workerTypeFormer.length})`;
    return;
  }

  box.style.display = 'block';
  if (label) label.textContent = '🔼 إخفاء العمال القدامى';
  box.innerHTML = `
    <div style="font-weight:800;color:var(--text-secondary);margin-bottom:8px">
      👴 عمال قدامى (${_workerTypeFormer.length}) — اضغط على البطاقة لعرض كل سجلاته
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
      ${_workerTypeFormer.map(a => `
        <div onclick="openWorkerAccount('${a.key.replace(/'/g, "\'")}')"
          style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid rgba(154,117,234,0.25);border-radius:10px;padding:12px">
          <div style="font-weight:800;margin-bottom:4px">${escapeHtmlSup(a.name)}</div>
          <div style="font-size:0.74rem;color:var(--text-secondary)">
            ${escapeHtmlSup(a.assign || (a.isFeed ? 'العلف' : '—'))}</div>
          <div style="font-size:0.74rem;color:var(--text-secondary);margin-top:6px">
            آخر شهر: ${wpMonthLabel(a.lastMonth)} • ${a.months} شهر</div>
          <div style="font-size:0.78rem;color:var(--gold);margin-top:4px">سحب: ${fmt(a.draws)}</div>
          <div style="font-size:0.78rem;font-weight:700;color:${a.bal < 0 ? 'var(--red)' : 'inherit'}">
            الباقي: ${fmt(a.bal)}</div>
        </div>`).join('')}
    </div>`;
}


/* =====================================================================
   الرحى — three workbooks, three DIFFERENT column orders.
   One schema per file; the schema is detected from the header labels so a
   renamed file still parses correctly.

     الريمي - زهير : التاريخ | الدفع   | المبلغ  | السعر | الطوناج | المنتوج
     الصاك         : التاريخ | الكمية  | السعر   | الناتج | الدفع   | ملاحظات
     النخالة       : التاريخ | الكمية  | السعر   | الناتج | الدفع   | خدامة | ملاحظات
   ===================================================================== */
const RAHA_EPS = 0.01;
function rahaR2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function rahaEq(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < RAHA_EPS; }

const RAHA_SCHEMAS = {
  rimi: {
    id: 'rimi', label: 'الريمي - زهير', direction: 'purchase',
    qtyLabel: 'الطوناج', qtyUnit: 'طن', itemLabel: 'المنتوج',
    cols: { date: 0, pay: 1, goods: 2, price: 3, qty: 4, item: 5 }
  },
  sak: {
    id: 'sak', label: 'الصاك', direction: 'purchase',
    qtyLabel: 'الكمية', qtyUnit: 'وحدة', itemLabel: 'الصنف',
    cols: { date: 0, qty: 1, price: 2, goods: 3, pay: 4, note: 5 }
  },
  nokhala: {
    id: 'nokhala', label: 'النخالة', direction: 'sale',
    qtyLabel: 'الكمية', qtyUnit: 'قنطار', itemLabel: 'الزبون',
    cols: { date: 0, qty: 1, price: 2, goods: 3, pay: 4, labour: 5, note: 6 }
  }
};

/* Pick the schema from the header row, not from the file name. */
function rahaDetectSchema(rows, headRow, fileName) {
  const h = c => supNormAr(wpCell(rows, headRow, c));
  if (h(1) === supNormAr('الدفع')) return RAHA_SCHEMAS.rimi;
  if (h(5) === supNormAr('خدامة')) return RAHA_SCHEMAS.nokhala;
  if (h(3) === supNormAr('الناتج')) return RAHA_SCHEMAS.sak;
  const n = supNormAr(fileName || '');
  if (n.indexOf(supNormAr('نخالة')) >= 0) return RAHA_SCHEMAS.nokhala;
  if (n.indexOf(supNormAr('صاك')) >= 0) return RAHA_SCHEMAS.sak;
  return RAHA_SCHEMAS.rimi;
}

function parseRahaWorkbook(sheets, fileName) {
  const rows = (sheets[0] && sheets[0].rows) || [];
  const warnings = [];
  const warn = (code, message, row) => warnings.push({ code, message, row: row == null ? null : row });
  const baseName = String(fileName || '').replace(/\.(xlsx|xlsm|xls|csv)$/i, '').trim();

  /* header / closing rows are found by TEXT, never by row number. The words
     «المجموع» and «الباقي» can sit in any column (rimi keeps them in F and D). */
  let headRow = -1;
  for (let r = 0; r < rows.length && headRow === -1; r++) {
    if (supNormAr(wpCell(rows, r, 0)) === supNormAr('التاريخ')) headRow = r;
  }
  if (headRow === -1) {
    return { ok: false, warnings: [{ code: 'no-header',
      message: 'لم يُعثر على صف الرأس («التاريخ» في العمود A).', row: null }] };
  }

  const rowHasWord = (r, words) => {
    for (let c = 0; c < 12; c++) {
      const v = supNormAr(wpCell(rows, r, c));
      if (v && words.some(w => v === supNormAr(w))) return true;
    }
    return false;
  };
  let closeRow = -1, restRow = -1;
  for (let r = headRow + 1; r < rows.length; r++) {
    if (closeRow === -1 && rowHasWord(r, ['المجموع'])) closeRow = r;
    if (restRow === -1 && rowHasWord(r, ['الباقي', 'الفارق'])) restRow = r;
  }
  if (closeRow === -1) closeRow = rows.length;

  const schema = rahaDetectSchema(rows, headRow, baseName);
  const C = schema.cols;

  /* account name: first non-empty cell above the header (rimi keeps it in C2),
     otherwise the file name. */
  let accountName = '';
  for (let r = headRow - 1; r >= 0 && !accountName; r--) {
    for (let c = 0; c < 12; c++) {
      const v = supStr(wpCell(rows, r, c));
      if (v) { accountName = v; break; }
    }
  }
  if (!accountName) accountName = baseName || schema.label;

  const moves = [];
  let lastDate = null;
  let computedCells = 0;

  for (let r = headRow + 1; r < closeRow; r++) {
    const rawDate = wpCell(rows, r, C.date);
    if (['المجموع', 'الباقي', 'الفارق'].some(w => supNormAr(rawDate) === supNormAr(w))) continue;

    const qty = C.qty != null ? wpNum(wpCell(rows, r, C.qty)) : null;
    const price = C.price != null ? wpNum(wpCell(rows, r, C.price)) : null;
    let goods = C.goods != null ? wpNum(wpCell(rows, r, C.goods)) : null;
    const pay = rahaR2(C.pay != null ? (wpNum(wpCell(rows, r, C.pay)) || 0) : 0);
    const labour = rahaR2(C.labour != null ? (wpNum(wpCell(rows, r, C.labour)) || 0) : 0);
    const note = C.note != null ? supStr(wpCell(rows, r, C.note)) : '';
    let item = C.item != null ? supStr(wpCell(rows, r, C.item)) : '';

    /* النخالة is saved without recalculation: its «الناتج» cells hold formulas
       with NO cached value and read as blank. Compute rather than import zeros. */
    let computed = false;
    if ((goods === null || goods === undefined) && qty !== null && price !== null) {
      goods = qty * price;
      computed = true;
      computedCells++;
    }
    goods = rahaR2(goods || 0);

    let date = supParseDate(rawDate);
    if (date) lastDate = date;
    else date = lastDate;

    if (!goods && !pay && !labour) continue;      // empty / reserved row

    if (rawDate === null && (goods || pay)) {
      warn('inherit-date', `صف ${r + 1}: بلا تاريخ — ورث ${date || '—'} من السطر الأعلى.`, r);
    }
    if (goods && qty !== null && price !== null && !rahaEq(qty * price, goods)) {
      warn('formula-mismatch',
        `صف ${r + 1}: ${fmt(qty)} × ${fmt(price)} لا يساوي ${fmt(goods)}.`, r);
    }

    // sak: an opening balance carried over, not a purchase
    let kind = 'goods';
    if (schema.id === 'sak' && goods && qty === null && price === null) {
      kind = 'opening';
      warn('opening-balance',
        `صف ${r + 1}: مبلغ ${fmt(goods)} بلا كمية ولا سعر («${note || 'قديم'}») — رصيد افتتاحي مُرحَّل، ليس شراءً.`, r);
    }
    // sak: كبة خيط is only identifiable by its price when the note is missing
    if (schema.id === 'sak') {
      if (note) item = note;
      else if (price === 2000) {
        item = 'كبة خيط';
        warn('inferred-item', `صف ${r + 1}: «كبة خيط» بلا ملاحظة — استُنتج من السعر 2000.`, r);
      } else if (kind === 'goods') {
        item = 'صاكة';
      }
    }
    if (schema.id === 'nokhala') item = note;      // the note holds the customer

    // a date far from its neighbours is an entry slip worth flagging
    if (date && moves.length) {
      const prev = moves[moves.length - 1].date;
      if (prev && date < prev) {
        warn('date-out-of-order',
          `صف ${r + 1}: التاريخ ${date} أقدم من السطر السابق (${prev}) — تحقّق منه.`, r);
      }
    }

    moves.push({
      excelRow: r + 1, date, qty, price, goods, pay, labour, note, item,
      kind, computed, seq: moves.length
    });
  }

  /* --- totals: read them, and compute when the cells are empty formulas --- */
  const calcGoods = rahaR2(moves.reduce((s, m) => s + m.goods, 0));
  const calcPay = rahaR2(moves.reduce((s, m) => s + m.pay, 0));
  const calcLabour = rahaR2(moves.reduce((s, m) => s + m.labour, 0));
  const calcQty = rahaR2(moves.reduce((s, m) => s + (m.qty || 0), 0));

  const readTotal = col => (col == null || closeRow >= rows.length)
    ? null : wpNum(wpCell(rows, closeRow, col));
  let fileGoods = readTotal(C.goods);
  let filePay = readTotal(C.pay);
  let totalsComputed = false;
  if (fileGoods === null) { fileGoods = calcGoods; totalsComputed = true; }
  if (filePay === null) { filePay = calcPay; totalsComputed = true; }
  fileGoods = rahaR2(fileGoods);
  filePay = rahaR2(filePay);

  /* «الباقي»/«الفارق» lives in an arbitrary column, sometimes on its own row
     (rimi C71) and sometimes on the totals row (sak F62); the label row can
     even carry a leftover 0. Take the candidate that equals goods − pay. */
  const expectedRest = rahaR2(fileGoods - filePay);
  const candidates = [];
  [restRow, closeRow].forEach(rr => {
    if (rr < 0 || rr >= rows.length) return;
    for (let c = 0; c < 12; c++) {
      if (rr === closeRow && (c === C.goods || c === C.pay)) continue;
      const v = wpNum(wpCell(rows, rr, c));
      if (v !== null) candidates.push(v);
    }
  });
  let fileRest = candidates.find(v => rahaEq(v, expectedRest));
  if (fileRest === undefined) {
    if (candidates.length) {
      fileRest = candidates[0];
      warn('rest-mismatch',
        `قيمة «الباقي» في الملف ${fmt(fileRest)} لا تساوي الناتج − الدفع (${fmt(expectedRest)}).`, restRow);
    } else {
      fileRest = expectedRest;
      totalsComputed = true;
    }
  }
  fileRest = rahaR2(fileRest);

  if (computedCells) {
    warn('computed-values',
      `${computedCells} خلية «ناتج» كانت صيغة بلا قيمة محفوظة — حُسبت من الكمية × السعر.`, null);
  }
  if (totalsComputed) {
    warn('totals-computed', 'صف «المجموع» يحوي صيغًا بلا قيم محفوظة — حُسبت الإجماليات من الأسطر.', closeRow);
  }
  if (!rahaEq(calcGoods, fileGoods)) {
    warn('goods-mismatch',
      `مجموع الناتج المحسوب ${fmt(calcGoods)} لا يطابق المكتوب ${fmt(fileGoods)}.`, closeRow);
  }
  if (!rahaEq(calcPay, filePay)) {
    warn('pay-mismatch',
      `مجموع الدفع المحسوب ${fmt(calcPay)} لا يطابق المكتوب ${fmt(filePay)}.`, closeRow);
  }

  return {
    ok: true,
    schema: schema.id, direction: schema.direction,
    qtyLabel: schema.qtyLabel, qtyUnit: schema.qtyUnit, itemLabel: schema.itemLabel,
    name: accountName, fileName: baseName,
    headRow: headRow + 1, closeRow: closeRow + 1, restRow: restRow + 1,
    moves, warnings,
    fileGoods, filePay, fileRest,
    calcGoods, calcPay, calcLabour, calcQty,
    buys: moves.filter(m => m.goods).length,
    pays: moves.filter(m => m.pay).length,
    labourRows: moves.filter(m => m.labour).length
  };
}


/* =====================================================================
   الرحى — storage, import and UI
   ===================================================================== */
const RAHA_COLL = { accounts: 'raha_accounts', tx: 'raha_tx' };

function getRahaAccounts() { return supRead(RAHA_COLL.accounts); }
function setRahaAccounts(a) { supWrite(RAHA_COLL.accounts, a); }
function getRahaTx() { return supRead(RAHA_COLL.tx); }
function setRahaTx(a) { supWrite(RAHA_COLL.tx, a); }

let _currentRahaAccount = null;

function rahaTxOf(id) { return getRahaTx().filter(t => t.accountId === id); }

function rahaAccountTotals(acc) {
  const manual = rahaTxOf(acc.id).filter(t => t.source === 'manual');
  const goods = rahaR2((Number(acc.fileGoods) || 0) +
    manual.filter(t => t.kind !== 'payment').reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const pay = rahaR2((Number(acc.filePay) || 0) +
    manual.filter(t => t.kind === 'payment').reduce((s, t) => s + (Number(t.amount) || 0), 0));
  return { goods, pay, balance: rahaR2(goods - pay) };
}

/* ---------------- import (one file = one account) ---------------- */
async function handleRahaImport(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  showToast(`جاري تحليل ${files.length} ملف من الرحى...`, 'info');
  try {
    const accounts = [], warnings = [];
    for (const file of files) {
      const sheets = await wpReadWorkbook(file);
      const res = parseRahaWorkbook(sheets, file.name);
      if (!res.ok) {
        warnings.push({ code: 'bad-file', message: `${file.name}: ${res.warnings[0].message}`, row: null });
        continue;
      }
      res.warnings.forEach(w => warnings.push({ ...w, message: `${res.name} — ${w.message}` }));
      accounts.push(res);
    }
    if (!accounts.length) {
      showToast(warnings.length ? warnings[0].message : 'لم يُقرأ أي ملف صالح', 'error');
      return;
    }
    const totals = accounts.reduce((a, x) => {
      // a sale account's balance is owed TO us, so keep the two apart
      if (x.direction === 'sale') { a.saleGoods += x.fileGoods; a.salePay += x.filePay; a.saleRest += x.fileRest; }
      else { a.goods += x.fileGoods; a.pay += x.filePay; a.rest += x.fileRest; }
      a.buys += x.buys; a.pays += x.pays; a.labour += x.calcLabour;
      return a;
    }, { goods: 0, pay: 0, rest: 0, saleGoods: 0, salePay: 0, saleRest: 0, buys: 0, pays: 0, labour: 0 });
    ['goods', 'pay', 'rest', 'saleGoods', 'salePay', 'saleRest', 'labour']
      .forEach(k => totals[k] = rahaR2(totals[k]));

    _wpPreview = { mode: 'raha', result: { accounts, warnings, totals },
                   fileName: files.map(f => f.name).join('، ') };
    showWpPreview();
  } catch (err) {
    console.error('[handleRahaImport]', err);
    showToast('خطأ أثناء قراءة الملفات: ' + err.message, 'error');
  }
}

function commitRahaImport() {
  const p = _wpPreview;
  if (!p || p.mode !== 'raha') return;
  const r = p.result;
  const replace = !!(document.getElementById('wp-import-replace') || {}).checked;

  /* MANDATORY verification against each file's own totals row. */
  const bad = [];
  r.accounts.forEach(acc => {
    if (!rahaEq(acc.calcGoods, acc.fileGoods)) {
      bad.push(`${acc.name}: الناتج المحسوب ${fmt(acc.calcGoods)} ≠ ${fmt(acc.fileGoods)} (فرق ${fmt(rahaR2(acc.calcGoods - acc.fileGoods))})`);
    }
    if (!rahaEq(acc.calcPay, acc.filePay)) {
      bad.push(`${acc.name}: الدفع المحسوب ${fmt(acc.calcPay)} ≠ ${fmt(acc.filePay)} (فرق ${fmt(rahaR2(acc.calcPay - acc.filePay))})`);
    }
    if (!rahaEq(acc.fileGoods - acc.filePay, acc.fileRest)) {
      bad.push(`${acc.name}: «الباقي» ${fmt(acc.fileRest)} ≠ الناتج − الدفع ${fmt(rahaR2(acc.fileGoods - acc.filePay))}`);
    }
    // النخالة must settle to exactly zero — that is the file's own invariant
    if (acc.schema === 'nokhala' && !rahaEq(acc.fileRest, 0)) {
      bad.push(`${acc.name}: الفارق ${fmt(acc.fileRest)} وكان يجب أن يكون صفراً — الحساب غير مصفّى.`);
    }
  });
  if (bad.length) {
    document.getElementById('modal-wp-preview').classList.remove('open');
    showToast('❌ أُلغي الاستيراد — ' + bad.length + ' اختلاف عن الملفات. أوّلها: ' + bad[0], 'error');
    console.error('[raha import] verification failed', bad);
    return;
  }

  const allAcc = getRahaAccounts();
  const allTx = getRahaTx();
  const incoming = new Set(r.accounts.map(a => supNormAr(a.name)));
  const keptAcc = replace ? allAcc.filter(a => !incoming.has(supNormAr(a.name))) : allAcc;
  const keptIds = new Set(keptAcc.map(a => a.id));
  const keptTx = allTx.filter(t => keptIds.has(t.accountId));
  const seen = new Set(keptTx.map(t => t.importKey));

  const newAcc = [], newTx = [];
  let skipped = 0;

  r.accounts.forEach(acc => {
    const id = 'raha_' + acc.schema;
    let record = keptAcc.find(x => x.id === id);
    const shape = {
      id, name: acc.name, schema: acc.schema, direction: acc.direction,
      qtyLabel: acc.qtyLabel, qtyUnit: acc.qtyUnit, itemLabel: acc.itemLabel,
      fileName: acc.fileName,
      fileGoods: acc.fileGoods, filePay: acc.filePay, fileRest: acc.fileRest,
      totalQty: acc.calcQty, totalLabour: acc.calcLabour,
      importedAt: new Date().toISOString()
    };
    if (record) Object.assign(record, shape);
    else newAcc.push(shape);

    acc.moves.forEach(m => {
      const push = (kind, amount) => {
        const key = `${acc.name}|${m.excelRow}|${kind}`;
        if (seen.has(key)) { skipped++; return; }
        seen.add(key);
        newTx.push({
          id: 'rtx_' + newTx.length + '_' + Date.now().toString(36),
          accountId: id, importKey: key, source: 'import',
          kind, amount: rahaR2(amount),
          date: m.date, qty: m.qty, price: m.price,
          item: m.item, note: m.note, labour: m.labour,
          computed: !!m.computed, excelRow: m.excelRow, seq: m.seq
        });
      };
      // the two money columns are independent — a row can yield both
      if (m.goods) push(m.kind === 'opening' ? 'opening' : 'goods', m.goods);
      if (m.pay) push('payment', m.pay);
      // labour is a side cost, outside the balance, but must stay visible
      if (!m.goods && !m.pay && m.labour) push('labour-only', 0);
    });
  });

  setRahaAccounts(keptAcc.concat(newAcc));
  setRahaTx(keptTx.concat(newTx));

  _wpPreview = null;
  document.getElementById('modal-wp-preview').classList.remove('open');
  const inp = document.getElementById('raha-import-input');
  if (inp) inp.value = '';
  renderRahaPanel();
  showToast(`✅ الرحى: ${r.accounts.length} حساب و${newTx.length} حركة` +
    (skipped ? ` (تُخُطّي ${skipped} مكرّرة)` : ''));
}

/* ---------------- panel ---------------- */
function toggleRahaPanel() {
  const p = document.getElementById('raha-panel');
  if (!p) return;
  if (p.style.display === 'none' || p.style.display === '') {
    p.style.display = 'block';
    renderRahaPanel();
  } else {
    p.style.display = 'none';
  }
}

function renderRahaPanel() {
  const el = document.getElementById('raha-content');
  if (!el) return;
  const accs = getRahaAccounts();

  if (!accs.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px">
      لا توجد حسابات رحى بعد.<br><br>
      💡 اضغط «📥 استيراد ملفات الرحى» واختر الملفات الثلاثة من مجلد «الرحى»
      (يمكن اختيارها دفعة واحدة) — اسم الملف يصبح اسم الحساب.</div>`;
    return;
  }

  const buy = accs.filter(a => a.direction !== 'sale');
  const sell = accs.filter(a => a.direction === 'sale');
  const owed = rahaR2(buy.reduce((s, a) => s + rahaAccountTotals(a).balance, 0));
  const due = rahaR2(sell.reduce((s, a) => s + rahaAccountTotals(a).balance, 0));
  const labour = rahaR2(accs.reduce((s, a) => s + (Number(a.totalLabour) || 0), 0));

  const box = (l, v, c) => `<div style="flex:1;min-width:140px;background:rgba(0,0,0,0.25);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:0.74rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;font-size:1.05rem;color:${c}">${v}</div></div>`;

  const card = acc => {
    const t = rahaAccountTotals(acc);
    const isSale = acc.direction === 'sale';
    const n = rahaTxOf(acc.id).length;
    return `<div onclick="openRahaAccount('${acc.id}')"
      style="cursor:pointer;background:rgba(0,0,0,0.25);border:1px solid ${isSale ? 'rgba(72,187,120,0.4)' : 'rgba(246,173,85,0.35)'};border-radius:12px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px">
        <span style="font-weight:800;font-size:0.98rem">${escapeHtmlSup(acc.name)}</span>
        <span style="font-size:0.65rem;padding:2px 8px;border-radius:20px;white-space:nowrap;
          background:${isSale ? 'rgba(72,187,120,0.18)' : 'rgba(246,173,85,0.18)'};
          color:${isSale ? 'var(--green)' : '#f6ad55'}">${isSale ? '📤 مبيعات' : '📥 مشتريات'}</span>
      </div>
      <div style="font-size:1.05rem;font-weight:800;color:${t.balance === 0 ? 'var(--text-secondary)' : (isSale ? 'var(--green)' : 'var(--red)')}">
        ${fmt(t.balance, 'دج')}</div>
      <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:4px">
        ${t.balance === 0 ? 'مصفّى بالكامل' : (isSale ? 'مستحقّ لنا على الزبائن' : 'مستحقّ للمورد')}</div>
      <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:6px">
        ${n} حركة • ${isSale ? 'مبيعات' : 'بضاعة'} ${fmt(t.goods)} • ${isSale ? 'محصَّل' : 'مدفوع'} ${fmt(t.pay)}</div>
      ${acc.totalQty ? `<div style="font-size:0.72rem;color:#f6ad55;margin-top:4px">
        ${acc.qtyLabel}: ${fmt(acc.totalQty)} ${acc.qtyUnit}</div>` : ''}
    </div>`;
  };

  el.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${box('الحسابات', accs.length, 'var(--text-primary)')}
      ${box('مستحقّ للموردين', fmt(owed, 'دج'), 'var(--red)')}
      ${box('مستحقّ لنا (النخالة)', fmt(due, 'دج'), due === 0 ? 'var(--text-secondary)' : 'var(--green)')}
      ${labour ? box('مصاريف خدامة', fmt(labour, 'دج'), '#f6ad55') : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px">
      ${buy.map(card).join('')}${sell.map(card).join('')}
    </div>`;
}

/* ---------------- account ledger ---------------- */
function openRahaAccount(id) {
  _currentRahaAccount = id;
  renderRahaAccount();
  document.getElementById('modal-raha-account').classList.add('open');
}

function renderRahaAccount() {
  const acc = getRahaAccounts().find(a => a.id === _currentRahaAccount);
  if (!acc) return;
  const isSale = acc.direction === 'sale';
  const t = rahaAccountTotals(acc);

  document.getElementById('raha-account-title').innerHTML =
    `${isSale ? '📤' : '📥'} ${escapeHtmlSup(acc.name)}
     <span style="font-size:0.62rem;padding:2px 8px;border-radius:20px;margin-inline-start:8px;
       background:${isSale ? 'rgba(72,187,120,0.18)' : 'rgba(246,173,85,0.18)'};
       color:${isSale ? 'var(--green)' : '#f6ad55'}">${isSale ? 'حساب مبيعات' : 'حساب مشتريات'}</span>`;

  const box = (l, v, c) => `<div style="flex:1;min-width:120px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;text-align:center">
      <div style="font-size:0.72rem;color:var(--text-secondary)">${l}</div>
      <div style="font-weight:800;color:${c}">${v}</div></div>`;
  document.getElementById('raha-account-summary').innerHTML =
    `<div style="display:flex;gap:10px;flex-wrap:wrap">
      ${box(isSale ? 'إجمالي المبيعات' : 'إجمالي البضاعة', fmt(t.goods, 'دج'), '#f6ad55')}
      ${box(isSale ? 'إجمالي المحصَّل' : 'إجمالي المدفوع', fmt(t.pay, 'دج'), 'var(--green)')}
      ${box(isSale ? 'الفارق' : 'الباقي', fmt(t.balance, 'دج'),
            t.balance === 0 ? 'var(--text-secondary)' : (isSale ? 'var(--green)' : 'var(--red)'))}
      ${acc.totalQty ? box(acc.qtyLabel, fmt(acc.totalQty) + ' ' + acc.qtyUnit, 'var(--text-primary)') : ''}
      ${acc.totalLabour ? box('خدامة (خارج الرصيد)', fmt(acc.totalLabour, 'دج'), '#f6ad55') : ''}
    </div>`;

  // chronological for the running balance, then shown newest-first
  const tx = rahaTxOf(acc.id).slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || (a.excelRow - b.excelRow) ||
    (a.kind === b.kind ? 0 : a.kind === 'payment' ? 1 : -1));
  let running = 0;
  tx.forEach(row => {
    running = rahaR2(running + (row.kind === 'payment' ? -row.amount : row.amount));
    row._running = running;
  });

  const kindLabel = k => k === 'payment' ? (isSale ? 'تحصيل' : 'دفع')
    : k === 'opening' ? 'رصيد افتتاحي'
    : k === 'labour-only' ? 'خدامة فقط'
    : (isSale ? 'بيع' : 'شراء');
  const kindColor = k => k === 'payment' ? 'var(--green)'
    : k === 'opening' ? 'var(--gold)'
    : k === 'labour-only' ? 'var(--text-secondary)' : '#f6ad55';

  const showItem = acc.schema !== 'rimi' || true;
  document.getElementById('raha-account-content').innerHTML = `
    <table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr>
        <th>التاريخ</th><th>${escapeHtmlSup(acc.itemLabel)}</th>
        <th>${escapeHtmlSup(acc.qtyLabel)}</th><th>السعر</th>
        <th>النوع</th><th>${isSale ? 'المبيعات' : 'البضاعة'}</th><th>${isSale ? 'المحصَّل' : 'المدفوع'}</th>
        ${acc.totalLabour ? '<th>خدامة</th>' : ''}<th>الرصيد</th>
      </tr></thead>
      <tbody>${tx.slice().reverse().map(row => {
        const isPay = row.kind === 'payment';
        return `<tr>
          <td style="white-space:nowrap">${row.date || '—'}</td>
          <td>${escapeHtmlSup(row.item || '')}</td>
          <td>${row.qty == null ? '' : fmt(row.qty)}</td>
          <td>${row.price == null ? '' : fmt(row.price)}</td>
          <td style="color:${kindColor(row.kind)};font-weight:700;white-space:nowrap">${kindLabel(row.kind)}${row.computed ? ' 🧮' : ''}</td>
          <td style="color:#f6ad55;font-weight:700">${isPay || !row.amount ? '' : fmt(row.amount)}</td>
          <td style="color:var(--green);font-weight:700">${isPay ? fmt(row.amount) : ''}</td>
          ${acc.totalLabour ? `<td style="color:var(--text-secondary)">${row.labour ? fmt(row.labour) : ''}</td>` : ''}
          <td style="font-weight:700">${fmt(row._running)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${tx.some(x => x.computed) ? `<div style="font-size:0.74rem;color:var(--text-secondary);margin-top:8px">
      🧮 = قيمة كانت صيغة بلا نتيجة محفوظة في الملف، حسبها التطبيق من الكمية × السعر.</div>` : ''}`;
}

/* ---------------- reports ---------------- */
function openRahaReports() {
  const acc = getRahaAccounts().find(a => a.id === _currentRahaAccount);
  if (!acc) return;
  const tx = rahaTxOf(acc.id);
  const isSale = acc.direction === 'sale';

  const tbl = (head, rows) => `<table class="data-table" style="width:100%;font-size:0.8rem">
      <thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  // group by item (product / material kind / customer)
  const groups = {};
  tx.forEach(t => {
    const key = supNormAr(t.item) || '(غير محدّد)';
    if (!groups[key]) groups[key] = { label: t.item || '(غير محدّد)', qty: 0, goods: 0, pay: 0, times: 0, prices: new Set() };
    const g = groups[key];
    if (t.kind === 'payment') g.pay = rahaR2(g.pay + t.amount);
    else { g.goods = rahaR2(g.goods + t.amount); g.qty = rahaR2(g.qty + (t.qty || 0)); }
    g.times++;
    if (t.price != null) g.prices.add(Number(t.price));
  });
  // pure payments carry no product, so they'd pile up under an empty label;
  // for a sale account the customer grouping still wants them.
  const rows = Object.keys(groups).map(k => groups[k])
    .filter(g => isSale || g.goods || g.qty)
    .sort((a, b) => b.goods - a.goods);

  let html = `<h3 style="color:#f6ad55;margin:0 0 8px">
      ${isSale ? '👤 المبيعات والتحصيل حسب الزبون' : '📦 ' + escapeHtmlSup(acc.itemLabel) + ' — الكميات والمبالغ'} (${rows.length})</h3>
    ${tbl([escapeHtmlSup(acc.itemLabel), escapeHtmlSup(acc.qtyLabel), 'مرّات',
           isSale ? 'المبيعات' : 'المبلغ', ...(isSale ? ['المحصَّل'] : []), 'أسعار مختلفة'],
      rows.map(g => `<tr>
        <td>${escapeHtmlSup(g.label)}</td>
        <td>${g.qty ? fmt(g.qty) + ' ' + acc.qtyUnit : ''}</td>
        <td>${g.times}</td>
        <td style="color:#f6ad55;font-weight:700">${fmt(g.goods)}</td>
        ${isSale ? `<td style="color:var(--green);font-weight:700">${fmt(g.pay)}</td>` : ''}
        <td>${g.prices.size}</td></tr>`).join(''))}`;

  // price history
  const moved = rows.filter(g => g.prices.size > 1);
  html += `<h3 style="color:#f6ad55;margin:18px 0 8px">📈 تطوّر السعر (${moved.length})</h3>
    ${moved.length ? tbl([escapeHtmlSup(acc.itemLabel), 'الأسعار'],
      moved.map(g => `<tr><td>${escapeHtmlSup(g.label)}</td>
        <td>${[...g.prices].sort((a, b) => a - b).map(x => fmt(x)).join(' ← ')}</td></tr>`).join(''))
      : '<div style="color:var(--text-secondary);padding:10px">السعر ثابت في كل الحركات.</div>'}`;

  // labour is deliberately outside the balance
  if (acc.totalLabour) {
    const lab = tx.filter(t => t.labour).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    html += `<h3 style="color:#f6ad55;margin:18px 0 8px">👷 مصاريف خدامة النخالة — ${fmt(acc.totalLabour, 'دج')}</h3>
      <div style="font-size:0.76rem;color:var(--text-secondary);margin-bottom:8px">
        ℹ️ هذه المصاريف خارج معادلة الرصيد تمامًا، كما في الملف.</div>
      ${tbl(['التاريخ', 'الزبون', 'المبلغ'],
        lab.map(t => `<tr><td>${t.date || '—'}</td><td>${escapeHtmlSup(t.item || '')}</td>
          <td style="color:#f6ad55;font-weight:700">${fmt(t.labour)}</td></tr>`).join(''))}`;
  }

  document.getElementById('raha-reports-title').textContent = '📊 تقارير: ' + acc.name;
  document.getElementById('raha-reports-content').innerHTML = html;
  document.getElementById('modal-raha-reports').classList.add('open');
}

function deleteCurrentRahaAccount() {
  const acc = getRahaAccounts().find(a => a.id === _currentRahaAccount);
  if (!acc) return;
  if (!confirm(`حذف حساب «${acc.name}» وكل حركاته؟`)) return;
  setRahaTx(getRahaTx().filter(t => t.accountId !== acc.id));
  setRahaAccounts(getRahaAccounts().filter(a => a.id !== acc.id));
  _currentRahaAccount = null;
  document.getElementById('modal-raha-account').classList.remove('open');
  renderRahaPanel();
  showToast('تم حذف الحساب');
}

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('raha-import-input');
  if (inp) inp.addEventListener('change', e => {
    if (e.target.files && e.target.files.length) handleRahaImport(e.target.files);
  });
  const del = document.getElementById('btn-delete-raha-account');
  if (del) del.addEventListener('click', deleteCurrentRahaAccount);
});
