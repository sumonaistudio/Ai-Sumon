# Suman AI Studio — Phase 2–4 প্রতিবেদন

**তারিখ:** ২৬ নভেম্বর ২০২৬ | **অবস্থা:** Phase 2–4 সম্পূর্ণ (কোড + টেস্ট) — লাইভ DB টেস্ট বাকি
**নিয়ম:** Phase 1-এর স্ট্যাক অপরিবর্তিত — Node + Express মনোলিথ, Postgres (Supabase) + `pg` + plain SQL, Static HTML + Tailwind CDN, কোনো build step নেই, Prisma/React নেই।

---

## ১. Phase 2 — ডেটাবেস সিড + মাইগ্রেশন রানার

### যা বানানো হয়েছে
- `db/migrations/002_seed.sql` — শুধু সিড ডেটা, কোনো আসল ইউজার/পাসওয়ার্ড/সিক্রেট নেই:
  - **Settings:** সাইনআপ বোনাস ১০০ ক্রেডিট, রেফারেল বোনাস ৫০, retention ৩০ দিন, bKash/Nagad নম্বর খালি (অ্যাডমিন পরে বসাবেন), সাইটের নাম।
  - **Packages (৬টি):** স্টার্টার ১০০৳/৫০ ক্রেডিট, জনপ্রিয় ২৫০৳/১৫০, প্রো ৫০০৳/৩৫০, স্টুডিও ১০০০৳/৮০০, মাসিক ৪৯৯৳/৩০০, বার্ষিক ৪৯৯০৳/৪০০০। USD দাম ১ USD ≈ ১২০ BDT ধরে আনুমানিক — চূড়ান্ত দাম অ্যাডমিন ঠিক করবেন।
  - **Templates (৫টি):** সিনেমাটিক পোর্ট্রেট, বাংলার গ্রাম, সিনেমাটিক দৃশ্য, ছবি-থেকে-ভিডিও (হাঁটা / প্রকৃতি)।
  - **FAQ (৫টি) + Announcement (১টি)** — বাংলা ও ইংরেজি।
  - সব INSERT `ON CONFLICT DO NOTHING` — দুবার চালালেও ডুপ্লিকেট হবে না।
- `db/run-migrations.js` — `npm run migrate` দিয়ে 001 → 002 পরপর চালায়।

### সৎ আচরণ
- `DATABASE_URL` না থাকলে রানার স্পষ্টভাবে ব্যর্থ হয় (exit code 1, "No migration was run") — ভুয়া সফলতা নয়। টেস্টে এটাই দেখা গেছে।

## ২. Phase 3 — ফ্রন্টএন্ড

| পেজ | কাজ |
|---|---|
| `public/login.html` | লগইন ফর্ম + পাসওয়ার্ড-ভুলে-গেছেন ফর্ম; সফল হলে টোকেন রেখে ড্যাশবোর্ডে যায় |
| `public/register.html` | রেজিস্টার ফর্ম (নাম, ইমেইল, পাসওয়ার্ড ≥৮, ঐচ্ছিক রেফারেল কোড); বোনাস ক্রেডিট দেখায় |
| `public/reset-password.html` | ইমেইলের লিংক থেকে নতুন পাসওয়ার্ড বসানোর পেজ |
| `public/dashboard.html` | `/api/auth/me` থেকে প্রোফাইল, ক্রেডিট ব্যালেন্স, রোল, অবস্থা, রেফারেল কোড; My Creations এখনো Phase 5-এর — সৎ বার্তা দেখায় |
| `public/generate.html` | `/api/models` থেকে আসল মডেল তালিকা, মডেল বাছলে আনুমানিক ক্রেডিট খরচ, প্রম্পট, রেফারেন্স ফাইল বাছাই (আপলোড Phase 8-এ); সাবমিট করলে `/api/generate` 501 দেয় — ভুয়া সফলতা নয় |
| `public/index.html` | হেডারে লগইন/রেজিস্টার লিংক যোগ করা হয়েছে |

সব পেজ: মোবাইল-ফার্স্ট, Dark/Light টগল (localStorage-এ মনে রাখে), বাংলা/ইংরেজি টগল, সার্ভারের আসল উত্তর দেখায়। ফ্রন্টএন্ডে কোনো সিক্রেট নেই — টোকেন শুধু `localStorage`-এ থাকে।

## ৩. Phase 4 — ব্যাকএন্ড অথ

### নতুন ফাইল
- `server/auth.js` — রেজিস্টার, লগইন, লগআউট, forgot/reset, `/me`, `requireAuth`, `requireRole`, audit লগ।
- `server/mail.js` — Resend দিয়ে ইমেইল পাঠানো; Key না থাকলে `{ sent: false, reason: 'EMAIL_NOT_CONFIGURED' }` ফেরত দেয়।
- `server/db.js` — `withTransaction()` যোগ হয়েছে (রেজিস্টার + বোনাস একই ট্রানজাকশনে)।

