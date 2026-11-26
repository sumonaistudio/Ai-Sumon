# Suman AI Studio — টেস্টিং রিপোর্ট (TESTING.md)

**তারিখ:** ২৬ নভেম্বর ২০২৬ | **ভার্সন:** 1.0.0-beta (কোড সম্পূর্ণ, ডেপ্লয় বাকি)
**মোট আইসোলেটেড টেস্ট:** `npm test` — **১০৭ পাস, ০ ফেল**
(auth ১৭ + credits/payments ২৯ + generate ৩৩ + phase9 ১৮ + security ১০)

## ১. মাস্টার প্রম্পটের টেস্ট তালিকা — সৎ অবস্থা

| # | টেস্ট | অবস্থা | প্রমাণ / মন্তব্য |
|---|---|---|---|
| 1 | User registration | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | bcrypt, ভ্যালিডেশন, ডুপ্লিকেট 409 — টেস্টে পাস। আসল DB-তে রেজিস্টার → বোনাস লেজার — Supabase `DATABASE_URL` নেই বলে হয়নি। |
| 2 | Login | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | JWT sign/verify + ৭ দিন মেয়াদ টেস্টে পাস। লাইভ লগইন DB ছাড়া 503 দেয় (সৎ)। |
| 3 | Google authentication | ❌ হয়নি | ইচ্ছাকৃত 501 stub — মালিকের Google Cloud OAuth Client লাগবে। ভুয়া লগইন নয়। |
| 4 | Password reset | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | হ্যাশ করা একবারের টোকেন, ১ ঘণ্টা মেয়াদ — কোডে + টেস্টে। আসল মেইল Resend Key ছাড়া যায়নি। |
| 5 | Credit allocation (সাইনআপ বোনাস) | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | একই ট্রানজাকশনে বোনাস + idempotency `signup-bonus:<id>` — কোডে। লাইভে যাচাই বাকি। |
| 6 | Credit deduction | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | গণিত + নেগেটিভ নয় + idempotency — ২৯টি টেস্টে পাস। লাইভে যাচাই বাকি। |
| 7 | Failed generation refunds | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | `refund:<id>` একবারই — কোডে + টেস্টে। আসল Higgsfield ব্যর্থতা ছাড়া লাইভ রিফান্ড যাচাই হয়নি। |
| 8 | Payment approval | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | এক ট্রানজাকশনে ক্রেডিট + সাবস্ক্রিপশন + নোটিফিকেশন — কোডে। লাইভে যাচাই বাকি। |
| 9 | Payment rejection | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | কারণসহ reject, কোনো ক্রেডিট নয় — কোডে। লাইভে যাচাই বাকি। |
| 10 | Subscription activation | ✅ কোডে / ⚠️ লাইভ BLOCKED | মাসিক ৩০ / বার্ষিক ৩৬৫ দিন — কোডে। লাইভে যাচাই বাকি। |
| 11 | Model availability | ✅ পাস | `/api/models` লাইভ সার্ভারে ২০০ — শুধু যাচাই করা, চালু মডেল ৫টি। অজানা/বন্ধ মডেলে 400/403 — টেস্টে পাস। |
| 12 | Generation status | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | পোলিং, terminal স্ট্যাটাস, একবারই api_usage রো — কোডে + টেস্টে। আসল Higgsfield ছাড়া লাইভ পোলিং হয়নি। |
| 13 | File downloads | ✅ কোডে / ⚠️ লাইভ BLOCKED | শুধু মালিকানা + মেয়াদ যাচাইয়ের পর 302; মেয়াদোত্তীর্ণে 410, তৈরি হয়নি এমন জবে 409 — কোডে। লাইভ ফাইল নেই বলে ডাউনলোড যাচাই হয়নি। |
| 14 | File expiration | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | ৩০ দিন retention, ৩ দিনের মধ্যে `expiring_soon`, মেয়াদোত্তীর্ণে `expired` — টেস্টে পাস। |
| 15 | Admin permissions | ✅ কোডে / ⚠️ লাইভ BLOCKED | রোল চেক কোডে আছে; DB ছাড়া `requireAuth` আগেই 503 দেয়, তাই 403 পথ লাইভে যাচাই হয়নি। |
| 16 | Moderator permissions | ✅ কোডে / ⚠️ লাইভ BLOCKED | শুধু গ্যালারি মডারেশন — কোডে; লাইভে যাচাই বাকি (উপরের মতো)। |
| 17 | Referral rewards | ✅ আইসোলেটেড পাস / ⚠️ লাইভ BLOCKED | প্রথম approved পেমেন্টের পরেই বোনাস, একবারই, self-referral ব্লক — কোডে + টেস্টে (মাস্কিং, লিংক)। লাইভে যাচাই বাকি। |
| 18 | Mobile responsiveness | ⚠️ আংশিক | সব ১১ পেজে viewport + dark/light আছে; বোতামে py-1 (ছোট) কিছু জায়গায় আছে — টাচ টার্গেট সব জায়গায় আদর্শ নয়। আসল ফোনে পরীক্ষা হয়নি। |
| 19 | Security restrictions | ✅ আইসোলেটেড পাস | ১০টি সিকিউরিটি টেস্ট + `/api/admin/security` অডিট এন্ডপয়েন্ট। লাইভ আক্রমণ-পরীক্ষা (penetration test) করা হয়নি। |

