# Suman AI Studio — Phase 1 বিশ্লেষণ প্রতিবেদন

**তারিখ:** ২৬ নভেম্বর ২০২৬ | **অবস্থা:** Phase 1 সম্পূর্ণ — স্ক্যাফোল্ড তৈরি ও টেস্ট করা হয়েছে
**নিয়ম:** ✅ চিহ্নিত মানে অফিসিয়াল ডকস/সোর্স থেকে যাচাই করা। ⚠️ মানে সেকেন্ডারি সোর্স / সরাসরি যাচাই হয়নি। ❌ মানে ভুল প্রমাণিত — ব্যবহার করবেন না।

---

## ১. সুপারিশকৃত আর্কিটেকচার

```
ব্যবহারকারী (মোবাইল / ডেস্কটপ)
        │  HTTPS
        ▼
Render ফ্রি Web Service (Node.js + Express — একটাই সার্ভার)
   ├── public/            ল্যান্ডিং পেজ (Static HTML + Tailwind CDN)
   ├── server.js          API রাউট (auth, credits, payments, admin — ধাপে ধাপে)
   ├── server/higgsfield.js   Higgsfield API ক্লায়েন্ট (শুধু সার্ভার-সাইড)
   ├── server/db.js       Postgres সংযোগ (pg)
   └── config/models.json মডেল রেজিস্ট্রি (অ্যাডমিন এডিট করতে পারেন)
        │
        ├── Supabase Postgres (ফ্রি) — সব ডেটা: ইউজার, লেজার, পেমেন্ট, জব
        ├── Supabase Storage (ফ্রি, 1 GB) — আপলোড ও রেজাল্টের কপি
        ├── Higgsfield API (পেইড) — আসল ছবি/ভিডিও জেনারেশন
        └── Resend (ফ্রি) — ইমেইল (পাসওয়ার্ড রিসেট, নোটিফিকেশন)
```

**কেন একটাই সার্ভার (মনোলিথ)?** মালিকের কোনো কোডিং জ্ঞান নেই, বাজেট শূন্য, টিম একজন AI এজেন্ট। আলাদা আলাদা মাইক্রোসার্ভিস মানে বেশি খরচ, বেশি ভাঙন, বেশি রক্ষণাবেক্ষণ। একটাই Express অ্যাপে মডিউল ভাগ করা আছে (`server/` ফোল্ডার) — পরে চাইলে আলাদা করা যাবে।

**কেন Render + Supabase, Vercel নয়?** Vercel সার্ভারলেস — দীর্ঘ পোলিং, ফাইল আপলোড, ব্যাকগ্রাউন্ড জবের জন্য অসুবিধা। Render-এ সাধারণ Node সার্ভার চলে, যা মালিকের আগের `my-api-service`-এর মতোই।

## ২. টেকনোলজি স্ট্যাক (চূড়ান্ত)

| স্তর | পছন্দ | কেন |
|---|---|---|
| ভাষা | Node.js 20+ / JavaScript | মালিকের আগের সার্ভিসও Node — একই ধারা, শেখা সহজ |
| ব্যাকএন্ড | Express 4 + Helmet + rate-limit | হালকা, প্রমাণিত, Render ফ্রি-তে চলে |
| ডেটাবেস | **PostgreSQL (Supabase ফ্রি)** + `pg` ড্রাইভার, plain SQL migration | Prisma বাদ দেওয়া হয়েছে — Render ফ্রি-তে বিল্ড জটিলতা বাড়ায়; plain SQL স্বচ্ছ, Supabase SQL Editor থেকে সরাসরি চালানো যায় |
| ফ্রন্টএন্ড | Static HTML + **Tailwind CDN** + Vanilla JS, বাংলা/ইংরেজি টগল, Dark/Light | কোনো build step নেই — ফোন থেকে এডিট করাও সম্ভব; React/Next.js হলে বিল্ড, ডিপ্লয়, রক্ষণাবেক্ষণ — সব কঠিন হতো |
| অথ | bcryptjs (হ্যাশ) + JWT + Google OAuth (পরে) | পাসওয়ার্ড কখনো plain-text নয় |
| ফাইল সংরক্ষণ | Supabase Storage (পরে Cloudinary বিকল্প) | Higgsfield আউটপুট মাত্র ৭ দিন থাকে — নিজের স্টোরেজে কপি রাখা বাধ্যতামূলক |
| ইমেইল | Resend (ফ্রি) | সহজ API, ফ্রি ৩,০০০/মাস |
| হোস্টিং | Render ফ্রি Web Service | $০, GitHub থেকে সরাসরি ডেপ্লয় |