### নিয়ম (কোডে প্রয়োগ করা)
- পাসওয়ার্ড **bcryptjs, 10 rounds** — plain-text কখনো সংরক্ষণ হয় না।
- রেজিস্টার: ইমেইল ডুপ্লিকেট হলে **409 EMAIL_ALREADY_REGISTERED**; রেফারেল কোড ভুল হলে **400 INVALID_REFERRAL_CODE**।
- সাইনআপ বোনাস: `settings.signup_bonus_credits` থেকে নেওয়া হয় (ডিফল্ট ১০০); ইউজার তৈরি + `credit_ledger` রো **একই ট্রানজাকশনে**, `idempotency_key = signup-bonus:<user_id>` — ডুপ্লিকেট ক্রেডিট অসম্ভব।
- রেফারেল কোড: ৮ অক্ষর, বিভ্রান্তিকর অক্ষর (0/O/1/I/l) বাদ; রেফারেল রো তৈরি হয়, কিন্তু বোনাস **শুধু শর্ত পূরণ হলে** (Phase 9) — এখন `bonus_granted = FALSE`।
- লগইন: JWT **৭ দিনের** মেয়াদ; ভুল পাসওয়ার্ডে 401; suspended/banned অ্যাকাউন্টে 403।
- লগআউট: JWT stateless — ক্লায়েন্ট টোকেন মুছে ফেলাই আসল লগআউট; সার্ভার সেটা স্পষ্টভাবে জানায়।
- Forgot-password: টোকেন **sha256 হ্যাশ** করে রাখা হয়, একবার ব্যবহারযোগ্য, মেয়াদ ১ ঘণ্টা। টোকেন **কোনো API উত্তরে দেওয়া হয় না** (development-এও না); ইমেইল না থাকলে dev-এ শুধু **সার্ভার কনসোলে** লিংক ছাপা হয়, production-এ কনসোলেও নয়। অ্যাকাউন্ট থাকুক বা না থাকুক — একই উত্তর (অ্যাকাউন্ট খোঁজা যায় না)।
- রেট লিমিট: অথ রুটে **১৫ মিনিটে ১০ বার** — তারপর 429।
- Audit: `auth.register / auth.login / auth.forgot_password / auth.reset_password` — `audit_logs`-এ লেখা হয় (DB থাকলে); audit ব্যর্থ হলে মূল অনুরোধ ভাঙে না।
- **Google OAuth ইচ্ছাকৃতভাবে করা হয়নি:** `/api/auth/google` ও `/callback` — **501 GOOGLE_OAUTH_NOT_CONFIGURED**, সেটআপ নির্দেশনা README-তে। মালিকের Google Cloud OAuth Client লাগবে।

### server.js-এ বদল
- ভার্সন 0.2.0, phase লেবেল "Phase 2-4"।
- `/api/auth/*` আসল রুট; `/api/generate`, `/api/creations`, `/api/admin/*` এখনো 501 (Phase 5/7/8) — তবে `/api/admin/*`-এ এখন `requireAuth + requireRole(admin, super_admin)` চেক আছে।

## ৪. টেস্ট ফলাফল (২৬ নভেম্বর ২০২৬, যাচাই করা)

### A. আইসোলেটেড টেস্ট — `npm test` (`test/auth-isolated.test.js`, DB ছাড়া)
**১৭টি পাস, ০টি ফেল**, যার মধ্যে:
- bcrypt: হ্যাশ plain-text নয়, সঠিক পাসওয়ার্ড মেলে, ভুল পাসওয়ার্ড মেলে না
- JWT: sign → verify মেলে, মেয়াদ ঠিক ৭ দিন, ভুল সিক্রেটে verify ব্যর্থ
- ভ্যালিডেশন: ভুল ইমেইল ও ৮ অক্ষরের কম পাসওয়ার্ড বাতিল; ভালো ইনপুট গৃহীত, ইমেইল lowercase হয়
- রেফারেল কোড: ২০০টি নমুনা — সব ৮ অক্ষর, সঠিক charset, সব আলাদা
- `publicUser` থেকে `password_hash` / `reset_token_hash` ফাঁস হয় না
- Resend Key ছাড়া `EMAIL_NOT_CONFIGURED`; Higgsfield Key ছাড়া not configured
- 002_seed.sql-এ প্যাকেজ/টেমপ্লেট/FAQ আছে, কোনো পাসওয়ার্ড নেই

