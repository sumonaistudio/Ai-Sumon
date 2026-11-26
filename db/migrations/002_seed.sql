-- ============================================================
-- Suman AI Studio — Migration 002: seed data ONLY
-- Run AFTER 001_init.sql (db/run-migrations.js চালায় 001 -> 002)।
-- এখানে কোনো আসল ইউজার, পাসওয়ার্ড বা সিক্রেট নেই।
-- সব INSERT ... ON CONFLICT DO NOTHING — দুবার চালালেও ডুপ্লিকেট হবে না।
-- দাম/বোনাস এগুলো শুধু ডিফল্ট; অ্যাডমিন ড্যাশবোর্ড (Phase 7) থেকে
-- বদলানো যাবে। 1 USD ≈ 120 BDT ধরে প্রাথমিক দাম দেওয়া হয়েছে
-- (আনুমানিক; চূড়ান্ত দাম অ্যাডমিন ঠিক করবেন)।
-- ============================================================

-- ---------- Settings: 001-এ যা আছে তা নিশ্চিত করা + নতুন ডিফল্ট ----------
INSERT INTO settings (key, value) VALUES
  ('signup_bonus_credits', '100'),
  ('referral_bonus_credits', '50'),
  ('referral_eligible_after_generations', '1'),
  ('retention_days', '30'),
  ('bkash_number', '""'),
  ('nagad_number', '""'),
  ('payment_instructions_bn', '"প্যাকেজ বেছে নিন, দেখানো নম্বরে টাকা পাঠান, তারপর Transaction ID জমা দিন। অ্যাডমিন যাচাই করে ক্রেডিট দেবেন।"'),
  ('payment_instructions_en', '"Choose a package, send money to the shown number, then submit the Transaction ID. Admin will verify and add credits."'),
  ('site_name_bn', '"সুমন এআই স্টুডিও"'),
  ('site_name_en', '"Suman AI Studio"'),
  ('watermark_free_requires_paid', 'true')
ON CONFLICT (key) DO NOTHING;

-- ---------- Packages: ক্রেডিট প্যাক + মাসিক + বার্ষিক (BDT + USD) ----------
INSERT INTO packages (kind, name_bn, name_en, price_bdt, price_usd, credits, is_active, sort_order) VALUES
  ('credit_pack', 'স্টার্টার প্যাক', 'Starter Pack', 100, 0.83, 50, TRUE, 1),
  ('credit_pack', 'জনপ্রিয় প্যাক', 'Popular Pack', 250, 2.08, 150, TRUE, 2),
  ('credit_pack', 'প্রো প্যাক', 'Pro Pack', 500, 4.17, 350, TRUE, 3),
  ('credit_pack', 'স্টুডিও প্যাক', 'Studio Pack', 1000, 8.33, 800, TRUE, 4),
  ('monthly', 'মাসিক সাবস্ক্রিপশন', 'Monthly Subscription', 499, 4.16, 300, TRUE, 5),
  ('yearly', 'বার্ষিক সাবস্ক্রিপশন', 'Yearly Subscription', 4990, 41.58, 4000, TRUE, 6)
ON CONFLICT DO NOTHING;