## ৩. ডেটাবেস ডিজাইন

সম্পূর্ণ স্কিমা: `db/migrations/001_init.sql` (PostgreSQL, Supabase SQL Editor-এ চালাতে হবে)।

| টেবিল | কাজ | গুরুত্বপূর্ণ নিয়ম |
|---|---|---|
| `users` | অ্যাকাউন্ট, রোল, স্ট্যাটাস, ক্রেডিট ব্যালেন্স, রেফারেল কোড | `credit_balance >= 0` CHECK; রোল: user / moderator / admin / super_admin; স্ট্যাটাস: active / suspended / banned |
| `settings` | অ্যাডমিন-নিয়ন্ত্রিত মান (বোনাস, retention, bKash/Nagad নম্বর) | কোডে হার্ডকোড নয় |
| `credit_ledger` | **প্রতিটি ক্রেডিট লেনদেনের append-only হিসাব** | `idempotency_key` UNIQUE — ডুপ্লিকেট কাটা অসম্ভব; ব্যালেন্সের সোর্স অফ ট্রুথ |
| `packages` | ক্রেডিট প্যাক / মাসিক / বার্ষিক প্যাকেজ | দাম BDT + USD, অ্যাডমিন এডিট করতে পারেন |
| `subscriptions` | কার সাবস্ক্রিপশন কবে শেষ | মেয়াদ শেষে স্বয়ংক্রিয়ভাবে inactive |
| `payments` | bKash/Nagad ম্যানুয়াল পেমেন্ট | `(method, transaction_id)` UNIQUE — একই trx ID দুবার চলবে না; status: pending/approved/rejected |
| `generations` | প্রতিটি জেনারেশন জব | `higgsfield_request_id` UNIQUE; `idempotency_key` UNIQUE; `expires_at` = তৈরি + ৩০ দিন |
| `gallery_items` + `gallery_likes/comments/reports` | পাবলিক গ্যালারি | `is_public = false` ডিফল্ট — অনুমতি ছাড়া কিছু পাবলিক নয় |
| `referrals` | রেফারেল + বোনাস | `(referrer, referred)` UNIQUE; বোনাস শুধু শর্ত পূরণ হলে |
| `templates` | রেডিমেড টেমপ্লেট | অ্যাডমিন পরিচালনা করেন |
| `notifications` / `announcements` / `faqs` / `support_tickets` | নোটিফিকেশন, ঘোষণা, FAQ, সাপোর্ট | — |
| `api_usage` | Higgsfield খরচের হিসাব (USD) | আসল খরচ vs অনুমান আলাদা রাখা হয়েছে |
| `audit_logs` | অ্যাডমিনের প্রতিটি কাজের লগ | কে, কী, কখন |

**সম্পর্ক (সংক্ষেপে):** একজন user → অনেক generation, payment, notification, referral; একটি generation → একটি gallery_item (ঐচ্ছিক); একটি package → অনেক payment/subscription; প্রতিটি credit_ledger রো → একজন user + একটি কারণ (generation/payment/refund/admin/referral)।

## ৪. উন্নয়ন রোডম্যাপ (Phase 1–12)