### B. মাইগ্রেশন রানার — `npm run migrate` (DATABASE_URL ছাড়া)
- ✅ **সৎভাবে ব্যর্থ:** `[migrate] FAILED — DATABASE_URL is not set`, exit code 1, কিছুই বদলায়নি।

### C. লাইভ সার্ভার টেস্ট (পোর্ট 3101/3102, JWT_SECRET শুধু টেস্টের জন্য)
| চেক | ফলাফল |
|---|---|
| `GET /api/health` | ✅ 200 — version 0.2.0, database: not_configured, higgsfield: not_configured |
| `GET /api/models` | ✅ 200 — যাচাই করা ৫টি মডেল |
| `POST /api/auth/register` (ভালো ইনপুট, DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` — ভুয়া সফলতা নয় |
| `POST /api/auth/register` (ভুল ইমেইল, DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` — নোট: DB চেক ভ্যালিডেশনের আগে হয়, তাই DB ছাড়া সব রেজিস্টারেই 503 আসে; ভ্যালিডেশন আলাদাভাবে আইসোলেটেড টেস্টে পাস করেছে |
| `POST /api/auth/login` (DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` |
| `POST /api/auth/forgot-password` (DB নেই) | ✅ 503 `DB_NOT_CONFIGURED` |
| `GET /api/auth/google` | ✅ 501 `GOOGLE_OAUTH_NOT_CONFIGURED` |
| `GET /api/auth/me` (টোকেন ছাড়া) | ✅ 401 `UNAUTHORIZED` |
| `GET /api/higgsfield/status` | ✅ 503 `HIGGSFIELD_NOT_CONFIGURED` |
| পেজ: login/register/dashboard/generate/reset-password | ✅ সব 200 |
| রেট লিমিট (১২ বার দ্রুত লগইন) | ✅ প্রথম ১০ বার 503, ১১তম থেকে **429 TOO_MANY_ATTEMPTS** |

## ৫. এখনো বাকি — সৎ তালিকা (BLOCKED, ভুয়া সফলতা নয়)

1. **লাইভ DB টেস্ট হয়নি** — Supabase অ্যাকাউন্ট + `DATABASE_URL` নেই বলে আসল রেজিস্টার → লগইন → বোনাস লেজার → forgot/reset পুরো ফ্লো চালানো যায়নি। Supabase পেলে প্রথমে `npm run migrate`, তারপর এই ফ্লোগুলো আবার টেস্ট করতে হবে (ডুপ্লিকেট ইমেইল 409, বোনাস একবারই, রিসেট টোকেন একবার ব্যবহার, মেয়াদোত্তীর্ণ টোকেন বাতিল)।
2. **Google OAuth** — মালিকের Google Cloud OAuth Client (ID + Secret) লাগবে; তারপর কোড লিখতে হবে।
3. **Resend ইমেইল** — Key + ডোমেইন যাচাই ছাড়া আসল রিসেট ইমেইল পাঠানো যায়নি; শুধু NOT_CONFIGURED পথ টেস্ট হয়েছে।
4. **My Creations / generate / admin** — Phase 5/7/8-এর কাজ, এখনো 501।

## ৬. মালিককে যা করতে হবে (একবারে এক ধাপ)

1. **Supabase অ্যাকাউন্ট** খুলে প্রজেক্ট বানান → SQL Editor-এ 001 + 002 চালান (বা `npm run migrate`) → `DATABASE_URL` নিন। — এটাই এখন সবচেয়ে জরুরি ধাপ।
2. তারপর Google Login চাইলে Google Cloud Console-এ OAuth Client বানান (README "Google Login" ধাপ দেখুন)।
3. পাসওয়ার্ড, OTP, API Key — কিছুই চ্যাটে দেবেন না।

## ৭. ফাইল তালিকা

- `db/migrations/002_seed.sql` — সিড ডেটা
- `db/run-migrations.js` — মাইগ্রেশন রানার (`npm run migrate`)
- `server/auth.js` — অথ (রেজিস্টার/লগইন/রিসেট/রোল/অডিট)
- `server/mail.js` — Resend ইমেইল মডিউল
- `server/db.js` — `withTransaction()` যোগ হয়েছে
- `server.js` — অথ রুট + Google 501 stub (v0.2.0)
- `public/login.html`, `public/register.html`, `public/reset-password.html`, `public/dashboard.html`, `public/generate.html` — নতুন/বাড়ানো পেজ
- `public/index.html` — লগইন/রেজিস্টার লিংক যোগ
- `test/auth-isolated.test.js` — আইসোলেটেড টেস্ট (`npm test`)
- `package.json` — v0.2.0, `migrate` ও `test` স্ক্রিপ্ট
- `README.md` — Phase 2–4 + Google Login সেটআপ ধাপ
- `PHASE2-4-REPORT.md` — এই প্রতিবেদন
