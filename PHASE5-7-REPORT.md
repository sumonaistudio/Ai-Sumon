# Suman AI Studio — Phase 5–7 প্রতিবেদন

**তারিখ:** ২৬ নভেম্বর ২০২৬ | **অবস্থা:** Phase 5–7 সম্পূর্ণ (কোড + টেস্ট) — লাইভ DB টেস্ট বাকি
**নিয়ম:** Phase 1-এর স্ট্যাক অপরিবর্তিত — Node + Express মনোলিথ, Postgres (Supabase) + `pg` + plain SQL, Static HTML + Tailwind CDN, কোনো build step নেই, Prisma/React নেই। মালিকের অ্যাকাউন্ট ছাড়াই শুধু কোড বানানো হয়েছে।

---

## ১. Phase 5 — My Creations / ইউজার ড্যাশবোর্ড ব্যাকএন্ড

### যা বানানো হয়েছে
- `server/creations.js` + রুট (`server.js`): `GET /api/creations` (পাতা/ফিল্টার: status, type, model_id; সর্বোচ্চ ৫০/পাতা), `GET /api/creations/:id`, `GET /api/creations/:id/download`, `DELETE /api/creations/:id`, `GET /api/subscription/me` (সক্রিয় সাবস্ক্রিপশন)।
- `server/settings.js` — settings (JSONB) পড়ার একটাই জায়গা: retention, পেমেন্ট নম্বর/নির্দেশনা। কোডে/ফ্রন্টএন্ডে কোনো নম্বর হার্ডকোড নেই।
- `db/migrations/003_phase57.sql` — `generations.deleted_at` যোগ (soft-delete); `run-migrations.js` এখন 001 → 002 → 003 চালায়।

### নিয়ম (কোডে প্রয়োগ করা)
- **শুধু নিজের ফাইল:** প্রতিটি কোয়েরিতে `user_id = req.user.id` — অন্যের ফাইল দেখা/ডাউনলোড/মোছা অসম্ভব। তালিকার উত্তরে `result_url` সরাসরি দেওয়া হয় না (`has_result: true/false`); ডাউনলোড শুধু মালিকানা + মেয়াদ যাচাইয়ের পর 302 redirect।
- **প্রাইভেট ডিফল্ট:** এখানে কিছুই পাবলিক করা হয় না — গ্যালারিতে প্রকাশ Phase 9-এর আলাদা, স্পষ্ট কাজ।
- **Soft-delete:** DELETE শুধু `deleted_at` বসায়; মুছে ফেলা রো আর তালিকায় আসে না, কিন্তু লেজার/অডিটের রেফারেন্স থেকে যায়।
- **Retention:** `expires_at = created_at + retention_days` (settings, ডিফল্ট ৩০ দিন); পুরনো রো-তে `expires_at` না থাকলে `created_at + ৩০ দিন` ধরে হিসাব হয়। `expiring_soon` = মেয়াদ শেষ হতে ৩ দিন বা কম বাকি; মেয়াদোত্তীর্ণ ফাইলের ডাউনলোডে **410 EXPIRED**; তৈরি হয়নি এমন জবের ডাউনলোডে **409 NOT_READY**।
- **ড্যাশবোর্ড** (`public/dashboard.html`): আসল creations তালিকা + ফিল্টার, মেয়াদ-সতর্কবার্তা (৩ দিনের মধ্যে শেষ হলে কমলা ব্যাজ), ডাউনলোড/মুছুন বোতাম, সাবস্ক্রিপশন অবস্থা, ক্রেডিট লেজারের শেষ ১০টি লেনদেন, অ্যাডমিন/মডারেটরদের জন্য অ্যাডমিন লিংক।

## ২. Phase 6 — ক্রেডিট ও ম্যানুয়াল পেমেন্ট

### যা বানানো হয়েছে
- `server/credits.js` — লেজার হেল্পার: `deductCredits` / `addCredits` / `refundGeneration` / `getLedger`। প্রতিটি পরিবর্তন একই ট্রানজাকশনে `users.credit_balance` (FOR UPDATE লক) + `credit_ledger` রো। `idempotency_key` UNIQUE — একই key আবার এলে আগের রো-ই ফেরত যায়, দ্বিতীয়বার কাটা/যোগ হয় না। ব্যালেন্স কখনো নেগেটিভ হয় না (DB CHECK + কোডে চেক)।
- `server/payments.js` — `GET /api/packages` (পাবলিক, শুধু চালু প্যাকেজ), `GET /api/payment-instructions` (settings থেকে bKash/Nagad নম্বর + নির্দেশনা), `POST /api/payments` (rate limit ১০/১৫ মিনিট), `GET /api/payments` (নিজের ইতিহাস), `GET /api/payments/:id`, `GET /api/credits` (নিজের লেজার)।
- `approvePayment` / `rejectPayment` (এক ট্রানজাকশনে): approve = প্যাকেজের ক্রেডিট যোগ (লেজার `payment` + idempotency `payment-approve:<id>`) + মাসিক/বার্ষিক হলে subscription তৈরি (৩০/৩৬৫ দিন) + `is_paid = TRUE` + notification + audit; reject = কারণসহ status, কোনো ক্রেডিট নয় + notification + audit। দুবার যাচাই করলে **409 ALREADY_REVIEWED**।
- ফ্রন্টএন্ড: `public/payments.html` (প্যাকেজ বাছাই → নির্দেশনা → Trx ID জমা → নিজের ইতিহাস), `public/pricing.html` (পাবলিক প্রাইসিং, `/api/packages` থেকে)।

