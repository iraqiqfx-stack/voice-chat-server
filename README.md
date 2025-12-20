# ويندو Backend Server

خادم API لتطبيق ويندو - تطبيق تواصل اجتماعي مع غرف دردشة وهدايا.

## المتطلبات

- Node.js 18+
- PostgreSQL (للإنتاج) أو SQLite (للتطوير)

## التثبيت

```bash
# تثبيت الحزم
npm install

# إعداد قاعدة البيانات
npx prisma generate
npx prisma db push

# إضافة البيانات الأولية
node prisma/seed.js

# تشغيل الخادم
node server.js
```

## متغيرات البيئة

انسخ `.env.example` إلى `.env` وعدّل القيم:

```bash
cp .env.example .env
```

## APIs المتوفرة

- **Auth**: تسجيل الدخول والتسجيل
- **Profile**: إدارة الملف الشخصي
- **Posts**: المنشورات والتعليقات
- **Rooms**: غرف الدردشة
- **Gifts**: نظام الهدايا
- **Harvest**: الحصاد اليومي
- **Wheel**: عجلة الحظ
- **Reels**: الفيديوهات القصيرة
- **Stories**: القصص
- **DM**: الرسائل الخاصة

## النشر على Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## النشر على Render

1. اربط GitHub repo
2. Build Command: `npm install && npx prisma generate`
3. Start Command: `node server.js`