| Phase | কাজ | অবস্থা |
|---|---|---|
| 1 | বিশ্লেষণ + আর্কিটেকচার + স্ক্যাফোল্ড | ✅ **সম্পূর্ণ (এই প্রতিবেদন)** |
| 2 | ডেটাবেস সংযোগ + migration চালানো + সিড ডেটা | ⏳ পরের ধাপ |
| 3 | ফ্রন্টএন্ড সম্পূর্ণ করা (ড্যাশবোর্ড UI, গ্যালারি UI) | ⏳ |
| 4 | ব্যাকএন্ড + অথ (রেজিস্টার/লগইন/রিসেট, Google OAuth, JWT, রোল) | ⏳ |
| 5 | ইউজার ড্যাশবোর্ড + My Creations + ৩০ দিনের retention + সতর্কবার্তা | ⏳ |
| 6 | ক্রেডিট + পেমেন্ট (লেজার, প্যাকেজ, bKash/Nagad ম্যানুয়াল যাচাই, সাবস্ক্রিপশন) | ⏳ |
| 7 | অ্যাডমিন ড্যাশবোর্ড (ইউজার/মডেল/পেমেন্ট/অ্যানালিটিক্স, রোল-ভিত্তিক) | ⏳ |
| 8 | Higgsfield ইন্টিগ্রেশন (জব সাবমিট, পোলিং/webhook, রেজাল্ট ডাউনলোড, রিফান্ড) | ⏳ — মডিউল তৈরি, Key ছাড়া 503 দেয় |
| 9 | গ্যালারি, রেফারেল, নোটিফিকেশন, সাপোর্ট, FAQ, অ্যানাউন্সমেন্ট | ⏳ |
| 10 | নিরাপত্তা + টেস্টিং (তালিকা অনুযায়ী সব কেস) | ⏳ |
| 11 | পারফরম্যান্স + মোবাইল অপ্টিমাইজেশন | ⏳ |
| 12 | ডেপ্লয়মেন্ট প্রস্তুতি (Render + ডোমেইন + ব্যাকআপ) | ⏳ |

**প্রতিটি Phase-র নিয়ম:** কী শেষ হলো → টেস্ট → কী বাকি → পরের ধাপ। কোনো ফিচার টেস্ট ছাড়া "সম্পূর্ণ" বলা হবে না।

## ৫. ফ্রি-টিয়ার বাস্তবতা বিশ্লেষণ (সৎ হিসাব)

### ✅ যাচাই করা সীমা (নভেম্বর ২০২৬)

| সার্ভিস | ফ্রি সীমা | ধরা |
|---|---|---|
| **Render Web Service** | 512 MB RAM, 750 instance-hour/মাস, 5 GB ব্যান্ডউইথ, 500 build মিনিট | **১৫ মিনিট নিষ্ক্রিয় থাকলে ঘুমায়, জাগতে ~১ মিনিট**; ফাইল সিস্টেম ephemeral — আপলোড হারিয়ে যাবে; সবসময় চালু রাখতে $৭/মাস (Starter) |
| **Render Postgres (ফ্রি)** | 1 GB | **৩০ দিন পর মুছে যায়** (কিছু সোর্সে ৯০ দিন বলা হয়েছে — মতভেদ আছে, তাই নির্ভর করা যাবে না) → এজন্য Supabase ব্যবহার করা হচ্ছে |
| **Supabase ফ্রি** | 500 MB ডেটাবেস, 1 GB স্টোরেজ, 5 GB egress, 50,000 MAU, ২টি প্রজেক্ট | **১ সপ্তাহ নিষ্ক্রিয় থাকলে pause হয়** (আবার চালু করা যায়); ব্যাকআপ নেই; Pro $২৫/মাস |
| **Cloudinary ফ্রি** | ২৫ ক্রেডিট/মাস (স্টোরেজ+ব্যান্ডউইথ+ট্রান্সফরমেশন একসাথে) | ভিডিওতে দ্রুত শেষ হয়; Plus $৮৯/মাস |
| **Resend ফ্রি** | ৩,০০০ ইমেইল/মাস, দিনে সর্বোচ্চ ১০০, ৩টি ডোমেইন | দিনে ১০০-র বেশি পাসওয়ার্ড রিসেট এলে আটকে যাবে |
| **GitHub ফ্রি** | Unlimited private repo | বাণিজ্যিক ব্যবহারে সমস্যা নেই |

### ❌ যা কখনোই ফ্রি থাকবে না

- **Higgsfield জেনারেশন পেইড।** API প্রিপেইড USD ব্যালেন্সে চলে (সর্বনিম্ন টপ-আপ $৫)। সাবস্ক্রিপশনের ক্রেডিট দিয়ে API চলে না — আলাদা ব্যালেন্স লাগে। ✅ যাচাই করা।
- আনুমানিক খরচ (ওয়েব অ্যাপের রেট, ⚠️ API রেট আলাদা হতে পারে — console-এ যাচাই করতে হবে): Kling 3.0 ৫ সেকেন্ড 720p ≈ ১০ ক্রেডিট; Seedance 2.5 ৫ সেকেন্ড 720p ≈ ৩৫ ক্রেডিট; Veo 3.1 ৮ সেকেন্ড ≈ ৮০ ক্রেডিট। ১ ক্রেডিট ≈ $০.০৩–০.০৫।
- **ফ্রি প্ল্যানে বাণিজ্যিক ব্যবহার নেই** (Higgsfield ওয়েব ফ্রি প্ল্যান)। SaaS হিসেবে চালাতে পেইড প্ল্যান/ব্যালেন্স বাধ্যতামূলক।

