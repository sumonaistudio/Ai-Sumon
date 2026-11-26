# Suman AI Studio — Phase 8–12 প্রতিবেদন (চূড়ান্ত)

**তারিখ:** ২৬ নভেম্বর ২০২৬ | **ভার্সন:** 1.0.0-beta — **কোড সম্পূর্ণ, ডেপ্লয় বাকি**
**নিয়ম:** ✅ = যাচাই করা। ⚠️ = আংশিক / মালিকের সেটআপ লাগবে। ❌ = নেই — ভুয়া দাবি নয়।

> **সবচেয়ে গুরুত্বপূর্ণ কথা:** এটা "production-ready" নয়। ১২টি Phase-র কোড লেখা হয়েছে, আইসোলেটেড টেস্টে **১০৭ পাস, ০ ফেল**। কিন্তু লাইভ ডেটাবেস, Higgsfield Key, Storage, Resend ছাড়া আসল সাইট চলবে না। সেগুলো বসানোর পর `TESTING.md`-এর লাইভ টেস্টগুলো আবার চালাতে হবে। ডেপ্লয় সফল বলা হয়নি — কারণ ডেপ্লয় করা হয়নি।

---

## ১. Phase 8 — Higgsfield জেনারেশন ফ্লো ✅

**ফাইল:** `server/generate.js`, `test/generate-gallery.test.js`, `public/generate.html` (wired)

- `POST /api/generate` — মডেল যাচাই (শুধু verified + enabled), প্রম্পট ≤ ২০০০ অক্ষর, খরচ শুধু সার্ভার-সাইড রেজিস্ট্রি থেকে (ব্রাউজারের amount কখনো পড়া হয় না), Higgsfield Key আছে কি না **কাটার আগেই** চেক, তারপর একই ট্রানজাকশনে ক্রেডিট কাটা + generations রো তৈরি (idempotency `generate:<uuid>`)। Higgsfield কল ট্রানজাকশনের বাইরে। ব্যর্থ হলে রো `failed` + **একবারই** রিফান্ড (`refund:<id>`)।
- `GET /api/generations/:id/status` — নিজের জেনারেশনই শুধু (অন্যেরটা 404), Higgsfield পোলিং, terminal হলে আর পোল করে না। সম্পূর্ণ হলে `result_url` + একবারই `api_usage` রো (রেকর্ড করা USD খরচ — Higgsfield যা জানায়, না জানালে null) + আনুমানিক ক্রেডিট খরচ **আলাদা লেবেলে** — কখনো মেশানো হয় না। ব্যর্থ/NSFW হলে একবারই রিফান্ড। সম্পূর্ণ হলে নোটিফিকেশন তৈরি হয়।
- `POST /api/generations/:id/cancel` — terminal হলে 409, নাহলে Higgsfield-এ বাতিল + একবারই রিফান্ড (শুধু সম্পূর্ণ হয়নি এমন জব)।
- `POST /api/upload-reference` — ধরন/সাইজ যাচাই করে **সবসময় 501 `STORAGE_NOT_CONFIGURED`** — Supabase Storage নেই বলে আপলোড চালু হয়নি, ভুয়া সফলতা নয়। Image-to-Video আপাতত হোস্ট করা ছবির URL (`input_url`) দিয়ে চলে।
- **ওয়াটারমার্ক নিয়ম:** ফ্রি ইউজার → `watermark_required = TRUE`; সক্রিয় পেইড সাবস্ক্রিপশন বা `is_paid` → FALSE; DB চেক ব্যর্থ হলে নিরাপদ দিকে TRUE। প্রোভাইডারের নিজের ওয়াটারমার্ক সরানোর দাবি কোথাও করা হয়নি।
- **Migration 004** যোগ করা হয়েছে: `generations.watermark_required BOOLEAN NOT NULL DEFAULT TRUE` (Phase 8 ওয়ার্কারের ফ্ল্যাগ করা ঘাটতি বন্ধ)।
- **টেস্ট:** ৩৩টি আইসোলেটেড টেস্ট পাস (খরচ, idempotency, ওয়াটারমার্ক, প্রম্পট/আপলোড ভ্যালিডেশন, স্ট্যাটাস ম্যাপ)।

## ২. Phase 9 — গ্যালারি, রেফারেল, নোটিফিকেশন, সাপোর্ট ✅

