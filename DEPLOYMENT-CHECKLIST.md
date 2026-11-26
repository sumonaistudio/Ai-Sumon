# Suman AI Studio — ডেপ্লয়মেন্ট চেকলিস্ট (DEPLOYMENT-CHECKLIST.md)

**ভার্সন:** 1.0.0-beta (কোড সম্পূর্ণ, ডেপ্লয় বাকি) | **তারিখ:** ২৬ নভেম্বর ২০২৬
প্রতিটি ধাপ শেষ হলে টিক দিন। কোনো ধাপ "হয়ে গেছে" বলবেন না, যতক্ষণ না তার পাশের যাচাইটি পাস করে।

## ধাপ ০ — এই ফাইলগুলো তৈরি আছে কি না

- [ ] `suman-ai-studio-final.zip` ডাউনলোড করা হয়েছে (সব কোড + ডকস)
- [ ] `PHASE8-12-REPORT.md` পড়া হয়েছে — কী তৈরি, কী BLOCKED, তা জানা আছে

## ধাপ ১ — GitHub রিপোজিটরি ✅ (আপনি অ্যাকাউন্ট খুলেছেন: `sumonaistudio`)

- [ ] github.com-এ লগইন → **New repository** → নাম `suman-ai-studio` → **Private** → Create
- [ ] zip খুলে সব ফাইল রিপোতে আপলোড করা হয়েছে (GitHub ওয়েবে "uploading an existing file" বা GitHub Desktop/অ্যাপ দিয়ে)
- [ ] `.gitignore` ফাইল আছে কি না দেখুন — না থাকলে রিপোতে এই দুই লাইন দিয়ে `.gitignore` বানান:
  ```
  node_modules/
  .env
  ```
- [ ] যাচাই: রিপোতে `.env` ফাইল নেই (থাকলে সাথে সাথে মুছে ফেলুন — সিক্রেট ফাঁস হবে)

## ধাপ ২ — Supabase ডেটাবেস (সবচেয়ে জরুরি)

- [ ] https://supabase.com-এ অ্যাকাউন্ট খুলে **New Project** বানানো হয়েছে
- [ ] **SQL Editor** খুলে `db/migrations/001_init.sql` → `002_seed.sql` → `003_phase57.sql` → `004_phase8.sql` → `005_phase9.sql` — পরপর ৫টি ফাইলের পুরো লেখা পেস্ট করে **Run** চাপা হয়েছে (অথবা কম্পিউটারে `npm run migrate`)
- [ ] যাচাই: Table Editor-এ `users`, `credit_ledger`, `packages`, `payments`, `generations`, `gallery_items` টেবিল দেখা যাচ্ছে
- [ ] **Settings → Database → Connection string** (URI) থেকে `DATABASE_URL` কপি করে রাখা হয়েছে
- [ ] যাচাই: `packages` টেবিলে ৬টি প্যাকেজ, `settings`-এ বোনাস ১০০ / রেফারেল ৫০ দেখা যাচ্ছে

## ধাপ ৩ — Render-এ চালু করা

- [ ] https://render.com-এ GitHub দিয়ে লগইন করা হয়েছে
- [ ] **New → Web Service** → `suman-ai-studio` রিপোজিটরি বেছে নেওয়া হয়েছে (অথবা `render.yaml` Blueprint)
- [ ] Build Command: `npm install`, Start Command: `node server.js` — ঠিক আছে
- [ ] **Environment**-এ এগুলো বসানো হয়েছে:
  - [ ] `DATABASE_URL` = ধাপ ২-এর connection string
  - [ ] `JWT_SECRET` = লম্বা এলোমেলো লেখা (৩২+ অক্ষর, নিজে বানান)
  - [ ] `NODE_ENV` = `production`
  - [ ] `PUBLIC_URL` = আপনার Render ঠিকানা (যেমন `https://suman-ai-studio.onrender.com`)
- [ ] Deploy সফল হয়েছে (লগে কোনো error নেই)
- [ ] যাচাই: সাইট খুলে `https://<আপনার-ঠিকানা>/api/health` — `{"ok":true, "database":{"status":"connected"...}}` দেখাচ্ছে

## ধাপ ৪ — প্রথম Super Admin বানানো

- [ ] সাইটে গিয়ে **Register** দিয়ে নিজের অ্যাকাউন্ট খুলেছেন
- [ ] Supabase **SQL Editor**-এ এই লাইন চালিয়েছেন (নিজের ইমেইল বসিয়ে):
  ```sql
  UPDATE users SET role = 'super_admin' WHERE email = 'আপনার-ইমেইল@example.com';
  ```
- [ ] যাচাই: লগইন করে `/admin.html` খুলছে, Analytics দেখা যাচ্ছে
- [ ] অ্যাডমিন সেটিংস থেকে bKash ও Nagad নম্বর + নির্দেশনা বসানো হয়েছে (কোডে নয়)

## ধাপ ৫ — Higgsfield (জেনারেশন চালু করতে)

- [ ] https://open.higgsfield.ai/-এ অ্যাকাউন্ট খুলে API Key (`KEY_ID:KEY_SECRET`) বানানো হয়েছে
- [ ] ব্যালেন্সে টাকা ভরা হয়েছে (সর্বনিম্ন $৫ — **এটা পেইড, ফ্রি নয়**)
- [ ] Render Environment-এ `HIGGSFIELD_API_KEY` = `KEY_ID:KEY_SECRET` বসানো হয়েছে (চ্যাটে/কোডে নয়)
- [ ] যাচাই: `/api/higgsfield/status` — `{"status":"configured"...}` দেখাচ্ছে
- [ ] যাচাই: ১টি ছোট টেস্ট জেনারেশন (Soul 2, ২ ক্রেডিট) করে My Creations-এ ফল দেখা গেছে

## ধাপ ৬ — ইমেইল (Resend, ঐচ্ছিক কিন্তু জরুরি)

- [ ] https://resend.com-এ অ্যাকাউন্ট খুলে API Key নেওয়া হয়েছে
- [ ] Render Environment-এ `RESEND_API_KEY` + `EMAIL_FROM` বসানো হয়েছে
- [ ] যাচাই: Forgot Password দিয়ে নিজের ইমেইলে রিসেট মেইল এসেছে

## ধাপ ৭ — শেষ যাচাই (লাইভে)

- [ ] রেজিস্টার → লগইন → ১০০ বোনাস ক্রেডিট দেখা যাচ্ছে
- [ ] একটি পেমেন্ট জমা দিয়ে অ্যাডমিন approve → ক্রেডিট যোগ হয়েছে
- [ ] একটি জেনারেশন সম্পূর্ণ হয়েছে, My Creations-এ দেখা যাচ্ছে
- [ ] `/api/admin/security` খুলে কোনো `fail` নেই
- [ ] **ব্যাকআপ:** Supabase-এ নিয়মিত (সপ্তাহে ১ বার) SQL dump নেওয়ার কথা মনে রাখবেন — ফ্রি প্ল্যানে স্বয়ংক্রিয় ব্যাকআপ নেই

## এখনো বাকি (ডেপ্লয়ের পরের কাজ)

- [ ] Google Login চালু করা (Google Cloud OAuth Client বানিয়ে — README ধাপ ৩ক)
- [ ] Supabase Storage চালু করে রেফারেন্স আপলোড খোলা (এখন 501)
- [ ] নিজের ফোনে (Android) সব পেজ খুলে দেখা — মোবাইল যাচাই এখনো হয়নি