### 💰 প্রথম বছরের বাস্তবসম্মত খরচ (আনুমানিক)

| খাত | ফ্রি দিয়ে শুরু | টেকসই চালাতে |
|---|---|---|
| হোস্টিং (Render) | $০ (ঘুমসহ) | $৭/মাস Starter |
| ডেটাবেস+স্টোরেজ (Supabase) | $০ | $০–২৫/মাস (সীমা ছাড়ালে) |
| ইমেইল (Resend) | $০ | $০–২০/মাস |
| Higgsfield API | $০ (Key ছাড়া বন্ধ) | ব্যবহার অনুযায়ী — প্রতি ৫ সেকেন্ডের ক্লিপ ≈ $০.৪৩–১.৭২ ⚠️ |
| **মোট** | **$০/মাস (ডেমো)** | **কমপক্ষে $৭/মাস + প্রতি জেনারেশনে AI খরচ** |

**সৎ কথা:** $০-তে সাইট চালানো যায়, কিন্তু $০-তে AI ভিডিও বানিয়ে বিক্রি করা যায় না — প্রতিটি জেনারেশনে Higgsfield-কে ডলার দিতে হবে। এই খরচ ক্রেডিটের দামে (BDT) তুলতে হবে, নাহলে লোকসান।

## ৬. প্রয়োজনীয় বাহ্যিক অ্যাকাউন্ট ও ক্রেডেনশিয়াল

| # | অ্যাকাউন্ট | কী লাগবে | অবস্থা | মালিককে যা করতে হবে |
|---|---|---|---|---|
| 1 | GitHub | অ্যাকাউন্ট | ⏳ বাকি | github.com-এ সাইনআপ (ইমেইল) |
| 2 | Render | GitHub লগইন | ⏳ বাকি | render.com-এ GitHub দিয়ে লগইন |
| 3 | Supabase | অ্যাকাউন্ট + `DATABASE_URL` | ⏳ বাকি | প্রজেক্ট বানিয়ে `001_init.sql` চালানো |
| 4 | Higgsfield | **API Key (KEY_ID:KEY_SECRET) + প্রিপেইড ব্যালেন্স ($৫+)** | ⏳ বাকি | open.higgsfield.ai থেকে Key বানানো + টাকা ভরা — **Key কখনো চ্যাটে দেবেন না** |
| 5 | Resend | API Key + ডোমেইন যাচাই | ⏳ বাকি (Phase 9) | resend.com-এ সাইনআপ |
| 6 | Google Cloud | OAuth Client ID/Secret | ⏳ বাকি (Phase 4) | Google Login-এর জন্য Console-এ প্রজেক্ট বানানো |
| 7 | bKash/Nagad | পার্সোনাল নম্বর | ⏳ বাকি (Phase 6) | নম্বর অ্যাডমিন সেটিংসে বসানো (কোডে নয়) |

## ৭. Higgsfield API — যাচাই করা তথ্য (✅ অফিসিয়াল ডকস, ২৬ নভেম্বর ২০২৬)