### নিয়ম (কোডে প্রয়োগ করা)
- **টাকা সবসময় সার্ভার থেকে:** প্যাকেজের `price_bdt`/`credits` packages টেবিল থেকে নেওয়া হয় — ব্রাউজার থেকে আসা amount থাকলেও উপেক্ষা করা হয়।
- **এক Trx ID একবারই:** `(method, transaction_id)` UNIQUE — ডুপ্লিকেটে **409 DUPLICATE_TRANSACTION**।
- **ভ্যালিডেশন:** মাধ্যম শুধু bkash/nagad; sender নম্বর বাংলাদেশি মোবাইল (`01XXXXXXXXX`, `+88` উপসর্গ মেনে নেওয়া হয়); Transaction ID ৬–৩০ অক্ষরের বড় হাতের অক্ষর/সংখ্যা।
- **রিফান্ড:** শুধু `failed` জেনারেশনে, একবারই (`refund:<generation_id>`) — `refundGeneration`।
- **কোনো স্বয়ংক্রিয় যাচাই দাবি করা হয়নি:** bKash/Nagad পার্সোনাল নম্বরে ম্যানুয়াল যাচাই — পেমেন্ট পেজে সেটা স্পষ্ট লেখা আছে।

## ৩. Phase 7 — অ্যাডমিন ড্যাশবোর্ড

### যা বানানো হয়েছে
- `server/admin.js` + রুট (`/api/admin/*`): অ্যানালিটিক্স, ইউজার তালিকা/খোঁজা, অবস্থা (suspend/ban/restore), রোল, ক্রেডিট যোগ/কাটা, প্যাকেজ CRUD, পেমেন্ট তালিকা + approve/reject, মডেল তালিকা + চালু/বন্ধ/খরচ বদলানো, কনটেন্ট CRUD (templates/announcements/faqs), গ্যালারি মডারেশন, সেটিংস, অডিট লগ।
- ফ্রন্টএন্ড: `public/admin.html` — মোবাইল-ফার্স্ট, ট্যাবভিত্তিক (অ্যানালিটিক্স / ইউজার / পেমেন্ট / প্যাকেজ / মডেল / রিপোর্ট / সেটিংস), রোল দেখে গেট করা হয়; মডারেটর শুধু রিপোর্ট ট্যাব পান।

### রোলের নিয়ম (কোডে প্রয়োগ করা)
| কাজ | কে পারেন |
|---|---|
| সবকিছু, রোল বদলানো, **ব্যান** | শুধু **super_admin** |
| ইউজার suspend/restore, ক্রেডিট, প্যাকেজ, পেমেন্ট, মডেল, কনটেন্ট, সেটিংস, অ্যানালিটিক্স | admin + super_admin |
| গ্যালারি মডারেশন (রিপোর্ট, লুকান/দেখান, সমাধান) | moderator + admin + super_admin |
| নিজের রোল/অবস্থা নিজে বদলানো | কেউ না (400) |

- প্রতিটি অ্যাডমিন কাজে `audit_logs` রো লেখা হয়; অডিট ব্যর্থ হলেও মূল অনুরোধ ভাঙে না।
- মডেল আপডেট: শুধু রেজিস্ট্রিতে থাকা মডেল — অজানা id-তে **404 MODEL_NOT_FOUND** (বানিয়ে মডেল যোগ করা যায় না); `config/models.json`-এ atomic লেখা (temp ফাইল + rename); `enabled` boolean ও `credit_cost` ≥ ০ পূর্ণসংখ্যা যাচাই করা হয়। মডেল id-তে slash থাকে বলে রুট wildcard (`/api/admin/models/*`)।
- কনটেন্ট CRUD-এ কলামের allow-list আছে — ক্লায়েন্টের পাঠানো কলাম নাম কখনো SQL-এ যায় না।
- সেটিংস: শুধু পরিচিত key বদলানো যায় (bKash/Nagad নম্বর, বোনাস, retention, নির্দেশনা…); value JSONB-তে রাখা হয়।
- **অ্যানালিটিক্স — রেকর্ড করা বনাম অনুমান আলাদা:** আয় = শুধু approved পেমেন্টের যোগফল (BDT, রেকর্ড করা); Higgsfield খরচ = `api_usage` যোগফল (USD, রেকর্ড করা); লাভ = **অনুমান মাত্র** — USD-কে ১২০৳ (আনুমানিক হার, নামসহ) ধরে রূপান্তর, উত্তরে `estimated_profit` নামে ও নোটসহ দেওয়া হয়।