-- ---------- Templates: রেডিমেড প্রম্পট টেমপ্লেট ----------
INSERT INTO templates (title_bn, title_en, type, prompt_template, model_id, is_active) VALUES
  ('সিনেমাটিক পোর্ট্রেট', 'Cinematic Portrait', 'text-to-image',
   'Ultra-photorealistic cinematic portrait of {subject}, soft golden-hour light, shallow depth of field, 85mm lens, detailed skin texture, Bangladesh, natural colours',
   'higgsfield-ai/soul/v2/standard', TRUE),
  ('বাংলার গ্রাম', 'Village of Bengal', 'text-to-image',
   'Ultra-photorealistic wide shot of a Bangladeshi village at dawn, mist over green paddy fields, a small wooden boat on a river, warm morning light, cinematic composition',
   'higgsfield-ai/soul/v2/standard', TRUE),
  ('সিনেমাটিক দৃশ্য', 'Cinematic Scene', 'text-to-image',
   'Cinematic film still, {subject}, dramatic lighting, teal and orange grade, anamorphic lens feel, ultra-detailed, photorealistic',
   'higgsfield-ai/soul/cinema', TRUE),
  ('ছবি থেকে ভিডিও — হাঁটা', 'Image to Video — Walking', 'image-to-video',
   'The person in the image walks slowly forward, natural movement, camera follows gently, realistic motion, ambient light unchanged',
   'kling-video/v4.0/image-to-video', TRUE),
  ('ছবি থেকে ভিডিও — প্রকৃতি', 'Image to Video — Nature', 'image-to-video',
   'Gentle wind moves the trees and water, clouds drift slowly, birds fly across the sky, calm and realistic motion, camera stays steady',
   'bytedance/seedance-2.5/image-to-video', TRUE)
ON CONFLICT DO NOTHING;

-- ---------- FAQ: ডিফল্ট প্রশ্নোত্তর (বাংলা + ইংরেজি) ----------
INSERT INTO faqs (question_bn, question_en, answer_bn, answer_en, sort_order, is_active) VALUES
  ('পেমেন্ট কীভাবে করব?', 'How do I pay?',
   'প্যাকেজ বেছে নিলে bKash/Nagad নম্বর দেখানো হবে। টাকা পাঠিয়ে Transaction ID জমা দিন — অ্যাডমিন যাচাই করে ক্রেডিট দেবেন।',
   'Choose a package and the bKash/Nagad number will be shown. Send the money, then submit the Transaction ID — admin will verify and add credits.',
   1, TRUE),
  ('আমার ছবি কি সবাই দেখবে?', 'Will everyone see my images?',
   'না। আপনার তৈরি জিনিস ডিফল্টে প্রাইভেট। আপনি নিজে অনুমতি দিলেই শুধু গ্যালারিতে যাবে।',
   'No. Your creations are private by default. They appear in the gallery only if you choose to publish them.',
   2, TRUE),
  ('ফ্রি ক্রেডিট কি বারবার পাওয়া যাবে?', 'Can I get free credits again and again?',
   'না — সাইনআপ বোনাস একবারই। ডুপ্লিকেট অ্যাকাউন্ট ধরা পড়লে অ্যাকাউন্ট ব্যান হবে।',
   'No — the signup bonus is one-time only. Duplicate accounts found abusing it will be banned.',
   3, TRUE),
  ('তৈরি করা ফাইল কতদিন থাকবে?', 'How long are my files kept?',
   'ডিফল্টে ৩০ দিন। মেয়াদ শেষ হওয়ার আগে সতর্কবার্তা দেওয়া হবে — সময়মতো ডাউনলোড করে নিন।',
   'By default 30 days. You will be warned before expiry — please download in time.',
   4, TRUE),
  ('Higgsfield সংযুক্ত না থাকলে কী হবে?', 'What if Higgsfield is not connected?',
   'সাইট চলবে, কিন্তু জেনারেশন বোতামে স্পষ্ট বার্তা আসবে। জেনারেশনের জন্য মালিককে Higgsfield API Key বসাতে হবে (পেইড)।',
   'The site will work, but generation will show a clear message. The owner must add a Higgsfield API key (paid) for generation.',
   5, TRUE);

-- ---------- Announcements: ডিফল্ট ঘোষণা ----------
INSERT INTO announcements (title_bn, title_en, body_bn, body_en, is_active) VALUES
  ('স্বাগতম — সুমন এআই স্টুডিও', 'Welcome — Suman AI Studio',
   'সাইনআপ করলেই একবারের ফ্রি স্টার্টার ক্রেডিট বোনাস পাবেন। পেমেন্ট bKash/Nagad-এ ম্যানুয়াল যাচাইয়ের মাধ্যমে হয়।',
   'Sign up to get a one-time free starter credit bonus. Payments are verified manually via bKash/Nagad.',
   TRUE);