## ২. লাইভ সার্ভার টেস্ট (DB/Key ছাড়া — সৎ আচরণ যাচাই)

| চেক | ফলাফল |
|---|---|
| `GET /api/health` | 200 — version 1.0.0-beta, database/higgsfield `not_configured` |
| `GET /api/models` | 200 — ৫টি যাচাই করা মডেল |
| `GET /api/gallery`, `/api/faqs`, `/api/announcements`, `/api/templates`, `/api/packages` | 503 `DB_NOT_CONFIGURED` (ভুয়া ডেটা নয়) |
| `GET /api/creations`, `/api/credits`, `/api/notifications`, `/api/referrals/me` (টোকেন ছাড়া) | 401 `UNAUTHORIZED` |
| `POST /api/generate`, `/api/upload-reference`, `/api/gallery/publish` (টোকেন ছাড়া) | 401 `UNAUTHORIZED` |
| `GET /api/auth/me` (টোকেন ছাড়া) | 401 |
| `GET /api/admin/*` (টোকেন ছাড়া) | 401 |
| অথ রেট লিমিট | ১১তম চেষ্টায় 429 |
| সব পাবলিক পেজ (১১টি) | 200 |
| `npm run migrate` (DATABASE_URL ছাড়া) | সৎভাবে ব্যর্থ, exit 1 |
| টেস্ট সার্ভার | প্রতিবার বন্ধ করা হয়েছে, পোর্ট ফাঁকা যাচাই করা হয়েছে |

## ৩. যা ইচ্ছাকৃতভাবে টেস্ট করা হয়নি (BLOCKED তালিকা)

1. **লাইভ DB ফ্লো** — Supabase `DATABASE_URL` নেই: রেজিস্টার → লগইন → বোনাস, পেমেন্ট → approve → ক্রেডিট + সাবস্ক্রিপশন, রিফান্ড, রেফারেল বোনাস, রোল/403, গ্যালারি প্রকাশ/লাইক/রিপোর্ট, টিকিট উত্তর।
2. **লাইভ Higgsfield** — Key + প্রিপেইড ব্যালেন্স নেই: আসল জেনারেশন, পোলিং, খরচ।
3. **আসল ইমেইল** — Resend Key নেই: রিসেট মেইল ডেলিভারি।
4. **Google OAuth** — Client ID/Secret নেই।
5. **আসল ফোনে পরীক্ষা** — ডিভাইস টেস্ট হয়নি; শুধু কোড-অডিট (viewport, বোতাম প্যাডিং)।

**Supabase পেলে প্রথমে যা করতে হবে:** `npm run migrate` (001–005) → উপরের ১ নম্বর ফ্লোগুলো আবার টেস্ট → তারপর Render ডেপ্লয়।