## ৪. টেস্ট ফলাফল (২৬ নভেম্বর ২০২৬, যাচাই করা)

### A. আইসোলেটেড টেস্ট — `npm test` (DB ছাড়া)
**মোট ৪৬টি পাস, ০টি ফেল** (আগের ১৭টি অথ টেস্ট + নতুন ২৯টি), যার মধ্যে:
- লেজার গণিত: ব্যালেন্সের বেশি কাটলে `INSUFFICIENT_CREDITS`, ঠিক ব্যালেন্স কাটলে ০ হয় (নেগেটিভ নয়), ভগ্নাংশ বাতিল।
- Idempotency: একই key একই ফল দেয়; refund key `refund:<generation_id>`।
- পেমেন্ট ভ্যালিডেশন: সঠিক bkash ইনপুট, `+88` নম্বর normalise, ভুল মাধ্যম/ছোট Trx ID/ভুল মোবাইল/প্যাকেজ ছাড়া — সব বাতিল।
- সার্ভার-সাইড দাম: ব্রাউজারের amount উপেক্ষা করে প্যাকেজ রো-ই দামের উৎস; অজানা প্যাকেজে null।
- মেয়াদ গণিত: ৩০ দিনের retention, ৩ দিনের মধ্যে শেষ হলে `expiring_soon`, মেয়াদোত্তীর্ণে `expired`; তালিকার উত্তরে `result_url` ফাঁস হয় না।
- মডেল/প্যাকেজ ভ্যালিডেশন: অজানা মডেল 404, নেগেটিভ খরচ বাতিল, ভুল ধরন/দাম বাতিল।
- Migration 003-এ শুধু `deleted_at`, কোনো DROP নেই; রানার 001–003 চালায়; নতুন পেজগুলোতে কোনো সিক্রেট/হার্ডকোড পেমেন্ট নম্বর নেই।