**ফাইল:** `server/gallery.js`, `server/referrals.js`, `server/notifications.js`, `server/support.js`, `server/templates.js`, `public/gallery.html`, `public/support.html`, `public/dashboard.html` (নোটিফিকেশন + রেফারেল যোগ), `public/index.html` (প্রাইসিং + ডেমো গ্যালারি + FAQ + যোগাযোগ)

- **গ্যালারি:** প্রকাশ শুধু স্পষ্ট `is_public: true` দিলে, নিজের সম্পূর্ণ জেনারেশনই শুধু। পাবলিক তালিকায় শুধু public + মডারেশন-লুকানো নয় এমন আইটেম। লাইক একবারই (toggle), কমেন্ট ১–৫০০ অক্ষর, রিপোর্টে কারণ আবশ্যক — রিপোর্ট করলে স্বয়ংক্রিয়ভাবে লুকানো হয় না, মডারেটর সিদ্ধান্ত নেন। মালিকের ইমেইল কখনো প্রকাশ হয় না।
- **রেফারেল:** নিজের কোড + লিংক (`/register.html?ref=<কোড>`), রেফার করা বন্ধুর ইমেইল মাস্ক করা হয়। বোনাস **শুধু** বন্ধুর প্রথম পেমেন্ট অ্যাডমিন অনুমোদন করলে, একবারই (`referral-bonus:<referred_id>`), টাকা settings থেকে। Self-referral ব্লক। বোনাসের হুক `payments.approvePayment`-এ বসানো হয়েছে (একই ট্রানজাকশনে, try/catch — বোনাস ব্যর্থ হলেও approval আটকায় না)।
- **নোটিফিকেশন:** জেনারেশন সম্পূর্ণ, পেমেন্ট অনুমোদন/প্রত্যাখ্যান, ক্রেডিট যোগ — নিজেরটাই শুধু দেখা যায়, mark-read আছে।
- **সাপোর্ট:** টিকিট (শিরোনাম + বার্তা), উত্তর (মালিক বা অ্যাডমিন), FAQ/ঘোষণা পাবলিক (শুধু active)।
- **টেমপ্লেট:** পাবলিক তালিকা, শুধু active।
- **Migration 005** যোগ করা হয়েছে: `gallery_items.is_demo` + `support_ticket_replies` টেবিল (Phase 9 ওয়ার্কারের ফ্ল্যাগ করা দুটি ঘাটতি বন্ধ — এখন `?demo=true` সত্যিই শুধু ডেমো দেখায়, আর টিকিটের উত্তর 501 না দিয়ে সংরক্ষণ হয়)।
- **টেস্ট:** ১৮টি আইসোলেটেড টেস্ট পাস (কমেন্ট/রিপোর্ট/টিকিট/উত্তর ভ্যালিডেশন, নোটিফিকেশন ধরন, ইমেইল মাস্কিং, রেফারেল লিংক)।

## ৩. Phase 10 — সিকিউরিটি + টেস্টিং ✅

**ফাইল:** `server/security.js`, `SECURITY.md`, `TESTING.md`, `test/security.test.js`

- `server/security.js` — ভ্যালিডেশন হেল্পার (ইমেইল/পাসওয়ার্ড/`sanitizeText`) + `securityAudit()` — লাইভ কনফিগ পড়ে বলে কী পাস/সতর্কতা/fail। অ্যাডমিন-শুধু এন্ডপয়েন্ট `GET /api/admin/security`।
- `SECURITY.md` — ৮টি বিভাগের চেকলিস্ট: অথ, রোল, ক্রেডিট, ইনপুট/আপলোড, নেটওয়ার্ক, লগ/ব্যাকআপ, অ্যাডমিন নিয়ম, খোলা কাজ। সৎ চিহ্ন: CORS এখনো সব origin-এ খোলা (ডেপ্লয়ে সীমাবদ্ধ করতে হবে), `.gitignore` এখনো নেই (রিপো বানানোর সময় যোগ করতে হবে), ব্যাকআপ নেই (Supabase ফ্রি)।
- `TESTING.md` — মাস্টার প্রম্পটের ১৯টি টেস্টের প্রত্যেকটির সৎ অবস্থা (আইসোলেটেড পাস / লাইভ BLOCKED / হয়নি) + লাইভ সার্ভার টেস্টের টেবিল।
- **টেস্ট:** সিকিউরিটি ১০টি আইসোলেটেড টেস্ট পাস।

