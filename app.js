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
  if (CURRENT_ROLE === 'owner') {
    const workers = DB.get('workers') || [];
    if (workers.length > 0) return true;
  }
  return false;
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
}

let CURRENT_LINKED_OWNERS = [];

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

  addFactory(name, icon, color) {
    const list = this.getFactories();
    const id = 'f_' + Date.now();
    // Carry existing partner UIDs into the new factory so they see it immediately
    const partnerUids = [...new Set(list.flatMap(f => f.partnerUids || []))];
    const factory = { id, name, icon, color, ownerUid: EFFECTIVE_OWNER_UID, createdAt: new Date().toISOString(), partnerUids };
    list.push(factory);
    this.saveFactories(list);
    return factory;
  },

  deleteFactory(id) {
    let list = this.getFactories().filter(f => f.id !== id);
    this.saveFactories(list);
    ['settings', 'workers', 'daily_logs', 'activities'].forEach(k => {
      localStorage.removeItem(`zohir_${id}_${k}`);
    });
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
    
    // STEP 1: Direct fetch for initial load
    fs.collection('app_data').doc(docId).get({ source: 'server' })
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
    settings: loadSettingsForm
  };
  if (refreshers[pageId]) refreshers[pageId]();
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
  const myFactories = readFactoriesForOwner(CURRENT_USER?.uid).filter(f =>
    !f.ownerUid || f.ownerUid === CURRENT_USER?.uid
  );

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
  if (myHeader) myHeader.style.display = '';

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

  card.innerHTML = `
    ${canDelete ? `<button class="factory-card-delete" data-id="${factory.id}" title="حذف المصنع">✕</button>` : ''}
    <span class="factory-card-icon">${factory.icon || '🐔'}</span>
    <div class="factory-card-name">${factory.name}</div>
    <div class="factory-card-meta">${isPrimaryOwner ? '👔 تملك هذا المصنع' : `🤝 شريك${myShareRaw ? ' — حصتك ' + myShareRaw + '%' : ''}`}</div>
    <div class="factory-card-stat">
      <span class="label">مدخول اليوم</span>
      <span class="value">${todayLog ? fmt(todayLog.income, 'دج') : '—'}</span>
    </div>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('factory-card-delete') || e.target.closest('.factory-card-delete')) return;

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
    document.getElementById('sidebar-factory-sub').textContent = isSharedFactory ? '(شراكة)' : '';
    document.getElementById('topbar-factory-name').textContent = `deku — ${factory.name}${isSharedFactory ? ' (شراكة)' : ''}`;

    initFactoryData();
    applyRoleToUI(CURRENT_ROLE, CURRENT_USER_NAME);
    renderPartnerExpensesInForm();

    document.getElementById('factory-screen').style.display = 'none';
    const appWrapper = document.getElementById('app-wrapper');
    appWrapper.style.display = 'flex';

    showPage('dashboard');
    updateLiveDate();
    initCloudSync();
    populateWorkerSelects();
  };

  playFactoryEntryTransition(factory, sourceCard, continueEnter);
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
function triggerNavAnimation(clickedBtn, selector, clickClass, waveClass) {
  const all = [...document.querySelectorAll(selector)];
  const myIdx = all.indexOf(clickedBtn);

  // Animate the clicked item
  clickedBtn.classList.remove(clickClass);
  void clickedBtn.offsetWidth;
  clickedBtn.classList.add(clickClass);
  setTimeout(() => clickedBtn.classList.remove(clickClass), 500);

  // Cascade wave on every other item
  all.forEach((other, i) => {
    if (other === clickedBtn) return;
    const delay = Math.abs(i - myIdx) * 55 + 25;
    other.style.setProperty('--wave-delay', `${delay}ms`);
    other.classList.remove(waveClass);
    void other.offsetWidth;
    other.classList.add(waveClass);
    setTimeout(() => other.classList.remove(waveClass), delay + 440);
  });
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
      <span class="kpi-value" style="color:${myProfit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(myProfit, 'دج')}</span>
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
  const produced = Number(document.getElementById('inp-produced').value) || 0;
  const broken = Number(document.getElementById('inp-broken').value) || 0;
  const price = Number(document.getElementById('inp-price').value) || 0;
  const soldTotal = Number(document.getElementById('inp-sold-total').value) || 0;
  const feedIn = Number(document.getElementById('inp-feed-in').value) || 0;
  const feedPrice = Number(document.getElementById('inp-feed-price').value) || 0;
  const feedUsed = Number(document.getElementById('inp-feed-used').value) || 0;
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

  // Identify dust worker (advances of dust worker are deducted from dust profit, not general profit)
  const _workersList = DB.get('workers') || [];
  const _dustWorkerIds = new Set(_workersList.filter(w => w.isDustWorker).map(w => String(w.id)));

  let workerAdvancesTotal = 0;
  let dustWorkerAdvancesToday = 0;
  document.querySelectorAll('.advance-row').forEach(row => {
    const wid = row.querySelector('.adv-worker-select')?.value;
    const amt = Number(row.querySelector('.adv-amount').value) || 0;
    if (wid && _dustWorkerIds.has(String(wid))) {
      dustWorkerAdvancesToday += amt;
    } else {
      workerAdvancesTotal += amt;
    }
  });

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
  const feedCost = feedIn * feedPrice;

  // Collect advances
  // Dust-worker advances are tracked separately and NOT deducted from baseProfit (they come out of dust profit)
  const _workersForCalc = DB.get('workers') || [];
  const _dustIds = new Set(_workersForCalc.filter(w => w.isDustWorker).map(w => String(w.id)));
  const advRows = document.querySelectorAll('.advance-row');
  const advancesThisDay = [];
  let workerAdvancesTotal = 0;
  let dustWorkerAdvancesToday = 0;
  advRows.forEach(row => {
    const workerId = row.querySelector('.adv-worker-select').value;
    const amount = Number(row.querySelector('.adv-amount').value) || 0;
    if (workerId && amount > 0) {
      advancesThisDay.push({ workerId, amount, date });
      if (_dustIds.has(String(workerId))) {
        dustWorkerAdvancesToday += amount;
      } else {
        workerAdvancesTotal += amount;
      }
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
    dustAdvances: dustWorkerAdvancesToday,
    isPaid, farsimon, saleClient,
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
    <div class="receipt-row no-print"><span>سعر البلاكة</span><span>${fmt(log.price, 'دج')}</span></div>
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
  ['inp-produced', 'inp-broken', 'inp-price', 'inp-sold-total', 'inp-free-plates',
    'inp-feed-in', 'inp-feed-price', 'inp-feed-used', 'inp-dead', 'inp-water-cost', 'inp-manure-income',
    'inp-owner-advance', 'inp-notes', 'inp-special-plates', 'inp-special-singles', 'inp-special-price',
    'inp-farsimon', 'inp-sale-client'].forEach(id => {
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
    const dateObj = new Date(log.date);
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
    const dateObj = new Date(log.date);
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

  const sortedLogs = [...monthData.logs].sort((a, b) => new Date(b.date) - new Date(a.date));
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

async function addPartner() {
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error'); return;
  }
  // This can be called from Settings, the Team page, or the share-factory modal
  const nameFromSettings = document.getElementById('new-partner-name')?.value.trim();
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

  const name = nameFromSettings || nameFromTeam || nameFromModal;
  const share = shareFromSettings || shareFromTeam || shareFromModal;
  const email = emailFromTeam || emailFromModal || '';

  if (!name) { showToast('يرجى إدخال اسم الشريك', 'error'); return; }
  if (isNaN(share) || share <= 0 || share > 100) { showToast('نسبة غير صحيحة (1-100)', 'error'); return; }
  if (!CURRENT_FACTORY) { showToast('⚠️ افتح المصنع أولاً', 'error'); return; }

  const teamBtn = document.getElementById('btn-add-team-partner');
  const shareBtn = document.getElementById('btn-confirm-share-factory');
  const btn = teamBtn;
  const setBtnState = (busy) => {
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
  addPartner();
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

  // Render Partner Summary
  const settings = DB.get('settings') || defaultSettings();
  renderPartnerFinancialSummary(logs, settings);
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
  const feedCost       = (Number(settings.initialFeed)     || 0) * (Number(settings.feedPrice)    || 0);
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
    const firstDate = new Date(sorted[0].date);
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
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
  if (isReadOnlyUser()) {
    showToast('🔒 صلاحية محظورة: وضع المشاهدة فقط', 'error');
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
    btn.addEventListener('click', () => {
      if (!btn.dataset.page) return;
      triggerNavAnimation(btn, '.nav-item[data-page]', 'nav-item--click', 'nav-item--wave');
      showPage(btn.dataset.page);
    });
  });

  document.querySelectorAll('.bottom-nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      triggerNavAnimation(btn, '.bottom-nav-item[data-page]', 'bottom-nav-item--click', 'bottom-nav-item--wave');
      showPage(btn.dataset.page);
    });
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