- **Base URL:** `https://api.higgsfield.ai` ✅
- **Auth:** `Authorization: Key KEY_ID:KEY_SECRET` — শুধু সার্ভার-সাইড ✅
- **ফ্লো:** POST মডেল endpoint → `{ request_id, status_url, cancel_url }` → `GET /requests/{id}/status` পোলিং → terminal: `completed | failed | nsfw | canceled` ✅
- **আউটপুট:** কমপক্ষে ৭ দিন থাকে — নিজের স্টোরেজে কপি রাখতে হবে ✅
- **SDK:** `@higgsfield/client` (TypeScript, সার্ভার-সাইড) ও Python SDK আছে ✅
- **যাচাই করা মডেল endpoint (config/models.json-এ আছে):** Soul 2 (`higgsfield-ai/soul/v2/standard`), Soul Cinema, Kling 4.0 image-to-video, Seedance 2.5 image-to-video, MiniMax Hailuo 2.3 image-to-video, Genjutsu motion-transfer ✅
- ⚠️ **Estimate endpoint** (`POST /estimate/<model>`) ও **presigned upload** (`/files/generate-upload-url`) — একাধিক স্বাধীন সেকেন্ডারি সোর্সে আছে, কিন্তু অফিসিয়াল ডকসের মূল পাতায় সরাসরি দেখা যায়নি; আসল Key দিয়ে লাইভ যাচাই করতে হবে।
- ⚠️ **Concurrency:** নতুন অ্যাকাউন্টে ২টি একসাথে; বেশি টাকা ভরলে বাড়ে (সেকেন্ডারি সোর্স) — লাইভ যাচাই বাকি।
- ❌ **Nano Banana Pro API-তে নেই** — শুধু ওয়েব অ্যাপে চলে (৮ নভেম্বর ২০২৬ যাচাই)। API দিয়ে কল করলে ব্যর্থ হবে।
- ❌ **Veo 3.1 API-তে আছে কি না নিশ্চিত নয়** — নভেম্বর ২০২৬ রিপোর্টে API ক্যাটালগে নেই বলা হয়েছে। Console-এ যাচাই না করে চালু করা যাবে না।
- ❌ **পুরনো `/v1/generations` endpoint** — তৃতীয় পক্ষের ব্লগে আছে, অফিসিয়াল ডকসে নেই। ব্যবহার করা হয়নি।

## ৮. Phase 1 টেস্ট ফলাফল

| টেস্ট | ফলাফল |
|---|---|
| `npm install` | ✅ সফল |
| সার্ভার চালু (`node server.js`) | ✅ সফল, পোর্ট 3000 |
| `GET /api/health` | ✅ 200 — `database: not_configured`, `higgsfield: not_configured` (সৎ রিপোর্ট) |
| `GET /api/models` | ✅ যাচাই করা ৫টি চালু মডেলের তালিকা |
| `GET /api/higgsfield/status` | ✅ 503 `HIGGSFIELD_NOT_CONFIGURED` (Key নেই — ঠিক আচরণ) |
| ল্যান্ডিং পেজ (`/`) | ✅ বাংলা/ইংরেজি, Dark/Light, মোবাইল-বান্ধব |
| DB migration ফাইল | ✅ লেখা হয়েছে; Supabase-এ চালানো বাকি (অ্যাকাউন্ট নেই বলে চালানো যায়নি) |

## ৯. এখনো বাকি (খোলাখুলি)

1. Supabase অ্যাকাউন্ট + migration চালানো — মালিকের অ্যাকাউন্ট লাগবে।
2. Render-এ ডেপ্লয় — GitHub অ্যাকাউন্ট লাগবে। ডেপ্লয় সফল বলা হয়নি, কারণ যাচাই হয়নি।
3. Higgsfield Key — মালিককে কিনতে/বানাতে হবে; Key ছাড়া জেনারেশন বন্ধ থাকবে।
4. Google OAuth — Phase 4-এ, মালিকের Google Cloud সেটআপ লাগবে।
5. Phase 2–12 — পরের ডিসপ্যাচে ধাপে ধাপে।

## ১০. ফাইল তালিকা

- `~/workspace/suman-ai-studio/package.json` — dependencies
- `~/workspace/suman-ai-studio/server.js` — Express সার্ভার
- `~/workspace/suman-ai-studio/server/higgsfield.js` — Higgsfield ক্লায়েন্ট
- `~/workspace/suman-ai-studio/server/db.js` — Postgres সংযোগ
- `~/workspace/suman-ai-studio/config/models.json` — মডেল রেজিস্ট্রি (যাচাই করা মডেল)
- `~/workspace/suman-ai-studio/db/migrations/001_init.sql` — সম্পূর্ণ স্কিমা
- `~/workspace/suman-ai-studio/public/index.html` — ল্যান্ডিং পেজ
- `~/workspace/suman-ai-studio/.env.example` — সিক্রেটের টেমপ্লেট (আসল মান নেই)
- `~/workspace/suman-ai-studio/render.yaml` — Render Blueprint
- `~/workspace/suman-ai-studio/README.md` — বাংলা সেটআপ গাইড
- `~/workspace/suman-ai-studio/PHASE1-ANALYSIS.md` — এই প্রতিবেদন