## ৪. Phase 11 — পারফরম্যান্স + মোবাইল ✅ (সীমাসহ)

- Static ক্যাশিং: HTML `no-cache` (নতুন ডেপ্লয় সাথে সাথে দেখাবে), ছবি/CSS/JS `max-age=86400`।
- ১১টি পেজের সবগুলোতে viewport + dark/light আছে। পেজগুলো ছোট (সবচেয়ে বড় ~২০ KB HTML) — Tailwind CDN ছাড়া নিজের কোনো ভারী ফাইল নেই।
- **সৎ সীমা (লুকানো হয়নি):** ভাষা টগল স্পষ্টভাবে ৫টি পেজে আছে, বাকি পেজ বাংলা-প্রথম স্ট্যাটিক লেখা। কিছু সেকেন্ডারি বোতামে `py-1` (ছোট প্যাডিং) আছে — সব টাচ টার্গেট আদর্শ নয়। **আসল Android ফোনে পরীক্ষা হয়নি** — ডেপ্লয়ের পর মালিককে নিজের ফোনে সব পেজ খুলে দেখতে হবে (চেকলিস্টে আছে)।

## ৫. Phase 12 — ডেপ্লয় প্রস্তুতি ✅

**ফাইল:** `README.md` (সম্পূর্ণ নতুন করে লেখা), `DEPLOYMENT-CHECKLIST.md`, `.env.example` (সব ভ্যারিয়েবল), ভার্সন **1.0.0-beta**

- README: GitHub রিপো (`sumonaistudio` অ্যাকাউন্ট — মালিক ২৬ নভেম্বর ২২:০৬-এ খুলেছেন) → Supabase (মাইগ্রেশন 001–005) → Render → প্রথম Super Admin বানানোর SQL → Higgsfield Key → Resend — ধাপে ধাপে, বাংলা, Android-বান্ধব।
- `.env.example`: সব ভ্যারিয়েবল আছে (`PUBLIC_URL` যোগ করা হয়েছে; `ADMIN_EMAIL/PASSWORD` কোডে ব্যবহার হয় না বলে রিজার্ভ হিসেবে চিহ্নিত; Google ভ্যারিয়েবল ভবিষ্যতের জন্য চিহ্নিত)।
- চেকলিস্ট: প্রতিটি ধাপের পাশে যাচাই-পদ্ধতি লেখা আছে — যাচাই ছাড়া "হয়ে গেছে" বলা যাবে না।

## ৬. টেস্ট ফলাফল (২৬ নভেম্বর ২০২৬, যাচাই করা)

### A. আইসোলেটেড — `npm test`: **১০৭ পাস, ০ ফেল**
| ফাইল | পাস |
|---|---|
| `test/auth-isolated.test.js` | ১৭ |
| `test/credits-payments.test.js` | ২৯ |
| `test/generate-gallery.test.js` | ৩৩ |
| `test/phase9.test.js` | ১৮ |
| `test/security.test.js` | ১০ |

### B. লাইভ সার্ভার (পোর্ট 3105/3106, DB/Key ছাড়া — সৎ আচরণ যাচাই)
| চেক | ফলাফল |
|---|---|
| `GET /api/health` | 200 — version 1.0.0-beta, database/higgsfield `not_configured` |
| `GET /api/models` | 200 — ৫টি যাচাই করা মডেল |
| `GET /api/gallery`, `/api/faqs`, `/api/announcements`, `/api/templates`, `/api/packages` | 503 `DB_NOT_CONFIGURED` |
| `GET /api/creations`, `/api/credits`, `/api/notifications`, `/api/referrals/me` (টোকেন ছাড়া) | 401 |
| `POST /api/generate`, `/api/upload-reference`, `/api/gallery/publish` (টোকেন ছাড়া) | 401 |
| `GET /api/admin/*` (টোকেন ছাড়া) | 401 |
| ১১টি পাবলিক পেজ | সব 200 |
| `npm run migrate` (DATABASE_URL ছাড়া) | সৎভাবে ব্যর্থ, exit 1 |
| টেস্ট সার্ভার | প্রতিবার বন্ধ করা হয়েছে, পোর্ট ফাঁকা যাচাই করা হয়েছে |

