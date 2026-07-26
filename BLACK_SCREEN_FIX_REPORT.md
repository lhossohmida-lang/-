# تقرير فحص وإصلاح الشاشة السوداء في تطبيق deku

## النتيجة

تم فحص الخادم والواجهة في متصفح اختبار حقيقي. الخادم يعمل ويعيد الصفحة بنجاح، وشاشة الدخول تظهر في بيئة متصفح نظيفة بدون أخطاء JavaScript.

تمت إضافة إصلاحات تمنع الانتقال الصامت إلى شاشة سوداء، كما تمت إضافة شاشة خطأ مرئية تعرض السبب بدل ترك المستخدم أمام خلفية سوداء.

## سبب المشكلة

كان التطبيق يعتمد على عدة حالات متزامنة حتى تظهر الواجهة: تحميل Firebase، قراءة حالة تسجيل الدخول، قراءة ملف المستخدم من Firestore، مزامنة قائمة المصانع، إخفاء طبقة التحميل، ثم إظهار شاشة المصانع أو لوحة المصنع.

إذا بقيت طبقة التحميل أو بقيت الشاشتان الرئيسيتان مخفيتين بسبب تأخير Firebase أو Service Worker أو جلسة Chrome قديمة، كانت النتيجة شاشة سوداء بدون رسالة واضحة.

كما كان هناك تعارض بين HTML وJavaScript: بعض عناصر تسجيل الحساب والتبويبات حُذفت من HTML، بينما كانت `switchAuthTab()` تحاول الوصول إليها مباشرة بدون التأكد من وجودها.

## التعديلات المنفذة

### حماية `switchAuthTab`

تم تعديل `app.js` بحيث تكون عناصر `form-register` و`tab-register` اختيارية. غيابها لا يوقف التطبيق.

مثال الإصلاح:

```js
if (tabReg) tabReg.classList.remove('active');
```

### إخفاء طبقة التحميل فورًا

تم تعديل `hideGlobalLoader()` ليخفي العنصر مباشرة:

```js
loader.style.display = 'none';
```

بدل انتظار انتقال CSS قد يبقي الشاشة مغطاة.

### حماية المزامنة البطيئة

تمت إضافة حماية بعد 4.5 ثوانٍ ومراقب مؤقت كل 1.5 ثانية. يقومان بإظهار شاشة الدخول أو شاشة المصانع أو لوحة المصنع حسب حالة التطبيق.

### حالة HTML ابتدائية آمنة

أصبحت شاشة الدخول ظاهرة افتراضيًا، وأصبحت شاشة المصنع مخفية افتراضيًا حتى يتم التأكد من الحساب.

### تحديث Service Worker وCache

تم تحديث اسم Cache في `sw.js` إلى:

```js
zohir-v24-ui-visibility-fix
```

كما تم تغيير نسخة `app.js` في `index.html` إلى:

```html
app.js?v=auth-dom-fix-20260723
```

### شاشة خطأ مرئية

تمت إضافة `runtime-error-screen` إلى `index.html`، مع مستمعين لـ `window.error` و`window.unhandledrejection` في `app.js`.

إذا حدث خطأ JavaScript لاحقًا، سيظهر للمستخدم مربع واضح يحتوي على تفاصيل الخطأ بدل الشاشة السوداء الصامتة.

## نتائج الفحص

```text
node --check app.js       OK
node --check sw.js        OK
HTTP localhost:5000       200 OK
```

في متصفح اختبار نظيف كانت الحالة:

```text
global-loader: none
auth-screen: flex
factory-screen: none
app-wrapper: none
JavaScript errors: none
```

وظهرت شاشة تسجيل الدخول بشكل طبيعي.

## الملفات المعدلة

- `app.js`
- `index.html`
- `sw.js`
- `BLACK_SCREEN_FIX_REPORT.md`

## تعليمات فحص مهمة لذكاء اصطناعي آخر

عند ظهور الشاشة السوداء، يجب تنفيذ هذا الأمر في Console:

```js
['global-loader', 'auth-screen', 'factory-screen', 'app-wrapper'].map(id => ({
  id,
  exists: !!document.getElementById(id),
  inlineDisplay: document.getElementById(id)?.style.display,
  computedDisplay: document.getElementById(id) ? getComputedStyle(document.getElementById(id)).display : null,
  visibility: document.getElementById(id) ? getComputedStyle(document.getElementById(id)).visibility : null,
  opacity: document.getElementById(id) ? getComputedStyle(document.getElementById(id)).opacity : null
}))
```

ثم:

```js
document.getElementById('runtime-error-message')?.textContent
```

إذا كانت النتيجة فارغة، فالمشكلة ليست JavaScript error، بل حالة عرض أو Service Worker أو جلسة Chrome محفوظة.

## تحذيرات Firebase

تحذيرا Firestore حول `host override` و`enableMultiTabIndexedDbPersistence` غير قاتلين، ولا يمنعان ظهور الواجهة.
