# Suman AI Studio — README (বাংলা, Android-বান্ধব)

> **এখন কী অবস্থা:** **ভার্সন 1.0.0-beta — ১২টি Phase-র কোড সম্পূর্ণ।** অথ, ড্যাশবোর্ড, My Creations, ক্রেডিট লেজার, bKash/Nagad ম্যানুয়াল পেমেন্ট, অ্যাডমিন ড্যাশবোর্ড, Higgsfield জেনারেশন ফ্লো, গ্যালারি, রেফারেল, নোটিফিকেশন, সাপোর্ট, সিকিউরিটি — সব কোড লেখা ও আইসোলেটেড টেস্টে পাস (**`npm test`: ১০৭ পাস, ০ ফেল**)। **কিন্তু এখনো ডেপ্লয় হয়নি** — লাইভ DB, Higgsfield Key, Supabase Storage ছাড়া আসল জেনারেশন/পেমেন্ট চলবে না। বিস্তারিত: `PHASE8-12-REPORT.md`, `TESTING.md`, `SECURITY.md`, `DEPLOYMENT-CHECKLIST.md`।

## ১. যা যা লাগবে

| জিনিস | কীসের জন্য | খরচ | অবস্থা |
|---|---|---|---|
| GitHub অ্যাকাউন্ট | কোড রাখা + Render-এ ডেপ্লয় | ফ্রি | ✅ আপনার অ্যাকাউন্ট আছে (`sumonaistudio`) — রিপোজিটরি বানানো বাকি |
| Supabase অ্যাকাউন্ট | ডেটাবেস (Postgres) + পরে Storage | ফ্রি | ⏳ বাকি — **এটাই এখন সবচেয়ে জরুরি ধাপ** |
| Render অ্যাকাউন্ট | ওয়েবসাইট চালানো | ফ্রি (ঘুমায়) | ⏳ বাকি |
| Higgsfield অ্যাকাউন্ট | ছবি/ভিডিও বানানো | **পেইড — প্রতি জেনারেশনে ডলার** | ⏳ বাকি |
| Resend অ্যাকাউন্ট | ইমেইল (পাসওয়ার্ড রিসেট) | ফ্রি (৩,০০০/মাস) | ⏳ বাকি (ঐচ্ছিক, কিন্তু জরুরি) |
| Google Cloud অ্যাকাউন্ট | Google Login (পরে) | ফ্রি | ⏳ বাকি (ঐচ্ছিক) |

## ২. ধাপ ১ — কোড GitHub-এ তোলা (ফোন থেকেও করা যায়)

1. ফোনে GitHub অ্যাপ খুলে নতুন repository বানান: নাম `suman-ai-studio`, **Private** রাখুন।
2. `suman-ai-studio-final.zip` খুলে সব ফাইল রিপোতে আপলোড করুন।
3. রিপোতে `.gitignore` ফাইল আছে কি না দেখুন — না থাকলে এই দুই লাইন দিয়ে বানান:
   ```
   node_modules/
   .env
   ```
4. **সতর্কতা:** `.env` ফাইল কখনো GitHub-এ তুলবেন না — সিক্রেট ফাঁস হবে।

## ৩. ধাপ ২ — ডেটাবেস (Supabase, ফ্রি)

1. https://supabase.com-এ অ্যাকাউন্ট খুলে **New Project** বানান।
2. **SQL Editor** খুলে এই ৫টি ফাইল পরপর পেস্ট করে **Run** চাপুন:
   `db/migrations/001_init.sql` → `002_seed.sql` → `003_phase57.sql` → `004_phase8.sql` → `005_phase9.sql`
   (অথবা কম্পিউটারে `.env`-এ `DATABASE_URL` বসিয়ে `npm run migrate` চালান।)
3. **Settings → Database → Connection string** থেকে `DATABASE_URL` কপি করে রাখুন।
4. যাচাই: Table Editor-এ `users`, `credit_ledger`, `packages`, `payments`, `generations` টেবিল দেখা যাচ্ছে কি না।

## ৩ক. ধাপ ২ক — Google Login (পরে, ঐচ্ছিক)

Google Login এখনো কোডে চালু হয়নি — ইচ্ছাকৃতভাবে 501 stub রাখা হয়েছে, কারণ এতে মালিকের Google Cloud সেটআপ লাগে:
1. https://console.cloud.google.com/apis/credentials-এ প্রজেক্ট বানান।
2. **Create Credentials → OAuth client ID → Web application** বানান।
3. Authorized redirect URI-তে আপনার সাইটের ঠিকানা + `/api/auth/google/callback` বসান (যেমন `https://suman-ai-studio.onrender.com/api/auth/google/callback`)।
4. Client ID ও Client Secret Render Environment-এ `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` হিসেবে বসান।
5. তারপর Google লগইনের কোড লেখা হবে — তার আগে `/api/auth/google` 501 `GOOGLE_OAUTH_NOT_CONFIGURED` দেবে, ভুয়া লগইন নয়।

## ৪. ধাপ ৩ — Render-এ চালু করা (ফ্রি)

1. https://render.com-এ GitHub দিয়ে লগইন করুন।
2. **New → Web Service** → `suman-ai-studio` রিপোজিটরি বেছে নিন (অথবা `render.yaml` Blueprint ব্যবহার করুন)।
3. Build Command `npm install`, Start Command `node server.js`।
4. **Environment**-এ এগুলো বসান:
   - `DATABASE_URL` = ধাপ ২-এর connection string
   - `JWT_SECRET` = লম্বা এলোমেলো একটি লেখা (৩২+ অক্ষর, নিজে বানান, কাউকে দেবেন না)
   - `NODE_ENV` = `production`
   - `PUBLIC_URL` = আপনার Render ঠিকানা (যেমন `https://suman-ai-studio.onrender.com`)