### B. লাইভ সার্ভার টেস্ট (পোর্ট 3103/3104, JWT_SECRET শুধু টেস্টের জন্য, DATABASE_URL নেই)
| চেক | ফলাফল |
|---|---|
| `GET /api/health` | ✅ 200 — version 0.3.0, database: not_configured, higgsfield: not_configured |
| `GET /api/packages` (DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` — ভুয়া প্যাকেজ নয় |
| `GET /api/creations` (টোকেন ছাড়া) | ✅ 401 `UNAUTHORIZED` |
| `GET /api/creations` (ভুল টোকেন) | ✅ 401 `INVALID_TOKEN` |
| `POST /api/payments` (টোকেন ছাড়া) | ✅ 401 `UNAUTHORIZED` |
| `GET /api/admin/analytics` (টোকেন ছাড়া) | ✅ 401 `UNAUTHORIZED` |
| `GET /api/admin/analytics` (বৈধ super_admin JWT, DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` — নোট: Phase 4-এর `requireAuth` DB ছাড়া সব অথ রুটে 503 দেয়, তাই রোল চেক (403) DB ছাড়া যাচাই করা যায় না; DB এলে আবার টেস্ট করতে হবে |
| `GET /api/creations`, `/api/credits` (বৈধ JWT, DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` |
| `GET /api/admin/models` (বৈধ JWT, DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` — মডেল তথ্য ফাইলে থাকলেও অথের জন্য DB লাগে (Phase 4 ডিজাইন) |
| `POST /api/generate` (টোকেন ছাড়া) | ✅ 401 (Phase 8-এ আসবে) |
| পেজ: dashboard / payments / pricing / admin / login | ✅ সব 200 |
| `npm run migrate` (DATABASE_URL ছাড়া) | ✅ সৎভাবে ব্যর্থ, exit code 1, কিছুই বদলায়নি |
| টেস্ট সার্ভার | ✅ বন্ধ করা হয়েছে, পোর্ট ফাঁকা যাচাই করা হয়েছে |

### C. পরীক্ষার সময় ধরা পড়া ভুল ও ঠিক করা
1. টেস্ট স্ক্রিপ্টে শেলের `&` ব্যবহারে কমান্ড ভুল ডিরেক্টরি থেকে চলেছিল — টোকেন বানানো ও migrate ভুলভাবে ব্যর্থ হয়েছিল। কারণ চিহ্নিত করে সঠিক ডিরেক্টরি থেকে আবার চালিয়ে যাচাই করা হয়েছে (উপরের টেবিল সেই দ্বিতীয় রানের ফল)।
2. `pkill -f "node server.js"` নিজের শেলের কমান্ড লাইনের সাথে মিলে শেলকে মেরে ফেলছিল — পরে `process.kill` (session id) দিয়ে সার্ভার বন্ধ করা হয়েছে, পোর্ট ফাঁকা যাচাই করা হয়েছে।
3. `server/admin.js`-এ একটি বাংলা বাক্যে ভাঙা অক্ষর ছিল (`রিপোর্ট` শব্দে) — ঠিক করা হয়েছে, `node --check` পাস করেছে।

## ৫. এখনো বাকি — সৎ তালিকা (BLOCKED, ভুয়া সফলতা নয়)

1. **লাইভ DB টেস্ট হয়নি** — Supabase `DATABASE_URL` নেই বলে আসল ফ্লো চালানো যায়নি: রেজিস্টার → ক্রিয়েশন তালিকা, পেমেন্ট জমা → অ্যাডমিন approve → ক্রেডিট যোগ + সাবস্ক্রিপশন, reject → কোনো ক্রেডিট নয়, ডুপ্লিকেট Trx ID 409, ব্যর্থ জেনারেশনে রিফান্ড একবারই, ban শুধু super_admin (403), moderator শুধু গ্যালারি (অন্য অ্যাডমিন রুটে 403)। Supabase পেলে প্রথমে `npm run migrate` (001–003), তারপর এই ফ্লোগুলো আবার টেস্ট করতে হবে।
2. **মাইগ্রেশন চালানো হয়নি** — 003 সহ কোনো migration Supabase-এ চালানো যায়নি (অ্যাকাউন্ট নেই)।
3. **পেমেন্ট নম্বর বসানো হয়নি** — bKash/Nagad নম্বর settings-এ খালি; অ্যাডমিনকে সেটিংস থেকে বসাতে হবে (কোডে নয়)।
4. **প্যাকেজ এডিটর UI** — অ্যাডমিন পেজে প্যাকেজ চালু/বন্ধ করা যায়; দাম/ক্রেডিট বদলাতে আপাতত API (PUT) ব্যবহার করতে হয় — UI এডিটর Phase 10-এ।
5. **Generation / Phase 8** — `/api/generate` এখনো 501; রিফান্ডের আসল ট্রিগার (ব্যর্থ জব) Phase 8-এ যুক্ত হবে।

## ৬. মালিককে যা করতে হবে (একবারে এক ধাপ)

1. **Supabase অ্যাকাউন্ট** খুলে প্রজেক্ট বানান → SQL Editor-এ 001 + 002 + 003 চালান (বা `npm run migrate`) → `DATABASE_URL` নিন। — এটাই এখন সবচেয়ে জরুরি ধাপ। (নোট: GitHub অ্যাকাউন্ট তিনি ২০২৬-১১-২৬ রাত ১০:০৬-এ খুলেছেন বলে MEMORY-তে লেখা আছে — পরের ধাপ রিপোজিটরি বানানো।)
2. তারপর Render-এ ডেপ্লয় (README ধাপ ৩)।
3. পাসওয়ার্ড, OTP, API Key — কিছুই চ্যাটে দেবেন না।

## ৭. ফাইল তালিকা

- `server/creations.js` — My Creations (তালিকা/বিস্তারিত/ডাউনলোড/মোছা/সাবস্ক্রিপশন)
- `server/credits.js` — ক্রেডিট লেজার (কাটা/যোগ/রিফান্ড, idempotency, নেগেটিভ নয়)
- `server/payments.js` — প্যাকেজ, নির্দেশনা, পেমেন্ট জমা/ইতিহাস, approve/reject ট্রানজাকশন
- `server/admin.js` — অ্যাডমিন (ইউজার/ক্রেডিট/প্যাকেজ/পেমেন্ট/মডেল/কনটেন্ট/গ্যালারি/সেটিংস/অ্যানালিটিক্স)
- `server/settings.js` — settings (JSONB) পড়ার হেল্পার
- `server.js` — v0.3.0, Phase 5–7 রুট
- `db/migrations/003_phase57.sql` — `generations.deleted_at` (soft-delete)
- `db/run-migrations.js` — এখন 001–003 চালায়
- `public/dashboard.html` — আসল creations + লেজার + সাবস্ক্রিপশন
- `public/payments.html`, `public/pricing.html`, `public/admin.html` — নতুন পেজ
- `test/credits-payments.test.js` — আইসোলেটেড টেস্ট (২৯টি)
- `package.json` — v0.3.0, `test` এখন দুটি ফাইল চালায়
- `PHASE5-7-REPORT.md` — এই প্রতিবেদন