### C. পরীক্ষার সময় ধরা পড়া ভুল ও ঠিক করা
1. Phase 9 টেস্টে গ্যালারি ভ্যালিডেটরের রিটার্ন আকৃতি ভুল ধরা হয়েছিল (`{ok}` ভেবে, আসলে `{error, text}`) — ৫টি টেস্ট ফেল করেছিল; আসল আকৃতি পড়ে টেস্ট ঠিক করা হয়েছে, এখন ১৮/১৮ পাস।
2. `.env.example` সরাসরি overwrite করতে গিয়ে ব্যর্থ হয়েছিল (আগে পড়তে হয়) — পড়ে তারপর লেখা হয়েছে।
3. `pkill -f "PORT=..."` নিজের শেলকে মেরে ফেলছিল (কমান্ড লাইনে প্যাটার্ন মিলে যায়) — পরে পোর্টের আসল PID (numeric) ধরে kill করা হয়েছে; সার্ভার পরিষ্কারভাবে বন্ধ যাচাই করা হয়েছে।

## ৭. এখনো বাকি — সৎ তালিকা (BLOCKED, ভুয়া সফলতা নয়)

1. **লাইভ DB ফ্লো** — Supabase `DATABASE_URL` নেই (মালিকের অ্যাকাউন্ট বাকি)।
2. **লাইভ Higgsfield** — Key + প্রিপেইড ব্যালেন্স নেই।
3. **Supabase Storage** — রেফারেন্স আপলোড 501।
4. **Resend ইমেইল** — Key নেই, আসল রিসেট মেইল যায়নি।
5. **Google OAuth** — Client ID/Secret নেই, 501 stub।
6. **আসল ফোনে যাচাই** — মোবাইল UX ডিভাইসে পরীক্ষা হয়নি।
7. **CORS** — এখনো সব origin খোলা; ডেপ্লয়ে নিজের ডোমেইনে সীমাবদ্ধ করতে হবে।
8. **`.gitignore`** — রিপো বানানোর সময় যোগ করতে হবে (চেকলিস্টে আছে)।
9. **ব্যাকআপ** — Supabase ফ্রিতে স্বয়ংক্রিয় ব্যাকআপ নেই; সপ্তাহে ১ বার dump নিতে হবে।

## ৮. ফাইল তালিকা (নতুন / বদলানো, Phase 8–12)

- `server/generate.js` — জেনারেশন ফ্লো (Phase 8)
- `server/gallery.js`, `server/referrals.js`, `server/notifications.js`, `server/support.js`, `server/templates.js` — Phase 9
- `server/security.js` — সিকিউরিটি হেল্পার + অডিট (Phase 10)
- `server.js` — v1.0.0-beta, Phase 8+9 রুট, `/api/admin/security`, static ক্যাশিং
- `server/payments.js` — রেফারেল বোনাস হুক (approve-এ)
- `server/generate.js` — জেনারেশন সম্পূর্ণ হলে নোটিফিকেশন
- `db/migrations/004_phase8.sql` — `watermark_required`; `005_phase9.sql` — `is_demo` + `support_ticket_replies`
- `db/run-migrations.js` — এখন 001–005 চালায়
- `public/generate.html` (wired), `public/gallery.html`, `public/support.html`, `public/dashboard.html` (নোটিফিকেশন + রেফারেল), `public/index.html` (প্রাইসিং + ডেমো গ্যালারি + FAQ)
- `test/generate-gallery.test.js`, `test/phase9.test.js`, `test/security.test.js`
- `SECURITY.md`, `TESTING.md`, `DEPLOYMENT-CHECKLIST.md`, `README.md` (নতুন), `.env.example` (সম্পূর্ণ), `package.json` (1.0.0-beta)
- `PHASE8-12-REPORT.md` — এই প্রতিবেদন

## ৯. মালিককে যা করতে হবে (একবারে এক ধাপ)

1. **Supabase অ্যাকাউন্ট** খুলে প্রজেক্ট বানান → 001–005 মাইগ্রেশন চালান → `DATABASE_URL` নিন। — সবচেয়ে জরুরি।
2. **GitHub-এ `suman-ai-studio` রিপোজিটরি** বানান (অ্যাকাউন্ট আছে: `sumonaistudio`) → ফাইল আপলোড করুন।
3. তারপর Render ডেপ্লয় (চেকলিস্ট ধাপ ৩)।
4. পাসওয়ার্ড, OTP, API Key — কিছুই চ্যাটে দেবেন না।