5. Deploy শেষে `https://<আপনার-ঠিকানা>/api/health` খুলে দেখুন — `database: connected` আসতে হবে।

> ⚠️ **Render ফ্রি-র আসল সীমা:** ১৫ মিনিট কেউ না এলে সার্ভার ঘুমিয়ে যায়, পরের ভিজিটে ~১ মিনিট লাগে। ফাইল সিস্টেম অস্থায়ী — আপলোড করা ফাইল হারিয়ে যাবে, তাই আসল ফাইল Supabase Storage-এ রাখতে হবে (এখনো চালু হয়নি — 501)।

## ৫. ধাপ ৪ — প্রথম Super Admin বানানো

1. সাইটে **Register** দিয়ে নিজের অ্যাকাউন্ট খুলুন।
2. Supabase **SQL Editor**-এ এই লাইন চালান (নিজের ইমেইল বসিয়ে):
   ```sql
   UPDATE users SET role = 'super_admin' WHERE email = 'আপনার-ইমেইল@example.com';
   ```
3. লগইন করে `/admin.html` খুলুন — Analytics দেখা গেলে ঠিক আছে।
4. অ্যাডমিন সেটিংস থেকে **bKash ও Nagad নম্বর + নির্দেশনা** বসান (কোডে নয়)।

## ৬. ধাপ ৫ — Higgsfield Key (সবচেয়ে গুরুত্বপূর্ণ সত্য)

- Higgsfield **ফ্রি নয়** — API ব্যবহারে প্রিপেইড ডলার ব্যালেন্স লাগে (সর্বনিম্ন টপ-আপ $৫)।
- সাবস্ক্রিপশনের ক্রেডিট দিয়ে **API চলে না** — API-র আলাদা ব্যালেন্স।
- Key ছাড়া সাইট চলবে, কিন্তু জেনারেশন বোতামে স্পষ্ট বার্তা আসবে: "Higgsfield সংযুক্ত হয়নি" — কোনো ক্রেডিট কাটা হবে না।
- Key কখনো চ্যাটে, ফোনে, বা কোডে লিখবেন না — শুধু Render-এর Environment-এ `HIGGSFIELD_API_KEY` = `KEY_ID:KEY_SECRET` আকারে বসান।

## ৭. কম্পিউটারে চালানো (টেস্টের জন্য)

```bash
npm install
cp .env.example .env   # তারপর .env-এ নিজের মান বসান (আসল মান কখনো GitHub-এ নয়)
npm run migrate        # DATABASE_URL থাকলে 001 → 005 মাইগ্রেশন চালাবে
npm test               # DB ছাড়া আইসোলেটেড টেস্ট — ১০৭টি চেক
node server.js         # http://localhost:3000 খুলুন
```

## ৮. নিরাপত্তা নিয়ম

- পাসওয়ার্ড, OTP, API Key — কাউকে চ্যাটে দেবেন না, আমাকেও না।
- `.env` ফাইল কখনো GitHub-এ তুলবেন না।
- bKash/Nagad নম্বর বদলাতে চাইলে অ্যাডমিন ড্যাশবোর্ড থেকে বদলাবেন, কোডে নয়।
- সাইট চালুর পর `/api/admin/security` খুলে দেখুন — কোনো `fail` থাকলে ঠিক না করে চালাবেন না।

## ৯. কী কী তৈরি হয়েছে (সংক্ষেপে)

| Phase | কাজ | অবস্থা |
|---|---|---|
| 1 | বিশ্লেষণ + আর্কিটেকচার + স্ক্যাফোল্ড | ✅ |
| 2 | সিড ডেটা + মাইগ্রেশন রানার | ✅ |
| 3 | ফ্রন্টএন্ড (লগইন/রেজিস্টার/ড্যাশবোর্ড/জেনারেট) | ✅ |
| 4 | অথ (bcrypt, JWT, রিসেট; Google 501 stub) | ✅ |
| 5 | My Creations + ৩০ দিনের retention | ✅ |
| 6 | ক্রেডিট লেজার + bKash/Nagad ম্যানুয়াল পেমেন্ট | ✅ |
| 7 | অ্যাডমিন ড্যাশবোর্ড (রোল-ভিত্তিক) | ✅ |
| 8 | Higgsfield জেনারেশন ফ্লো + রিফান্ড + ওয়াটারমার্ক নিয়ম | ✅ |
| 9 | গ্যালারি, রেফারেল, নোটিফিকেশন, সাপোর্ট, টেমপ্লেট | ✅ |
| 10 | সিকিউরিটি + টেস্টিং (১০৭ টেস্ট) | ✅ |
| 11 | পারফরম্যান্স + মোবাইল (ক্যাশিং, viewport) | ✅ (আসল ফোনে যাচাই বাকি) |
| 12 | ডেপ্লয় প্রস্তুতি (এই গাইড + চেকলিস্ট) | ✅ |

**সৎ সীমা:** "production-ready" বলা হচ্ছে না — এটা **1.0.0-beta**: কোড সম্পূর্ণ, কিন্তু লাইভ DB, Higgsfield Key, Storage, Resend, Google OAuth ছাড়া আসল সাইট চলবে না। সেগুলো বসানোর পর `TESTING.md`-এর লাইভ টেস্টগুলো আবার চালাতে হবে।
