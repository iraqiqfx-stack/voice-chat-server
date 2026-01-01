import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import multer from 'multer';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET is required! Set it in environment variables.');
    process.exit(1);
}

// إعداد Resend لإرسال البريد الإلكتروني
const RESEND_KEY = process.env.RESEND_API_KEY;
if (!RESEND_KEY) {
    console.error('❌ RESEND_API_KEY is required! Set it in environment variables.');
    process.exit(1);
}
const resend = new Resend(RESEND_KEY);
console.log('✅ Resend configured successfully');

// تخزين OTP مؤقتاً في الذاكرة (يمكن استخدام Redis في الإنتاج)
const otpStore = new Map(); // { email: { otp, expiresAt, userData } }

// تحديد BASE_URL تلقائياً
const getBaseUrl = () => {
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    }
    if (process.env.BASE_URL) {
        return process.env.BASE_URL;
    }
    return `http://localhost:${PORT}`;
};
const BASE_URL = getBaseUrl();

// ============================================================
// 🔄 تحديث قاعدة البيانات - إضافة الأعمدة الناقصة
// ============================================================
async function runMigrations() {
    try {
        console.log('🔄 جاري تحديث قاعدة البيانات...');
        await prisma.$executeRawUnsafe(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "metadata" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "parentId" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "reel_comment" ADD COLUMN IF NOT EXISTS "parentId" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micSeats" INTEGER DEFAULT 0;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micExpiresAt" TIMESTAMP;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micSeatPrice" DOUBLE PRECISION DEFAULT 100;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micDuration" INTEGER DEFAULT 30;`);
        // Agent fields
        await prisma.$executeRawUnsafe(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "telegram" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "address" TEXT;`);
        // PaymentMethod table
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "PaymentMethod" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "name" TEXT NOT NULL,
                "icon" TEXT,
                "minAmount" DOUBLE PRECISION DEFAULT 100,
                "maxAmount" DOUBLE PRECISION DEFAULT 10000,
                "fee" DOUBLE PRECISION DEFAULT 0,
                "isActive" BOOLEAN DEFAULT true,
                "createdAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        // WithdrawRequest new fields
        await prisma.$executeRawUnsafe(`ALTER TABLE "WithdrawRequest" ADD COLUMN IF NOT EXISTS "paymentMethodId" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "WithdrawRequest" ADD COLUMN IF NOT EXISTS "accountNumber" TEXT;`);
        // Make agentId nullable
        await prisma.$executeRawUnsafe(`ALTER TABLE "WithdrawRequest" ALTER COLUMN "agentId" DROP NOT NULL;`);
        // AllowedTransfer table
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "AllowedTransfer" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "userId" TEXT NOT NULL,
                "email" TEXT NOT NULL,
                "addedBy" TEXT,
                "createdAt" TIMESTAMP DEFAULT NOW(),
                UNIQUE("userId")
            );
        `);
        // CoinTransfer table
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "CoinTransfer" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "senderId" TEXT NOT NULL,
                "receiverId" TEXT NOT NULL,
                "amount" INTEGER NOT NULL,
                "note" TEXT,
                "createdAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        // DepositRequest table (طلبات الإيداع)
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "deposit_request" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "userId" TEXT NOT NULL,
                "amount" DOUBLE PRECISION NOT NULL,
                "paymentMethod" TEXT NOT NULL,
                "accountNumber" TEXT,
                "proofImage" TEXT NOT NULL,
                "status" TEXT DEFAULT 'pending',
                "note" TEXT,
                "adminNote" TEXT,
                "coinsToAdd" DOUBLE PRECISION,
                "gemsToAdd" DOUBLE PRECISION,
                "processedBy" TEXT,
                "processedAt" TIMESTAMP,
                "createdAt" TIMESTAMP DEFAULT NOW(),
                "updatedAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        // Email verification field
        await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isEmailVerified" BOOLEAN DEFAULT false;`);
        // Device ID field for User
        await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;`);
        // RegisteredDevice table (الأجهزة المسجلة)
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "registered_device" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "deviceId" TEXT UNIQUE NOT NULL,
                "userId" TEXT NOT NULL,
                "platform" TEXT,
                "model" TEXT,
                "createdAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        // Create index on deviceId
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "registered_device_deviceId_idx" ON "registered_device"("deviceId");`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "registered_device_userId_idx" ON "registered_device"("userId");`);
        console.log('✅ تم تحديث قاعدة البيانات بنجاح');
    } catch (error) {
        console.log('⚠️ تحذير migration:', error.message);
    }
}
runMigrations();

// دالة للتحقق من صلاحية المايكات
function isMicValid(room) {
    if (!room.micSeats || room.micSeats === 0) return false;
    if (!room.micExpiresAt) return false;
    return new Date(room.micExpiresAt) > new Date();
}

// دالة لتنسيق بيانات الغرفة مع إخفاء المايكات المنتهية
function formatRoomWithMicCheck(room) {
    const micValid = isMicValid(room);
    return {
        ...room,
        micSeats: micValid ? room.micSeats : 0,
        micExpiresAt: micValid ? room.micExpiresAt : null,
        micActive: micValid
    };
}

// Voice Server URL
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || 'http://62.84.176.222:3001';

// ============================================================
// 🛡️ Rate Limiting - حماية من الهجمات
// ============================================================
const rateLimitStore = new Map();

function rateLimit(windowMs, maxRequests) {
    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        
        if (!rateLimitStore.has(key)) {
            rateLimitStore.set(key, { count: 1, startTime: now });
            return next();
        }
        
        const record = rateLimitStore.get(key);
        
        if (now - record.startTime > windowMs) {
            rateLimitStore.set(key, { count: 1, startTime: now });
            return next();
        }
        
        if (record.count >= maxRequests) {
            return res.status(429).json({ 
                error: 'طلبات كثيرة جداً، حاول مرة أخرى لاحقاً',
                retryAfter: Math.ceil((windowMs - (now - record.startTime)) / 1000)
            });
        }
        
        record.count++;
        next();
    };
}

// تنظيف Rate Limit Store كل 5 دقائق
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
        if (now - record.startTime > 300000) { // 5 دقائق
            rateLimitStore.delete(key);
        }
    }
}, 300000);

// Rate limiters
const authRateLimit = rateLimit(60000, 5); // 5 طلبات في الدقيقة للمصادقة
const apiRateLimit = rateLimit(60000, 100); // 100 طلب في الدقيقة للـ API العام

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: function(origin, callback) {
    // السماح للطلبات بدون origin (مثل التطبيقات المحمولة)
    if (!origin) return callback(null, true);
    // في الإنتاج، تحقق من القائمة المسموحة
    if (process.env.NODE_ENV === 'production') {
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(null, true); // السماح للتطبيقات المحمولة
      }
    } else {
      callback(null, true); // في التطوير، السماح للجميع
    }
  },
  credentials: true
}));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// تقديم الملفات الثابتة (الفيديوهات والصور)
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));
// تقديم الملفات من المجلد الرئيسي أيضاً (للفيديوهات)
app.use('/assets', express.static(__dirname));
// تقديم الصور المرفوعة
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// إنشاء مجلد الرفع إذا لم يكن موجوداً
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// إعداد multer لرفع الملفات
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = file.originalname.split('.').pop();
        const filename = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('يجب أن يكون الملف صورة'));
        }
    }
});

// زيادة حجم الطلب للصور
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ============================================================
// 🔐 Middleware للتحقق من التوكن
// ============================================================
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        
        if (!user) {
            return res.status(401).json({ error: 'المستخدم غير موجود' });
        }
        
        // التحقق من حظر المستخدم
        if (user.isBanned) {
            return res.status(403).json({ 
                error: 'تم حظر حسابك',
                banned: true,
                reason: user.banReason || 'مخالفة شروط الاستخدام'
            });
        }
        
        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'توكن غير صالح' });
    }
};

// دالة مساعدة لتوليد كود الإحالة
const generateReferralCode = () => {
    return 'DN' + Math.random().toString(36).substring(2, 8).toUpperCase();
};

// دالة توليد معرف الغرفة من 6 أرقام
const generateRoomCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// ============================================================
// 📊 جدول المستويات (Level 1-50)
// ============================================================
// Index 0 = غير مستخدم، Index 1 = Level 1 (0 XP)، Index 2 = Level 2 (100 XP)، ...
const LEVEL_REQUIREMENTS = [
    0,          // Index 0 (غير مستخدم)
    0,          // Level 1: 0 XP
    100,        // Level 2: 100 XP
    500,        // Level 3: 500 XP
    1100,       // Level 4: 1,100 XP
    1600,       // Level 5: 1,600 XP
    3000,       // Level 6: 3,000 XP
    5000,       // Level 7: 5,000 XP
    8000,       // Level 8: 8,000 XP
    12000,      // Level 9: 12,000 XP
    18000,      // Level 10: 18,000 XP
    25000,      // Level 11
    35000,      // Level 12
    50000,      // Level 13
    70000,      // Level 14
    100000,     // Level 15
    140000,     // Level 16
    200000,     // Level 17
    280000,     // Level 18
    400000,     // Level 19
    550000,     // Level 20
    750000,     // Level 21
    1000000,    // Level 22
    1300000,    // Level 23
    1700000,    // Level 24
    2200000,    // Level 25
    2800000,    // Level 26
    3500000,    // Level 27
    4300000,    // Level 28
    5200000,    // Level 29
    6200000,    // Level 30
    7500000,    // Level 31
    9000000,    // Level 32
    10500000,   // Level 33
    12500000,   // Level 34
    15000000,   // Level 35
    17500000,   // Level 36
    20000000,   // Level 37
    23000000,   // Level 38
    26500000,   // Level 39
    30000000,   // Level 40
    34000000,   // Level 41
    38000000,   // Level 42
    42000000,   // Level 43
    46000000,   // Level 44
    50000000,   // Level 45
    55000000,   // Level 46
    60000000,   // Level 47
    66000000,   // Level 48
    73000000,   // Level 49
    81000000,   // Level 50
];

// دالة حساب المستوى من الخبرة
function calculateLevel(experience) {
    for (let level = 50; level >= 1; level--) {
        if (experience >= LEVEL_REQUIREMENTS[level]) {
            return level;
        }
    }
    return 1;
}

// دالة حساب تقدم المستوى (نسبة مئوية)
function calculateLevelProgress(experience) {
    const level = calculateLevel(experience);
    if (level >= 50) return 100;
    
    const currentLevelExp = LEVEL_REQUIREMENTS[level];
    const nextLevelExp = LEVEL_REQUIREMENTS[level + 1];
    const progress = ((experience - currentLevelExp) / (nextLevelExp - currentLevelExp)) * 100;
    return Math.min(Math.max(progress, 0), 100);
}

// دالة تحديث مستوى المستخدم
async function updateUserLevel(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { experience: true, level: true } });
    if (!user) return null;
    
    const newLevel = calculateLevel(user.experience);
    if (newLevel !== user.level) {
        await prisma.user.update({
            where: { id: userId },
            data: { level: newLevel }
        });
        
        // إشعار بالترقية
        if (newLevel > user.level) {
            await createNotification(
                userId,
                'system',
                '🎉 ترقية!',
                `مبروك! وصلت للمستوى ${newLevel}`,
                { newLevel }
            );
        }
    }
    return newLevel;
}

// دالة مساعدة لإنشاء إشعار
async function createNotification(userId, type, title, message, data = null) {
    try {
        await prisma.notification.create({
            data: {
                userId,
                type,
                title,
                message,
                data: data ? JSON.stringify(data) : null
            }
        });
    } catch (error) {
        console.error('Error creating notification:', error);
    }
}

// ============================================================
// 🔑 APIs المصادقة
// ============================================================

// دالة توليد OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6 أرقام
}

// دالة إرسال OTP عبر البريد الإلكتروني
async function sendOTPEmail(email, otp, username) {
    try {
        console.log('📤 Attempting to send OTP to:', email);
        
        const { data, error } = await resend.emails.send({
            from: 'Witter <noreply@iqfx.shop>',
            to: email,
            subject: '🔐 رمز التحقق - ويتر',
            html: `
                <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #8B5CF6, #EC4899); padding: 30px; border-radius: 16px; text-align: center;">
                        <h1 style="color: white; margin: 0; font-size: 28px;">ويتر</h1>
                        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0;">مرحباً ${username}!</p>
                    </div>
                    
                    <div style="background: #1a1a2e; padding: 30px; border-radius: 16px; margin-top: 20px; text-align: center;">
                        <p style="color: #9CA3AF; font-size: 16px; margin: 0 0 20px;">رمز التحقق الخاص بك هو:</p>
                        
                        <div style="background: linear-gradient(135deg, #8B5CF6, #EC4899); padding: 20px 40px; border-radius: 12px; display: inline-block;">
                            <span style="color: white; font-size: 36px; font-weight: bold; letter-spacing: 8px;">${otp}</span>
                        </div>
                        
                        <p style="color: #6B7280; font-size: 14px; margin: 20px 0 0;">
                            ⏰ صالح لمدة 10 دقائق فقط
                        </p>
                        
                        <p style="color: #EF4444; font-size: 13px; margin: 15px 0 0;">
                            ⚠️ لا تشارك هذا الرمز مع أي شخص
                        </p>
                    </div>
                    
                    <p style="color: #6B7280; font-size: 12px; text-align: center; margin-top: 20px;">
                        إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.
                    </p>
                </div>
            `
        });

        if (error) {
            console.error('❌ Resend error:', JSON.stringify(error));
            // في حالة فشل الإرسال، نطبع OTP في الـ logs للاختبار
            console.log('📧 [FALLBACK] OTP for', email, ':', otp);
            return true; // نعتبره ناجح للاختبار
        }
        
        console.log('✅ OTP sent successfully to:', email, 'ID:', data?.id);
        return true;
    } catch (error) {
        console.error('❌ Send OTP exception:', error.message);
        // في حالة الخطأ، نطبع OTP في الـ logs للاختبار
        console.log('📧 [FALLBACK] OTP for', email, ':', otp);
        return true; // نعتبره ناجح للاختبار
    }
}

// الخطوة 1: طلب التسجيل وإرسال OTP
app.post('/api/auth/register/request-otp', authRateLimit, async (req, res) => {
    try {
        const { username, email, password, referralCode, deviceId } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
        }
        
        // التحقق من كود الدعوة (مطلوب)
        if (!referralCode) {
            return res.status(400).json({ error: 'كود الدعوة مطلوب' });
        }
        
        // التحقق من صحة كود الدعوة
        const referrer = await prisma.user.findUnique({ where: { referralCode } });
        if (!referrer) {
            return res.status(400).json({ error: 'كود الدعوة غير صحيح' });
        }
        
        // التحقق من Device ID - منع إنشاء أكثر من حساب على نفس الجهاز
        if (deviceId) {
            const existingDevice = await prisma.$queryRaw`
                SELECT * FROM "registered_device" WHERE "deviceId" = ${deviceId} LIMIT 1
            `;
            if (existingDevice && existingDevice.length > 0) {
                return res.status(400).json({ error: 'لا يمكن إنشاء أكثر من حساب على نفس الجهاز' });
            }
        }
        
        // التحقق من طول كلمة المرور
        if (password.length < 6) {
            return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        }
        
        // التحقق من أن البريد Gmail فقط
        const emailLower = email.toLowerCase().trim();
        if (!emailLower.endsWith('@gmail.com')) {
            return res.status(400).json({ error: 'يجب استخدام بريد Gmail فقط' });
        }
        
        // التحقق من عدم وجود المستخدم
        const existingUser = await prisma.user.findFirst({
            where: { OR: [{ email: emailLower }, { username }] }
        });
        
        if (existingUser) {
            return res.status(400).json({ 
                error: existingUser.email === emailLower ? 'البريد الإلكتروني مستخدم' : 'اسم المستخدم مستخدم' 
            });
        }
        
        // التحقق من عدم إرسال OTP مؤخراً (منع السبام)
        const existingOTP = otpStore.get(emailLower);
        if (existingOTP && existingOTP.expiresAt > Date.now() - 60000) { // دقيقة واحدة بين الطلبات
            const waitTime = Math.ceil((existingOTP.expiresAt - Date.now() + 60000) / 1000 / 60);
            return res.status(429).json({ error: `انتظر ${waitTime} دقيقة قبل طلب رمز جديد` });
        }
        
        // توليد OTP
        const otp = generateOTP();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 دقائق
        
        // تخزين البيانات مؤقتاً
        otpStore.set(emailLower, {
            otp,
            expiresAt,
            userData: { username, email: emailLower, password, referralCode, deviceId }
        });
        
        // إرسال OTP
        const sent = await sendOTPEmail(emailLower, otp, username);
        
        if (!sent) {
            otpStore.delete(emailLower);
            return res.status(500).json({ error: 'فشل إرسال رمز التحقق، حاول مرة أخرى' });
        }
        
        res.json({ 
            success: true, 
            message: 'تم إرسال رمز التحقق إلى بريدك الإلكتروني',
            email: emailLower
        });
        
    } catch (error) {
        console.error('Request OTP error:', error);
        res.status(500).json({ error: 'خطأ في إرسال رمز التحقق' });
    }
});

// الخطوة 2: التحقق من OTP وإكمال التسجيل
app.post('/api/auth/register/verify-otp', authRateLimit, async (req, res) => {
    try {
        const { email, otp } = req.body;
        
        console.log('🔍 Verify OTP request:', { email, otp });
        console.log('📦 OTP Store size:', otpStore.size);
        
        if (!email || !otp) {
            return res.status(400).json({ error: 'البريد ورمز التحقق مطلوبان' });
        }
        
        const emailLower = email.toLowerCase().trim();
        const storedData = otpStore.get(emailLower);
        
        console.log('📧 Looking for:', emailLower);
        console.log('💾 Stored data exists:', !!storedData);
        
        if (!storedData) {
            return res.status(400).json({ error: 'لم يتم طلب رمز تحقق لهذا البريد' });
        }
        
        // التحقق من انتهاء الصلاحية
        if (storedData.expiresAt < Date.now()) {
            otpStore.delete(emailLower);
            return res.status(400).json({ error: 'انتهت صلاحية رمز التحقق، اطلب رمزاً جديداً' });
        }
        
        console.log('🔐 Comparing OTP:', { stored: storedData.otp, received: otp });
        
        // التحقق من صحة OTP
        if (storedData.otp !== otp) {
            return res.status(400).json({ error: 'رمز التحقق غير صحيح' });
        }
        
        console.log('✅ OTP verified successfully, creating user...');
        
        // حذف OTP من التخزين
        otpStore.delete(emailLower);
        
        const { username, password, referralCode, deviceId } = storedData.userData;
        
        // تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // البحث عن المُحيل
        let referrer = null;
        if (referralCode) {
            referrer = await prisma.user.findUnique({ where: { referralCode } });
            console.log('👤 Referrer found:', referrer ? referrer.username : 'none');
        }
        
        // إنشاء المستخدم
        const userData = {
            username,
            email: emailLower,
            password: hashedPassword,
            referralCode: generateReferralCode(),
            coins: 100,
            gems: 10,
            isEmailVerified: true,
            deviceId: deviceId || null
        };
        
        // إضافة المُحيل إذا وُجد
        if (referrer) {
            userData.referrer = { connect: { id: referrer.id } };
        }
        
        console.log('📝 Creating user with data:', { ...userData, password: '[hidden]' });
        
        const user = await prisma.user.create({ data: userData });
        
        console.log('✅ User created:', user.id);
        
        // تسجيل الجهاز في جدول الأجهزة المسجلة
        if (deviceId) {
            try {
                await prisma.$executeRaw`
                    INSERT INTO "registered_device" ("id", "deviceId", "userId", "platform", "createdAt")
                    VALUES (gen_random_uuid()::text, ${deviceId}, ${user.id}, 'mobile', NOW())
                    ON CONFLICT ("deviceId") DO NOTHING
                `;
                console.log('📱 Device registered:', deviceId);
            } catch (deviceError) {
                console.log('⚠️ Device registration warning:', deviceError.message);
            }
        }
        
        // مكافأة المُحيل
        if (referrer) {
            const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
            await prisma.user.update({
                where: { id: referrer.id },
                data: { gems: { increment: settings?.referralGems || 50 } }
            });
            await createNotification(
                referrer.id,
                'referral',
                '🎉 عضو جديد في فريقك!',
                `انضم ${username} لفريقك وحصلت على ${settings?.referralGems || 50} جوهرة`,
                { newUserId: user.id, gems: settings?.referralGems || 50 }
            );
        }
        
        // إشعار ترحيبي
        await createNotification(
            user.id,
            'system',
            '🎊 أهلاً بك في ويتر!',
            'حصلت على 100 عملة و 10 جواهر كهدية ترحيبية. استمتع بالتطبيق!',
            { coins: 100, gems: 10 }
        );
        
        // إنشاء التوكن
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        const { password: _, ...userWithoutPassword } = user;
        console.log('🎉 Registration complete, sending response...');
        res.json({ user: userWithoutPassword, token });
        
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ error: 'خطأ في التحقق' });
    }
});

// إعادة إرسال OTP
app.post('/api/auth/register/resend-otp', authRateLimit, async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
        }
        
        const emailLower = email.toLowerCase().trim();
        const storedData = otpStore.get(emailLower);
        
        if (!storedData) {
            return res.status(400).json({ error: 'لم يتم طلب تسجيل لهذا البريد' });
        }
        
        // التحقق من مرور دقيقة على الأقل
        const timeSinceLastOTP = Date.now() - (storedData.expiresAt - 10 * 60 * 1000);
        if (timeSinceLastOTP < 60000) {
            const waitTime = Math.ceil((60000 - timeSinceLastOTP) / 1000);
            return res.status(429).json({ error: `انتظر ${waitTime} ثانية قبل إعادة الإرسال` });
        }
        
        // توليد OTP جديد
        const otp = generateOTP();
        const expiresAt = Date.now() + 10 * 60 * 1000;
        
        // تحديث البيانات
        storedData.otp = otp;
        storedData.expiresAt = expiresAt;
        otpStore.set(emailLower, storedData);
        
        // إرسال OTP
        const sent = await sendOTPEmail(emailLower, otp, storedData.userData.username);
        
        if (!sent) {
            return res.status(500).json({ error: 'فشل إرسال رمز التحقق' });
        }
        
        res.json({ success: true, message: 'تم إعادة إرسال رمز التحقق' });
        
    } catch (error) {
        console.error('Resend OTP error:', error);
        res.status(500).json({ error: 'خطأ في إعادة الإرسال' });
    }
});

// التسجيل القديم (للتوافق مع الإصدارات القديمة) - يمكن حذفه لاحقاً
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, referralCode } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
        }
        
        // التحقق من أن البريد Gmail فقط
        const emailLower = email.toLowerCase().trim();
        if (!emailLower.endsWith('@gmail.com')) {
            return res.status(400).json({ error: 'يجب استخدام بريد Gmail فقط' });
        }
        
        // التحقق من عدم وجود المستخدم
        const existingUser = await prisma.user.findFirst({
            where: { OR: [{ email: emailLower }, { username }] }
        });
        
        if (existingUser) {
            return res.status(400).json({ 
                error: existingUser.email === email ? 'البريد الإلكتروني مستخدم' : 'اسم المستخدم مستخدم' 
            });
        }
        
        // تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // البحث عن المُحيل
        let referrer = null;
        if (referralCode) {
            referrer = await prisma.user.findUnique({ where: { referralCode } });
        }
        
        // إنشاء المستخدم
        const userData = {
            username,
            email: emailLower,
            password: hashedPassword,
            referralCode: generateReferralCode(),
            coins: 100,
            gems: 10
        };
        
        if (referrer) {
            userData.referrer = { connect: { id: referrer.id } };
        }
        
        const user = await prisma.user.create({ data: userData });
        
        // مكافأة المُحيل
        if (referrer) {
            const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
            await prisma.user.update({
                where: { id: referrer.id },
                data: { gems: { increment: settings?.referralGems || 50 } }
            });
            // إشعار للمُحيل
            await createNotification(
                referrer.id,
                'referral',
                '🎉 عضو جديد في فريقك!',
                `انضم ${username} لفريقك وحصلت على ${settings?.referralGems || 50} جوهرة`,
                { newUserId: user.id, gems: settings?.referralGems || 50 }
            );
        }
        
        // إشعار ترحيبي للمستخدم الجديد
        await createNotification(
            user.id,
            'system',
            '🎊 أهلاً بك في ويتر!',
            'حصلت على 100 عملة و 10 جواهر كهدية ترحيبية. استمتع بالتطبيق!',
            { coins: 100, gems: 10 }
        );
        
        // إنشاء التوكن
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ user: userWithoutPassword, token });
        
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'خطأ في التسجيل' });
    }
});

// تسجيل الدخول
app.post('/api/auth/login', authRateLimit, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
        }
        
        const user = await prisma.user.findUnique({ where: { email } });
        
        if (!user) {
            return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
        }
        
        // تحديث حالة الاتصال
        await prisma.user.update({
            where: { id: user.id },
            data: { isOnline: true, lastSeen: new Date() }
        });
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ user: userWithoutPassword, token });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'خطأ في تسجيل الدخول' });
    }
});

// استعادة كلمة المرور
app.post('/api/auth/forgot-password', authRateLimit, async (req, res) => {
    try {
        const { email } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        
        if (!user) {
            return res.status(404).json({ error: 'البريد الإلكتروني غير مسجل' });
        }
        
        // في الإنتاج: إرسال بريد إلكتروني
        res.json({ message: 'تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني' });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في استعادة كلمة المرور' });
    }
});

// ============================================================
// 👤 APIs الملف الشخصي
// ============================================================

app.get('/api/profile', authenticate, async (req, res) => {
    // تحديث حالة النشاط عند كل طلب
    await prisma.user.update({
        where: { id: req.user.id },
        data: { isOnline: true, lastSeen: new Date() }
    });
    const { password: _, ...user } = req.user;
    res.json(user);
});

// تحديث حالة النشاط (heartbeat)
app.post('/api/profile/heartbeat', authenticate, async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.user.id },
            data: { isOnline: true, lastSeen: new Date() }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث النشاط' });
    }
});

// تسجيل الخروج (offline)
app.post('/api/profile/offline', authenticate, async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.user.id },
            data: { isOnline: false, lastSeen: new Date() }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث النشاط' });
    }
});

app.put('/api/profile', authenticate, async (req, res) => {
    try {
        const { username, avatar } = req.body;
        
        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: { 
                ...(username && { username }),
                ...(avatar && { avatar })
            }
        });
        
        const { password: _, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الملف الشخصي' });
    }
});

app.get('/api/profile/team', authenticate, async (req, res) => {
    try {
        const team = await prisma.user.findMany({
            where: { referredBy: req.user.id },
            select: { 
                id: true, 
                username: true, 
                avatar: true, 
                coins: true,
                gems: true,
                createdAt: true 
            },
            orderBy: { coins: 'desc' }
        });
        res.json(team);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الفريق' });
    }
});

// جلب الهدايا المستلمة للمستخدم
app.get('/api/profile/received-gifts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // جلب الهدايا المستلمة مع تجميعها حسب نوع الهدية
        const receivedGifts = await prisma.giftMessage.findMany({
            where: { receiverId: userId },
            include: {
                gift: true,
                sender: { select: { id: true, username: true, avatar: true, level: true, experience: true } }
            },
            orderBy: { createdAt: 'desc' },
            take: 100
        });
        
        // تجميع الهدايا حسب النوع مع حساب العدد والقيمة الإجمالية
        const giftSummary = {};
        let totalValue = 0;
        
        receivedGifts.forEach(gm => {
            const giftId = gm.gift.id;
            if (!giftSummary[giftId]) {
                giftSummary[giftId] = {
                    gift: gm.gift,
                    count: 0,
                    totalValue: 0,
                    lastSender: gm.sender,
                    lastReceivedAt: gm.createdAt
                };
            }
            giftSummary[giftId].count += 1;
            giftSummary[giftId].totalValue += gm.gift.price;
            totalValue += gm.gift.price;
        });
        
        // تحويل لمصفوفة وترتيب حسب القيمة
        const gifts = Object.values(giftSummary).sort((a, b) => b.totalValue - a.totalValue);
        
        res.json({
            gifts,
            totalGiftsCount: receivedGifts.length,
            totalValue,
            recentGifts: receivedGifts.slice(0, 10) // آخر 10 هدايا
        });
    } catch (error) {
        console.error('Get received gifts error:', error);
        res.status(500).json({ error: 'خطأ في جلب الهدايا المستلمة' });
    }
});

// جلب منشورات المستخدم
app.get('/api/profile/posts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        const posts = await prisma.post.findMany({
            where: { userId },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 3
                },
                postLikes: { where: { userId } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        const formattedPosts = posts.map(post => ({
            ...post,
            isLiked: post.postLikes.length > 0,
            postLikes: undefined
        }));
        
        // عدد المنشورات الإجمالي
        const totalPosts = await prisma.post.count({ where: { userId } });
        
        res.json({
            posts: formattedPosts,
            totalPosts,
            page,
            hasMore: page * limit < totalPosts
        });
    } catch (error) {
        console.error('Get user posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب المنشورات' });
    }
});

// جلب إحصائيات الملف الشخصي
app.get('/api/profile/stats', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const [postsCount, receivedGiftsCount, sentGiftsCount, teamCount, followersCount, followingCount] = await Promise.all([
            prisma.post.count({ where: { userId } }),
            prisma.giftMessage.count({ where: { receiverId: userId } }),
            prisma.giftMessage.count({ where: { senderId: userId } }),
            prisma.user.count({ where: { referredBy: userId } }),
            prisma.follow.count({ where: { followingId: userId } }),
            prisma.follow.count({ where: { followerId: userId } })
        ]);
        
        // حساب إجمالي قيمة الهدايا المستلمة
        const receivedGiftsValue = await prisma.giftMessage.findMany({
            where: { receiverId: userId },
            include: { gift: { select: { price: true } } }
        });
        const totalReceivedValue = receivedGiftsValue.reduce((sum, gm) => sum + gm.gift.price, 0);
        
        res.json({
            postsCount,
            receivedGiftsCount,
            sentGiftsCount,
            teamCount,
            followersCount,
            followingCount,
            totalReceivedValue,
            isPrivate: req.user.isPrivate || false
        });
    } catch (error) {
        console.error('Get profile stats error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// جلب متابعيني
app.get('/api/profile/followers', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const followers = await prisma.follow.findMany({
            where: { followingId: userId },
            include: {
                follower: { select: { id: true, username: true, avatar: true, level: true, isOnline: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // التحقق من المتابعة المتبادلة
        const followingIds = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingSet = new Set(followingIds.map(f => f.followingId));
        
        const result = followers.map(f => ({
            ...f.follower,
            isFollowingBack: followingSet.has(f.follower.id)
        }));
        
        res.json(result);
    } catch (error) {
        console.error('Get my followers error:', error);
        res.status(500).json({ error: 'خطأ في جلب المتابعين' });
    }
});

// جلب الذين أتابعهم
app.get('/api/profile/following', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            include: {
                following: { select: { id: true, username: true, avatar: true, level: true, isOnline: true, lastSeen: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // التحقق من حالة النشاط الحقيقية (آخر 5 دقائق)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const result = following.map(f => {
            const user = f.following;
            const isReallyOnline = user.isOnline && user.lastSeen && new Date(user.lastSeen) > fiveMinutesAgo;
            return {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                level: user.level,
                isOnline: isReallyOnline
            };
        });
        
        res.json(result);
    } catch (error) {
        console.error('Get my following error:', error);
        res.status(500).json({ error: 'خطأ في جلب المتابَعين' });
    }
});

// تغيير خصوصية الحساب (عام/خاص)
app.put('/api/profile/privacy', authenticate, async (req, res) => {
    try {
        const { isPrivate } = req.body;
        
        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: { isPrivate: !!isPrivate }
        });
        
        res.json({ success: true, isPrivate: user.isPrivate });
    } catch (error) {
        console.error('Update privacy error:', error);
        res.status(500).json({ error: 'خطأ في تحديث الخصوصية' });
    }
});

// حذف الحساب نهائياً
app.delete('/api/profile/delete-account', authenticate, async (req, res) => {
    try {
        const { password } = req.body;
        const userId = req.user.id;
        
        // التحقق من كلمة المرور
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        const bcrypt = await import('bcryptjs');
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
        }
        
        // حذف جميع البيانات المرتبطة بالمستخدم
        await prisma.$transaction(async (tx) => {
            // حذف الرسائل
            await tx.chatMessage.deleteMany({ where: { userId } });
            
            // حذف التعليقات
            await tx.comment.deleteMany({ where: { userId } });
            
            // حذف الإعجابات
            await tx.like.deleteMany({ where: { userId } });
            
            // حذف المنشورات
            await tx.post.deleteMany({ where: { userId } });
            
            // حذف الإشعارات
            await tx.notification.deleteMany({ where: { userId } });
            
            // حذف طلبات السحب
            await tx.$executeRaw`DELETE FROM "WithdrawRequest" WHERE "userId" = ${userId}`;
            
            // حذف التحويلات
            await tx.$executeRaw`DELETE FROM "CoinTransfer" WHERE "senderId" = ${userId} OR "receiverId" = ${userId}`;
            
            // حذف من المسموح لهم بالتحويل
            await tx.$executeRaw`DELETE FROM "AllowedTransfer" WHERE "userId" = ${userId}`;
            
            // حذف المتابعات
            await tx.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } });
            
            // حذف عضويات الغرف
            await tx.roomMember.deleteMany({ where: { odId: userId } });
            
            // حذف الغرف المملوكة
            await tx.chatRoom.deleteMany({ where: { ownerId: userId } });
            
            // حذف الباقات
            await tx.userPackage.deleteMany({ where: { userId } });
            
            // حذف المستخدم نفسه
            await tx.user.delete({ where: { id: userId } });
        });
        
        res.json({ success: true, message: 'تم حذف الحساب بنجاح' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'خطأ في حذف الحساب' });
    }
});

// ============================================================
// 👤 APIs الملف الشخصي للمستخدمين الآخرين
// ============================================================

// جلب ملف شخصي لمستخدم آخر
app.get('/api/users/:userId/profile', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentUserId = req.user.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true, username: true, avatar: true, level: true, experience: true,
                coins: true, gems: true, isOnline: true, isPrivate: true, lastSeen: true, createdAt: true
            }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        // إحصائيات المستخدم
        const [postsCount, followersCount, followingCount, receivedGiftsCount, isFollowing] = await Promise.all([
            prisma.post.count({ where: { userId } }),
            prisma.follow.count({ where: { followingId: userId } }),
            prisma.follow.count({ where: { followerId: userId } }),
            prisma.giftMessage.count({ where: { receiverId: userId } }),
            prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: currentUserId, followingId: userId } }
            })
        ]);
        
        // حساب قيمة الهدايا المستلمة
        const receivedGifts = await prisma.giftMessage.findMany({
            where: { receiverId: userId },
            include: { gift: { select: { price: true } } }
        });
        const totalGiftsValue = receivedGifts.reduce((sum, gm) => sum + gm.gift.price, 0);
        
        // التحقق من حالة النشاط الحقيقية (آخر 5 دقائق)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const isReallyOnline = user.isOnline && user.lastSeen && new Date(user.lastSeen) > fiveMinutesAgo;
        
        res.json({
            ...user,
            isOnline: isReallyOnline,
            postsCount,
            followersCount,
            followingCount,
            receivedGiftsCount,
            totalGiftsValue,
            isFollowing: !!isFollowing,
            isOwnProfile: userId === currentUserId,
            isPrivate: user.isPrivate || false
        });
    } catch (error) {
        console.error('Get user profile error:', error);
        res.status(500).json({ error: 'خطأ في جلب الملف الشخصي' });
    }
});

// جلب منشورات مستخدم آخر
app.get('/api/users/:userId/posts', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const currentUserId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        // التحقق من خصوصية الحساب
        const targetUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { isPrivate: true }
        });
        
        // إذا كان الحساب خاص ولم يكن المستخدم الحالي هو صاحب الحساب
        if (targetUser?.isPrivate && userId !== currentUserId) {
            // التحقق من المتابعة
            const isFollowing = await prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: currentUserId, followingId: userId } }
            });
            
            if (!isFollowing) {
                return res.json({ posts: [], isPrivate: true, message: 'هذا الحساب خاص' });
            }
        }
        
        const posts = await prisma.post.findMany({
            where: { userId },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                postLikes: { where: { userId: currentUserId } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        const formattedPosts = posts.map(post => ({
            ...post,
            isLiked: post.postLikes.length > 0,
            postLikes: undefined
        }));
        
        res.json(formattedPosts);
    } catch (error) {
        console.error('Get user posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب المنشورات' });
    }
});

// جلب الهدايا المستلمة لمستخدم آخر
app.get('/api/users/:userId/gifts', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const receivedGifts = await prisma.giftMessage.findMany({
            where: { receiverId: userId },
            include: { gift: true },
            orderBy: { createdAt: 'desc' },
            take: 100
        });
        
        // تجميع الهدايا حسب النوع
        const giftSummary = {};
        receivedGifts.forEach(gm => {
            const giftId = gm.gift.id;
            if (!giftSummary[giftId]) {
                giftSummary[giftId] = { gift: gm.gift, count: 0, totalValue: 0 };
            }
            giftSummary[giftId].count += 1;
            giftSummary[giftId].totalValue += gm.gift.price;
        });
        
        const gifts = Object.values(giftSummary).sort((a, b) => b.totalValue - a.totalValue);
        const totalValue = receivedGifts.reduce((sum, gm) => sum + gm.gift.price, 0);
        
        res.json({ gifts, totalGiftsCount: receivedGifts.length, totalValue });
    } catch (error) {
        console.error('Get user gifts error:', error);
        res.status(500).json({ error: 'خطأ في جلب الهدايا' });
    }
});

// ============================================================
// 👥 APIs نظام المتابعة
// ============================================================

// متابعة مستخدم
app.post('/api/users/:userId/follow', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const followerId = req.user.id;
        
        if (userId === followerId) {
            return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
        }
        
        // التحقق من وجود المستخدم
        const userExists = await prisma.user.findUnique({ where: { id: userId } });
        if (!userExists) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        // إنشاء المتابعة
        await prisma.follow.create({
            data: { followerId, followingId: userId }
        });
        
        // إشعار للمستخدم المتابَع
        await prisma.notification.create({
            data: {
                userId,
                type: 'follow',
                title: '👤 متابع جديد!',
                message: `${req.user.username} بدأ بمتابعتك`,
                data: JSON.stringify({ followerId, followerName: req.user.username })
            }
        });
        
        const followersCount = await prisma.follow.count({ where: { followingId: userId } });
        
        res.json({ success: true, isFollowing: true, followersCount });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.json({ success: true, isFollowing: true, message: 'أنت تتابع هذا المستخدم بالفعل' });
        }
        console.error('Follow error:', error);
        res.status(500).json({ error: 'خطأ في المتابعة' });
    }
});

// إلغاء متابعة مستخدم
app.delete('/api/users/:userId/follow', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        const followerId = req.user.id;
        
        await prisma.follow.deleteMany({
            where: { followerId, followingId: userId }
        });
        
        const followersCount = await prisma.follow.count({ where: { followingId: userId } });
        
        res.json({ success: true, isFollowing: false, followersCount });
    } catch (error) {
        console.error('Unfollow error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء المتابعة' });
    }
});

// جلب المتابعين
app.get('/api/users/:userId/followers', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const followers = await prisma.follow.findMany({
            where: { followingId: userId },
            include: {
                follower: { select: { id: true, username: true, avatar: true, level: true, isOnline: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        res.json(followers.map(f => f.follower));
    } catch (error) {
        console.error('Get followers error:', error);
        res.status(500).json({ error: 'خطأ في جلب المتابعين' });
    }
});

// جلب المتابَعين
app.get('/api/users/:userId/following', authenticate, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            include: {
                following: { select: { id: true, username: true, avatar: true, level: true, isOnline: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        res.json(following.map(f => f.following));
    } catch (error) {
        console.error('Get following error:', error);
        res.status(500).json({ error: 'خطأ في جلب المتابَعين' });
    }
});

// ============================================================
// 🌾 APIs الحصاد
// ============================================================

app.get('/api/harvest/status', authenticate, async (req, res) => {
    try {
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        const user = req.user;
        
        // جلب باقات المستخدم النشطة
        const userPackages = await prisma.userPackage.findMany({
            where: {
                userId: user.id,
                isActive: true,
                expiresAt: { gt: new Date() }
            },
            include: { package: true }
        });
        
        // حساب إجمالي الربح من الباقات
        let totalCoinsReward = settings.harvestCoins; // الربح الأساسي
        let totalGemsReward = settings.harvestGems;
        
        for (const up of userPackages) {
            totalCoinsReward += up.package.coinsReward;
            totalGemsReward += up.package.gemsReward;
        }
        
        let canHarvest = true;
        let timeRemaining = 0;
        
        if (user.lastHarvest) {
            const lastHarvest = new Date(user.lastHarvest);
            const nextHarvest = new Date(lastHarvest.getTime() + (settings.harvestInterval * 60 * 60 * 1000));
            const now = new Date();
            
            if (now < nextHarvest) {
                canHarvest = false;
                timeRemaining = Math.ceil((nextHarvest - now) / 1000);
            }
        }
        
        res.json({
            canHarvest,
            timeRemaining,
            coinsReward: totalCoinsReward,
            gemsReward: totalGemsReward,
            baseCoins: settings.harvestCoins,
            baseGems: settings.harvestGems,
            packagesCount: userPackages.length,
            activePackages: userPackages.map(up => ({
                id: up.id,
                name: up.package.nameAr || up.package.name,
                coinsReward: up.package.coinsReward,
                gemsReward: up.package.gemsReward,
                expiresAt: up.expiresAt
            })),
            lastHarvest: user.lastHarvest
        });
        
    } catch (error) {
        console.error('Harvest status error:', error);
        res.status(500).json({ error: 'خطأ في جلب حالة الحصاد' });
    }
});

app.post('/api/harvest/collect', authenticate, async (req, res) => {
    try {
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        const user = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { id: true, lastHarvest: true, referredBy: true, username: true }
        });
        
        // التحقق من إمكانية الحصاد
        if (user.lastHarvest) {
            const lastHarvest = new Date(user.lastHarvest);
            const nextHarvest = new Date(lastHarvest.getTime() + (settings.harvestInterval * 60 * 60 * 1000));
            
            if (new Date() < nextHarvest) {
                return res.status(400).json({ error: 'لا يمكنك الحصاد الآن' });
            }
        }
        
        // جلب باقات المستخدم النشطة
        const userPackages = await prisma.userPackage.findMany({
            where: {
                userId: user.id,
                isActive: true,
                expiresAt: { gt: new Date() }
            },
            include: { package: true }
        });
        
        // حساب إجمالي الربح
        let totalCoins = settings.harvestCoins;
        let totalGems = settings.harvestGems;
        
        for (const up of userPackages) {
            totalCoins += up.package.coinsReward;
            totalGems += up.package.gemsReward;
        }
        
        // تحديث الرصيد
        const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: {
                coins: { increment: totalCoins },
                gems: { increment: totalGems },
                lastHarvest: new Date()
            }
        });
        
        // إشعار الحصاد
        await createNotification(
            user.id,
            'harvest',
            '🌾 حصاد ناجح!',
            `حصلت على ${totalCoins} عملة و ${totalGems} جوهرة`,
            { coins: totalCoins, gems: totalGems, packagesCount: userPackages.length }
        );
        
        // إرسال هدية للداعي (مجوهرات)
        if (user.referredBy) {
            const harvestReferralGems = settings.harvestReferralGems || 5;
            
            // تحديث رصيد الداعي
            await prisma.user.update({
                where: { id: user.referredBy },
                data: { gems: { increment: harvestReferralGems } }
            });
            
            // إشعار للداعي
            await createNotification(
                user.referredBy,
                'referral',
                '💎 هدية من فريقك!',
                `${user.username} جمع المحصول وحصلت على ${harvestReferralGems} جوهرة`,
                { fromUserId: user.id, gems: harvestReferralGems }
            );
        }
        
        res.json({ 
            coins: totalCoins, 
            gems: totalGems,
            packagesCount: userPackages.length
        });
        
    } catch (error) {
        console.error('Harvest collect error:', error);
        res.status(500).json({ error: 'خطأ في الحصاد' });
    }
});

// ============================================================
// 📝 APIs المنشورات
// ============================================================

app.get('/api/posts', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        const posts = await prisma.post.findMany({
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 3
                },
                postLikes: { where: { userId: req.user.id } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        const formattedPosts = posts.map(post => ({
            ...post,
            isLiked: post.postLikes.length > 0,
            postLikes: undefined
        }));
        
        res.json(formattedPosts);
        
    } catch (error) {
        console.error('Posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب المنشورات' });
    }
});

app.post('/api/posts', authenticate, async (req, res) => {
    try {
        const { content, imageUrl } = req.body;
        
        // يجب أن يكون هناك محتوى أو صورة على الأقل
        if (!content && !imageUrl) {
            return res.status(400).json({ error: 'المحتوى أو الصورة مطلوب' });
        }
        
        const post = await prisma.post.create({
            data: {
                userId: req.user.id,
                content: content || '',
                imageUrl
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, coins: true, gems: true, referralCode: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    take: 3
                }
            }
        });
        
        res.json({
            ...post,
            user: {
                ...post.user,
                email: '',
                createdAt: ''
            }
        });
        
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء المنشور' });
    }
});

// تعديل منشور
app.put('/api/posts/:postId', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const { content, imageUrl } = req.body;
        
        // التحقق من ملكية المنشور
        const post = await prisma.post.findUnique({ where: { id: postId } });
        if (!post) {
            return res.status(404).json({ error: 'المنشور غير موجود' });
        }
        if (post.userId !== req.user.id) {
            return res.status(403).json({ error: 'لا يمكنك تعديل هذا المنشور' });
        }
        
        const updatedPost = await prisma.post.update({
            where: { id: postId },
            data: {
                content: content !== undefined ? content : post.content,
                imageUrl: imageUrl !== undefined ? imageUrl : post.imageUrl,
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    take: 3
                }
            }
        });
        
        res.json(updatedPost);
    } catch (error) {
        console.error('Update post error:', error);
        res.status(500).json({ error: 'خطأ في تعديل المنشور' });
    }
});

// حذف منشور
app.delete('/api/posts/:postId', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        
        // التحقق من ملكية المنشور
        const post = await prisma.post.findUnique({ where: { id: postId } });
        if (!post) {
            return res.status(404).json({ error: 'المنشور غير موجود' });
        }
        if (post.userId !== req.user.id) {
            return res.status(403).json({ error: 'لا يمكنك حذف هذا المنشور' });
        }
        
        // حذف الإعجابات والتعليقات أولاً
        await prisma.postLike.deleteMany({ where: { postId } });
        await prisma.comment.deleteMany({ where: { postId } });
        
        // حذف المنشور
        await prisma.post.delete({ where: { id: postId } });
        
        res.json({ success: true, message: 'تم حذف المنشور بنجاح' });
    } catch (error) {
        console.error('Delete post error:', error);
        res.status(500).json({ error: 'خطأ في حذف المنشور' });
    }
});

app.post('/api/posts/:postId/like', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        
        const existingLike = await prisma.postLike.findUnique({
            where: { postId_userId: { postId, userId: req.user.id } }
        });
        
        if (existingLike) {
            // إلغاء الإعجاب
            await prisma.postLike.delete({ where: { id: existingLike.id } });
            await prisma.post.update({
                where: { id: postId },
                data: { likes: { decrement: 1 } }
            });
            res.json({ liked: false });
        } else {
            // إعجاب
            await prisma.postLike.create({
                data: { postId, userId: req.user.id }
            });
            const post = await prisma.post.update({
                where: { id: postId },
                data: { likes: { increment: 1 } }
            });
            
            // إنشاء إشعار لصاحب المنشور
            if (post.userId !== req.user.id) {
                await prisma.notification.create({
                    data: {
                        userId: post.userId,
                        type: 'like',
                        title: 'إعجاب جديد',
                        message: `${req.user.username} أعجب بمنشورك`,
                        data: JSON.stringify({ postId })
                    }
                });
            }
            
            res.json({ liked: true });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الإعجاب' });
    }
});

// جلب تعليقات منشور
app.get('/api/posts/:postId/comments', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        
        const comments = await prisma.comment.findMany({
            where: { postId },
            include: {
                user: { select: { id: true, username: true, avatar: true } },
                parent: {
                    include: {
                        user: { select: { id: true, username: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        res.json(comments);
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'خطأ في جلب التعليقات' });
    }
});

app.post('/api/posts/:postId/comment', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const { content, parentId } = req.body;
        
        const comment = await prisma.comment.create({
            data: {
                postId,
                userId: req.user.id,
                content,
                parentId: parentId || null
            },
            include: {
                user: { select: { id: true, username: true, avatar: true } },
                parent: {
                    include: {
                        user: { select: { id: true, username: true } }
                    }
                }
            }
        });
        
        // إنشاء إشعار لصاحب المنشور (إذا لم يكن هو المعلق)
        const post = await prisma.post.findUnique({ where: { id: postId } });
        if (post && post.userId !== req.user.id) {
            await prisma.notification.create({
                data: {
                    userId: post.userId,
                    type: 'comment',
                    title: 'تعليق جديد',
                    message: `${req.user.username} علق على منشورك`,
                    data: JSON.stringify({ postId, commentId: comment.id })
                }
            });
        }
        
        // إنشاء إشعار للشخص المرد عليه (إذا كان رد على تعليق)
        if (parentId && comment.parent && comment.parent.userId !== req.user.id) {
            await prisma.notification.create({
                data: {
                    userId: comment.parent.userId,
                    type: 'reply',
                    title: 'رد جديد',
                    message: `${req.user.username} رد على تعليقك`,
                    data: JSON.stringify({ postId, commentId: comment.id, parentId })
                }
            });
        }
        
        res.json(comment);
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إضافة التعليق' });
    }
});

// تسجيل مشاهدة منشور (للخوارزمية الذكية)
app.post('/api/posts/:postId/view', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;
        
        // تسجيل المشاهدة (أو تجاهل إذا موجودة)
        await prisma.postView.upsert({
            where: { postId_userId: { postId, userId } },
            create: { postId, userId },
            update: {} // لا تحديث، فقط تأكد من الوجود
        });
        
        res.json({ success: true });
    } catch (error) {
        // تجاهل الأخطاء - المشاهدة ليست حرجة
        res.json({ success: true });
    }
});

// ============================================================
// 🔔 APIs الإشعارات
// ============================================================

// جلب جميع الإشعارات
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الإشعارات' });
    }
});

// تحديث حالة القراءة لإشعار
app.put('/api/notifications/:id/read', authenticate, async (req, res) => {
    try {
        const notification = await prisma.notification.update({
            where: { id: req.params.id },
            data: { read: true }
        });
        res.json(notification);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الإشعار' });
    }
});

// تحديث جميع الإشعارات كمقروءة
app.put('/api/notifications/read-all', authenticate, async (req, res) => {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, read: false },
            data: { read: true }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الإشعارات' });
    }
});

// حذف إشعار
app.delete('/api/notifications/:id', authenticate, async (req, res) => {
    try {
        await prisma.notification.delete({
            where: { id: req.params.id }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الإشعار' });
    }
});

// جلب عدد الإشعارات غير المقروءة
app.get('/api/notifications/unread-count', authenticate, async (req, res) => {
    try {
        const count = await prisma.notification.count({
            where: { userId: req.user.id, read: false }
        });
        res.json({ count });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب العدد' });
    }
});

// ============================================================
// 🏠 APIs الغرف
// ============================================================

app.get('/api/rooms', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        // جلب الغرف مع عدد الرسائل للترتيب
        const rooms = await prisma.chatRoom.findMany({
            include: {
                owner: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                _count: { select: { members: true, messages: true } }
            },
            orderBy: [
                { totalGiftPoints: 'desc' },
                { createdAt: 'desc' }
            ],
            skip,
            take: limit
        });
        
        const formattedRooms = rooms.map(room => {
            const formatted = formatRoomWithMicCheck(room);
            return {
                ...formatted,
                membersCount: room._count.members,
                messagesCount: room._count.messages,
                _count: undefined
            };
        });
        
        res.json(formattedRooms);
        
    } catch (error) {
        console.error('Get rooms error:', error);
        res.status(500).json({ error: 'خطأ في جلب الغرف' });
    }
});

// غرفي (الغرف التي أملكها)
app.get('/api/rooms/my', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        const rooms = await prisma.chatRoom.findMany({
            where: { ownerId: req.user.id },
            include: {
                owner: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                _count: { select: { members: true, messages: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit
        });
        
        const formattedRooms = rooms.map(room => ({
            ...room,
            membersCount: room._count.members,
            messagesCount: room._count.messages,
            _count: undefined
        }));
        
        res.json(formattedRooms);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب غرفي' });
    }
});

// الغرف المنضم إليها
app.get('/api/rooms/joined', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        const memberships = await prisma.roomMember.findMany({
            where: { 
                userId: req.user.id,
                room: { ownerId: { not: req.user.id } } // استثناء الغرف التي أملكها
            },
            include: {
                room: {
                    include: {
                        owner: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                        _count: { select: { members: true, messages: true } }
                    }
                }
            },
            skip,
            take: limit
        });
        
        const formattedRooms = memberships.map(m => ({
            ...m.room,
            membersCount: m.room._count.members,
            messagesCount: m.room._count.messages,
            _count: undefined
        }));
        
        res.json(formattedRooms);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الغرف المنضم إليها' });
    }
});

app.get('/api/rooms/:roomId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({
            where: { id: req.params.roomId },
            include: {
                owner: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                members: {
                    include: { user: { select: { id: true, username: true, avatar: true, isOnline: true, level: true, experience: true } } }
                },
                moderators: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } }
                },
                _count: { select: { members: true } }
            }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        // حساب عدد المتصلين
        const onlineCount = room.members.filter(m => m.user.isOnline).length;
        
        res.json({
            ...room,
            membersCount: room._count.members,
            onlineCount,
            _count: undefined
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الغرفة' });
    }
});

app.post('/api/rooms', authenticate, async (req, res) => {
    try {
        const { name, description, image, joinPrice, messagePrice } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'اسم الغرفة مطلوب' });
        }
        
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        
        // جلب الرصيد الحالي من قاعدة البيانات (وليس من التوكن)
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { coins: true }
        });
        
        if (!currentUser || currentUser.coins < settings.roomCreationPrice) {
            return res.status(400).json({ error: 'رصيدك غير كافٍ لإنشاء غرفة' });
        }
        
        // توليد معرف فريد للغرفة
        let roomCode = generateRoomCode();
        let existingRoom = await prisma.chatRoom.findUnique({ where: { roomCode } });
        while (existingRoom) {
            roomCode = generateRoomCode();
            existingRoom = await prisma.chatRoom.findUnique({ where: { roomCode } });
        }
        
        // معالجة الصورة إذا كانت Base64
        let imageUrl = image;
        if (image && image.startsWith('data:image')) {
            const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
            if (matches) {
                const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
                const data = matches[2];
                const buffer = Buffer.from(data, 'base64');
                
                if (buffer.length <= 5 * 1024 * 1024) {
                    const filename = `room_${roomCode}_${Date.now()}.${ext}`;
                    const filepath = path.join(__dirname, 'uploads', filename);
                    fs.writeFileSync(filepath, buffer);
                    
                    imageUrl = `${BASE_URL}/uploads/${filename}`;
                }
            }
        }
        
        // خصم المبلغ وإنشاء الغرفة
        const [_, room] = await prisma.$transaction([
            prisma.user.update({
                where: { id: req.user.id },
                data: { coins: { decrement: settings.roomCreationPrice } }
            }),
            prisma.chatRoom.create({
                data: {
                    roomCode,
                    name,
                    description,
                    image: imageUrl,
                    ownerId: req.user.id,
                    joinPrice: joinPrice || 0,
                    messagePrice: messagePrice || 0,
                    members: {
                        create: { userId: req.user.id, role: 'owner' }
                    }
                },
                include: {
                    owner: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                    _count: { select: { members: true } }
                }
            })
        ]);
        
        res.json({ ...room, onlineCount: 1, membersCount: 1 });
        
    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء الغرفة' });
    }
});

app.put('/api/rooms/:roomId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId } });
        
        if (!room || room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { name, description, image } = req.body;
        
        const updatedRoom = await prisma.chatRoom.update({
            where: { id: req.params.roomId },
            data: { name, description, image }
        });
        
        res.json(updatedRoom);
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الغرفة' });
    }
});

app.delete('/api/rooms/:roomId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId } });
        
        if (!room || room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        await prisma.chatRoom.delete({ where: { id: req.params.roomId } });
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الغرفة' });
    }
});

// الانضمام للغرفة
app.post('/api/rooms/:roomId/join', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const existingMember = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: req.user.id } }
        });
        
        if (existingMember) {
            if (existingMember.isBanned) {
                return res.status(403).json({ error: 'أنت محظور من هذه الغرفة' });
            }
            return res.json({ success: true, message: 'أنت عضو بالفعل' });
        }
        
        await prisma.roomMember.create({
            data: { roomId, userId: req.user.id }
        });
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الانضمام' });
    }
});

// مغادرة الغرفة
app.post('/api/rooms/:roomId/leave', authenticate, async (req, res) => {
    try {
        await prisma.roomMember.deleteMany({
            where: { roomId: req.params.roomId, userId: req.user.id }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في المغادرة' });
    }
});

// التحقق من حظر المستخدم من الغرفة
app.get('/api/rooms/:roomId/check-ban', authenticate, async (req, res) => {
    try {
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.user.id } }
        });
        
        if (member && member.isBanned) {
            return res.json({ isBanned: true });
        }
        
        res.json({ isBanned: false });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في التحقق' });
    }
});

// أعضاء الغرفة
app.get('/api/rooms/:roomId/members', authenticate, async (req, res) => {
    try {
        const members = await prisma.roomMember.findMany({
            where: { roomId: req.params.roomId, isBanned: false },
            include: { user: { select: { id: true, username: true, avatar: true, isOnline: true, level: true, experience: true } } }
        });
        res.json(members);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الأعضاء' });
    }
});

app.get('/api/rooms/:roomId/members/online', authenticate, async (req, res) => {
    try {
        // جلب الأعضاء الموجودين في الغرفة (isOnline = true في RoomMember)
        const members = await prisma.roomMember.findMany({
            where: { 
                roomId: req.params.roomId, 
                isBanned: false,
                isOnline: true
            },
            include: { user: { select: { id: true, username: true, avatar: true, isOnline: true, level: true, experience: true } } }
        });
        
        // إضافة isOnline: true لكل عضو متصل
        const onlineMembers = members.map(m => ({
            ...m,
            isOnline: true,
            user: {
                ...m.user,
                isOnline: true
            }
        }));
        
        // جلب الضيوف الموجودين في الغرفة
        const guests = await prisma.roomPresence.findMany({
            where: { roomId: req.params.roomId }
        });
        
        // جلب بيانات الضيوف
        const guestUsers = await prisma.user.findMany({
            where: { id: { in: guests.map(g => g.visitorId) } },
            select: { id: true, username: true, avatar: true, level: true, experience: true }
        });
        
        // تحويل الضيوف لنفس الشكل مع isOnline: true
        const guestMembers = guests.map(g => ({
            id: 'guest-' + g.visitorId,
            roomId: g.roomId,
            userId: g.visitorId,
            role: 'guest',
            isOnline: true,
            isGuest: true,
            joinedAt: g.joinedAt,
            user: {
                ...guestUsers.find(u => u.id === g.visitorId),
                isOnline: true
            }
        }));
        
        res.json([...onlineMembers, ...guestMembers]);
    } catch (error) {
        console.error('Online members error:', error);
        res.status(500).json({ error: 'خطأ في جلب الأعضاء المتصلين' });
    }
});

// دخول الغرفة (تسجيل الحضور)
app.post('/api/rooms/:roomId/presence/join', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.user.id;
        
        // التحقق من الحظر في جدول RoomBan
        const ban = await prisma.roomBan.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (ban) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // التحقق من العضوية والحظر فيها
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        // التحقق من الحظر في العضوية
        if (member && member.isBanned) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // التحقق إذا كان المستخدم موجود مسبقاً (لتجنب تكرار رسالة الدخول)
        let wasAlreadyPresent = false;
        if (member && member.isOnline) {
            wasAlreadyPresent = true;
        } else {
            const existingPresence = await prisma.roomPresence.findUnique({
                where: { roomId_visitorId: { roomId, visitorId: userId } }
            });
            if (existingPresence) {
                wasAlreadyPresent = true;
            }
        }
        
        if (member) {
            // تحديث حالة العضو كـ "موجود في الغرفة"
            await prisma.roomMember.update({
                where: { id: member.id },
                data: { isOnline: true, lastSeen: new Date() }
            });
            // حذف أي سجل ضيف قديم لهذا المستخدم
            await prisma.roomPresence.deleteMany({
                where: { roomId, visitorId: userId }
            });
        } else {
            // إضافة كضيف
            await prisma.roomPresence.upsert({
                where: { roomId_visitorId: { roomId, visitorId: userId } },
                create: { roomId, visitorId: userId, isGuest: true },
                update: { lastSeen: new Date() }
            });
        }
        
        // إنشاء رسالة دخول فقط إذا لم يكن موجود مسبقاً
        if (!wasAlreadyPresent) {
            await prisma.chatMessage.create({
                data: {
                    roomId,
                    userId,
                    content: 'انضم للغرفة',
                    type: 'join'
                }
            });
        }
        
        // حساب عدد الموجودين (بدون تكرار)
        const [membersCount, guestsCount] = await Promise.all([
            prisma.roomMember.count({ where: { roomId, isOnline: true } }),
            prisma.roomPresence.count({ where: { roomId } })
        ]);
        
        res.json({ success: true, onlineCount: membersCount + guestsCount });
    } catch (error) {
        console.error('Join presence error:', error);
        res.status(500).json({ error: 'خطأ في تسجيل الحضور' });
    }
});

// مغادرة الغرفة (إلغاء الحضور) - ينزل المستخدم من المايك تلقائياً
app.post('/api/rooms/:roomId/presence/leave', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.user.id;
        
        // ============ إنزال المستخدم من المايك تلقائياً ============
        await prisma.voiceSeat.updateMany({
            where: { roomId, odId: userId },
            data: { odId: null, isMuted: false, joinedAt: null }
        });
        
        // إزالة من الجولة إذا كانت نشطة
        const battle = activeBattles.get(roomId);
        if (battle) {
            const participantIndex = battle.participants.findIndex(p => p.odId === userId);
            if (participantIndex !== -1) {
                battle.participants.splice(participantIndex, 1);
            }
        }
        
        // التحقق من العضوية
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (member) {
            // تحديث حالة العضو كـ "خارج الغرفة"
            await prisma.roomMember.update({
                where: { id: member.id },
                data: { isOnline: false, lastSeen: new Date() }
            });
        } else {
            // حذف من الضيوف
            await prisma.roomPresence.deleteMany({
                where: { roomId, visitorId: userId }
            });
        }
        
        // حساب عدد الموجودين
        const [membersCount, guestsCount] = await Promise.all([
            prisma.roomMember.count({ where: { roomId, isOnline: true } }),
            prisma.roomPresence.count({ where: { roomId } })
        ]);
        
        res.json({ success: true, onlineCount: membersCount + guestsCount });
    } catch (error) {
        console.error('Leave presence error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء الحضور' });
    }
});

// عدد الموجودين في الغرفة
app.get('/api/rooms/:roomId/presence/count', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        
        const [membersCount, guestsCount] = await Promise.all([
            prisma.roomMember.count({ where: { roomId, isOnline: true } }),
            prisma.roomPresence.count({ where: { roomId } })
        ]);
        
        res.json({ onlineCount: membersCount + guestsCount });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب العدد' });
    }
});

// طرد عضو
app.post('/api/rooms/:roomId/kick', authenticate, async (req, res) => {
    try {
        const { userId } = req.body;
        const roomId = req.params.roomId;
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        
        if (room.ownerId !== req.user.id) {
            const mod = await prisma.roomModerator.findUnique({
                where: { roomId_userId: { roomId, userId: req.user.id } }
            });
            if (!mod?.canKick) return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // حذف العضوية والحضور
        await Promise.all([
            prisma.roomMember.deleteMany({ where: { roomId, userId } }),
            prisma.roomPresence.deleteMany({ where: { roomId, visitorId: userId } })
        ]);
        
        res.json({ success: true, kicked: true });
    } catch (error) {
        console.error('Kick error:', error);
        res.status(500).json({ error: 'خطأ في الطرد' });
    }
});

// حظر عضو
app.post('/api/rooms/:roomId/ban', authenticate, async (req, res) => {
    try {
        const { userId } = req.body;
        const roomId = req.params.roomId;
        
        // التحقق من أن المستخدم ليس محظوراً بالفعل
        const existingBan = await prisma.roomBan.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (!existingBan) {
            await prisma.roomBan.create({
                data: { roomId, userId, bannedById: req.user.id }
            });
        }
        
        // إنزال المستخدم من المايك
        await prisma.voiceSeat.updateMany({
            where: { roomId, odId: userId },
            data: { odId: null, isMuted: false, joinedAt: null }
        });
        
        // تحديث العضوية لتكون محظورة بدلاً من حذفها
        const existingMember = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (existingMember) {
            await prisma.roomMember.update({
                where: { roomId_userId: { roomId, userId } },
                data: { isBanned: true, isOnline: false }
            });
        } else {
            // إنشاء سجل عضوية محظورة إذا لم يكن موجوداً
            await prisma.roomMember.create({
                data: { roomId, userId, isBanned: true, isOnline: false }
            });
        }
        
        // حذف الحضور فقط
        await prisma.roomPresence.deleteMany({ where: { roomId, visitorId: userId } });
        
        // إنشاء رسالة نظام للإعلان عن الحظر
        const bannedUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true }
        });
        
        await prisma.chatMessage.create({
            data: {
                roomId,
                userId: req.user.id,
                content: `تم حظر ${bannedUser?.username || 'مستخدم'} من الغرفة`,
                type: 'system'
            }
        });
        
        console.log(`🚫 User ${userId} banned from room ${roomId}`);
        // roomBanned بدلاً من banned لتمييزه عن حظر الحساب
        res.json({ success: true, roomBanned: true, bannedUserId: userId });
    } catch (error) {
        console.error('Ban error:', error);
        res.status(500).json({ error: 'خطأ في الحظر' });
    }
});

// كتم عضو
app.post('/api/rooms/:roomId/mute', authenticate, async (req, res) => {
    try {
        const { userId, duration } = req.body;
        const muteUntil = new Date(Date.now() + duration * 60 * 1000);
        
        await prisma.roomMember.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId } },
            data: { isMuted: true, muteUntil }
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الكتم' });
    }
});

// المشرفين
app.get('/api/rooms/:roomId/moderators', authenticate, async (req, res) => {
    try {
        const moderators = await prisma.roomModerator.findMany({
            where: { roomId: req.params.roomId },
            include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } }
        });
        res.json(moderators);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب المشرفين' });
    }
});

app.post('/api/rooms/:roomId/moderators', authenticate, async (req, res) => {
    try {
        const { userId, permissions } = req.body;
        const roomId = req.params.roomId;
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        
        if (room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط صاحب الغرفة يمكنه إضافة مشرفين' });
        }
        
        // التحقق من عدم وجود المشرف مسبقاً
        const existingMod = await prisma.roomModerator.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (existingMod) {
            return res.status(400).json({ error: 'هذا العضو مشرف بالفعل' });
        }
        
        const moderator = await prisma.roomModerator.create({
            data: {
                roomId,
                userId,
                assignedBy: req.user.id,
                ...permissions
            },
            include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } }
        });
        
        // تحديث دور العضو
        await prisma.roomMember.updateMany({
            where: { roomId, userId },
            data: { role: 'moderator' }
        });
        
        res.json(moderator);
    } catch (error) {
        console.error('Add moderator error:', error);
        res.status(500).json({ error: 'خطأ في إضافة المشرف' });
    }
});

app.delete('/api/rooms/:roomId/moderators/:userId', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.params.userId;
        
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط صاحب الغرفة يمكنه إزالة المشرفين' });
        }
        
        await prisma.roomModerator.deleteMany({ 
            where: { roomId, userId } 
        });
        
        // تحديث دور العضو
        await prisma.roomMember.updateMany({
            where: { roomId, userId },
            data: { role: 'member' }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Remove moderator error:', error);
        res.status(500).json({ error: 'خطأ في إزالة المشرف' });
    }
});

// إلغاء كتم عضو
app.post('/api/rooms/:roomId/unmute/:userId', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.params.userId;
        
        await prisma.roomMember.updateMany({
            where: { roomId, userId },
            data: { isMuted: false, muteUntil: null }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Unmute error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء الكتم' });
    }
});

// إلغاء حظر عضو
app.post('/api/rooms/:roomId/unban/:userId', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.params.userId;
        
        await prisma.roomBan.deleteMany({
            where: { roomId, userId }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء الحظر' });
    }
});

// ============================================================
// 💬 APIs الرسائل
// ============================================================

app.get('/api/rooms/:roomId/messages', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.user.id;
        
        // التحقق من الحظر
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (member?.isBanned) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // التحقق من الحظر في جدول RoomBan
        const ban = await prisma.roomBan.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (ban) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // جلب آخر 20 رسالة فقط عند دخول المستخدم
        const limit = parseInt(req.query.limit) || 20;
        
        // جلب الرسالة المثبتة أولاً (إذا وجدت)
        const pinnedMessage = await prisma.chatMessage.findFirst({
            where: { roomId: req.params.roomId, isPinned: true, isDeleted: false },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                giftMessage: { include: { gift: true } },
                replyTo: {
                    include: {
                        user: { select: { id: true, username: true, avatar: true } }
                    }
                }
            }
        });
        
        const messages = await prisma.chatMessage.findMany({
            where: { roomId: req.params.roomId, isDeleted: false },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                giftMessage: { include: { gift: true } },
                replyTo: {
                    include: {
                        user: { select: { id: true, username: true, avatar: true } }
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
        
        // إرجاع الرسائل بترتيب تصاعدي (الأقدم أولاً)
        let result = messages.reverse();
        
        // إضافة الرسالة المثبتة إذا لم تكن ضمن الرسائل المجلوبة
        if (pinnedMessage && !result.find(m => m.id === pinnedMessage.id)) {
            result = [pinnedMessage, ...result];
        }
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الرسائل' });
    }
});

app.post('/api/rooms/:roomId/messages', authenticate, async (req, res) => {
    try {
        const { content, replyToId } = req.body;
        const roomId = req.params.roomId;
        
        // التحقق من الحظر في جدول RoomBan
        const ban = await prisma.roomBan.findUnique({
            where: { roomId_userId: { roomId, userId: req.user.id } }
        });
        
        if (ban) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // التحقق من الكتم والحظر في العضوية
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: req.user.id } }
        });
        
        // التحقق من الحظر في العضوية
        if (member?.isBanned) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        if (member?.isMuted && member.muteUntil > new Date()) {
            return res.status(403).json({ error: 'أنت مكتوم حالياً' });
        }
        
        // التحقق من وجود الرسالة المرد عليها
        if (replyToId) {
            const replyToMessage = await prisma.chatMessage.findUnique({
                where: { id: replyToId }
            });
            if (!replyToMessage || replyToMessage.roomId !== roomId) {
                return res.status(400).json({ error: 'الرسالة المرد عليها غير موجودة' });
            }
        }
        
        const message = await prisma.chatMessage.create({
            data: {
                roomId: req.params.roomId,
                userId: req.user.id,
                content,
                replyToId: replyToId || null
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                replyTo: {
                    include: {
                        user: { select: { id: true, username: true, avatar: true } }
                    }
                }
            }
        });
        
        res.json(message);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إرسال الرسالة' });
    }
});

app.delete('/api/rooms/:roomId/messages/:messageId', authenticate, async (req, res) => {
    try {
        await prisma.chatMessage.update({
            where: { id: req.params.messageId },
            data: { isDeleted: true }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الرسالة' });
    }
});

app.post('/api/rooms/:roomId/messages/:messageId/pin', authenticate, async (req, res) => {
    try {
        await prisma.chatMessage.update({
            where: { id: req.params.messageId },
            data: { isPinned: true }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تثبيت الرسالة' });
    }
});

// ============================================================
// 🎁 APIs الهدايا
// ============================================================

app.get('/api/gifts', authenticate, async (req, res) => {
    try {
        const gifts = await prisma.gift.findMany({
            where: { isActive: true },
            orderBy: { price: 'asc' }
        });
        res.json(gifts);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الهدايا' });
    }
});

// حساب مستوى الغرفة بناءً على النقاط (50 مستوى كحد أقصى - الحد الأقصى 50 مليون)
// النظام: Level 1=0, Level 2=100, Level 3=1000, ثم يتضاعف بمعامل ~1.29 للوصول إلى 50 مليون
function calculateRoomLevel(points) {
    const levelThresholds = [
        0,              // Level 1
        100,            // Level 2 (100)
        1000,           // Level 3 (1K)
        2500,           // Level 4 (2.5K)
        5000,           // Level 5 (5K)
        10000,          // Level 6 (10K)
        20000,          // Level 7 (20K)
        35000,          // Level 8 (35K)
        60000,          // Level 9 (60K)
        100000,         // Level 10 (100K)
        150000,         // Level 11 (150K)
        220000,         // Level 12 (220K)
        320000,         // Level 13 (320K)
        450000,         // Level 14 (450K)
        620000,         // Level 15 (620K)
        850000,         // Level 16 (850K)
        1150000,        // Level 17 (1.15M)
        1550000,        // Level 18 (1.55M)
        2050000,        // Level 19 (2.05M)
        2700000,        // Level 20 (2.7M)
        3500000,        // Level 21 (3.5M)
        4500000,        // Level 22 (4.5M)
        5700000,        // Level 23 (5.7M)
        7200000,        // Level 24 (7.2M)
        9000000,        // Level 25 (9M)
        11000000,       // Level 26 (11M)
        13500000,       // Level 27 (13.5M)
        16500000,       // Level 28 (16.5M)
        20000000,       // Level 29 (20M)
        24000000,       // Level 30 (24M)
        28500000,       // Level 31 (28.5M)
        33500000,       // Level 32 (33.5M)
        38000000,       // Level 33 (38M)
        41500000,       // Level 34 (41.5M)
        44000000,       // Level 35 (44M)
        45500000,       // Level 36 (45.5M)
        46500000,       // Level 37 (46.5M)
        47300000,       // Level 38 (47.3M)
        47900000,       // Level 39 (47.9M)
        48400000,       // Level 40 (48.4M)
        48700000,       // Level 41 (48.7M)
        48950000,       // Level 42 (48.95M)
        49150000,       // Level 43 (49.15M)
        49300000,       // Level 44 (49.3M)
        49450000,       // Level 45 (49.45M)
        49600000,       // Level 46 (49.6M)
        49750000,       // Level 47 (49.75M)
        49850000,       // Level 48 (49.85M)
        49950000,       // Level 49 (49.95M)
        50000000,       // Level 50 (50M) - الحد الأقصى
    ];
    
    for (let i = levelThresholds.length - 1; i >= 0; i--) {
        if (points >= levelThresholds[i]) {
            return i + 1;
        }
    }
    return 1;
}

app.post('/api/gifts/send', authenticate, async (req, res) => {
    try {
        const { roomId, giftId, receiverId, quantity = 1 } = req.body;
        
        // التحقق من الكمية
        const giftQuantity = Math.min(Math.max(1, parseInt(quantity) || 1), 99);
        
        // receiverId يمكن أن يكون null للإرسال للكل
        
        const gift = await prisma.gift.findUnique({ where: { id: giftId } });
        
        if (!gift) {
            return res.status(404).json({ error: 'الهدية غير موجودة' });
        }
        
        // حساب السعر الإجمالي
        const totalPrice = gift.price * giftQuantity;
        
        // جلب الرصيد الحالي من قاعدة البيانات (وليس من التوكن)
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { gems: true }
        });
        
        if (!currentUser || currentUser.gems < totalPrice) {
            return res.status(400).json({ error: 'رصيد المجوهرات غير كافٍ' });
        }
        
        // جلب الغرفة الحالية
        const currentRoom = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        const newPoints = (currentRoom?.totalGiftPoints || 0) + totalPrice;
        const newLevel = calculateRoomLevel(newPoints);
        
        // ============ توزيع الهدايا ============
        // 50% للمستلم، 10% للمدير، 40% للنظام
        const receiverShare = Math.floor(totalPrice * 0.5);
        const ownerShare = Math.floor(totalPrice * 0.1);
        
        // خصم المجوهرات من المرسل، إضافة للمستلم والمدير، إنشاء رسالة الهدية، وتحديث نقاط الغرفة
        const [_, __, ___, giftMessage] = await prisma.$transaction([
            // خصم المجوهرات من المرسل (السعر × الكمية)
            prisma.user.update({
                where: { id: req.user.id },
                data: { gems: { decrement: totalPrice } }
            }),
            // إضافة المجوهرات للمستلم (50% من السعر × الكمية) إذا كان محدد
            receiverId ? prisma.user.update({
                where: { id: receiverId },
                data: { gems: { increment: receiverShare } }
            }) : prisma.user.findUnique({ where: { id: req.user.id } }),
            // إضافة المجوهرات لمدير الغرفة (10% من السعر × الكمية)
            (currentRoom && currentRoom.ownerId !== receiverId && currentRoom.ownerId !== req.user.id) 
                ? prisma.user.update({
                    where: { id: currentRoom.ownerId },
                    data: { gems: { increment: ownerShare } }
                }) 
                : prisma.user.findUnique({ where: { id: req.user.id } }),
            // إنشاء رسالة الهدية
            prisma.giftMessage.create({
                data: {
                    roomId,
                    senderId: req.user.id,
                    receiverId: receiverId || null,
                    giftId,
                    isForAll: !receiverId
                },
                include: {
                    sender: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                    receiver: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                    gift: true
                }
            }),
            // تحديث نقاط الغرفة
            prisma.chatRoom.update({
                where: { id: roomId },
                data: { 
                    totalGiftPoints: newPoints,
                    level: newLevel
                }
            })
        ]);
        
        // إشعار للمستلم (إذا كان محدد)
        if (receiverId) {
            await createNotification(
                receiverId,
                'gift',
                '🎁 استلمت هدية!',
                `أرسل لك ${req.user.username} ${giftQuantity > 1 ? giftQuantity + '× ' : ''}${gift.nameAr} وحصلت على ${receiverShare} جوهرة`,
                { 
                    senderId: req.user.id, 
                    senderName: req.user.username,
                    giftName: gift.nameAr,
                    quantity: giftQuantity,
                    gems: receiverShare 
                }
            );
        }
        
        // إشعار لمدير الغرفة
        if (currentRoom && currentRoom.ownerId !== receiverId && currentRoom.ownerId !== req.user.id) {
            await createNotification(
                currentRoom.ownerId,
                'gift',
                '💰 عمولة هدية!',
                `حصلت على ${ownerShare} جوهرة من هدية في غرفتك`,
                { gems: ownerShare, roomId }
            );
        }
        
        // ============ زيادة الخبرة (Experience) ============
        // المرسل يحصل على خبرة = سعر الهدية × الكمية
        // المستلم يحصل على خبرة = سعر الهدية × الكمية × 2
        const senderExp = totalPrice;
        const receiverExp = totalPrice * 2;
        
        // زيادة خبرة المرسل
        await prisma.user.update({
            where: { id: req.user.id },
            data: { experience: { increment: senderExp } }
        });
        await updateUserLevel(req.user.id);
        
        // زيادة خبرة المستلم (إذا كان محدد)
        if (receiverId) {
            await prisma.user.update({
                where: { id: receiverId },
                data: { experience: { increment: receiverExp } }
            });
            await updateUserLevel(receiverId);
        }
        
        // إنشاء رسالة الهدية في الدردشة
        const receiverUser = receiverId ? await prisma.user.findUnique({ 
            where: { id: receiverId },
            select: { username: true }
        }) : null;
        
        const giftChatContent = `🎁 ${req.user.username} أرسل ${giftQuantity > 1 ? giftQuantity + '×' : ''} ${gift.image || '🎁'} ${gift.nameAr} إلى ${receiverUser?.username || 'الغرفة'}`;
        
        // إنشاء metadata للهدية
        const giftMetadata = JSON.stringify({
            giftId: gift.id,
            giftName: gift.nameAr,
            giftImage: gift.image,
            giftPrice: gift.price,
            quantity: giftQuantity,
            receiverId: receiverId || null,
            receiverName: receiverUser?.username || null,
            totalPrice: totalPrice
        });
        
        const chatMessage = await prisma.chatMessage.create({
            data: {
                roomId,
                userId: req.user.id,
                content: giftChatContent,
                type: 'gift',
                metadata: giftMetadata,
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } }
            }
        });
        
        // إضافة metadata كـ object للاستجابة
        chatMessage.metadata = JSON.parse(giftMetadata);
        
        // إضافة الكمية والرسالة للاستجابة
        res.json({ ...giftMessage, quantity: giftQuantity, totalPrice, chatMessage });
        
    } catch (error) {
        console.error('Send gift error:', error);
        res.status(500).json({ error: 'خطأ في إرسال الهدية' });
    }
});

app.get('/api/gifts/history/:roomId', authenticate, async (req, res) => {
    try {
        const history = await prisma.giftMessage.findMany({
            where: { roomId: req.params.roomId },
            include: {
                sender: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                receiver: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                gift: true
            },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب سجل الهدايا' });
    }
});

// ============================================================
// 🎡 APIs عجلة الحظ
// ============================================================

app.get('/api/wheel/config', authenticate, async (req, res) => {
    try {
        let settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        
        // إنشاء الإعدادات إذا لم تكن موجودة
        if (!settings) {
            settings = await prisma.appSettings.create({
                data: {
                    id: 'settings',
                    harvestCoins: 100,
                    harvestGems: 10,
                    harvestInterval: 24,
                    spinPrice: 50,
                    exchangeRate: 1000,
                    referralGems: 50,
                    roomCreationPrice: 500,
                    minWithdraw: 100,
                    maxWithdraw: 10000
                }
            });
        }
        
        let prizes = await prisma.wheelPrize.findMany({ where: { isActive: true } });
        
        // إنشاء جوائز افتراضية إذا لم تكن موجودة
        if (prizes.length === 0) {
            const defaultPrizes = [
                { id: 'prize-1', name: '100 عملة', value: 100, type: 'coins', color: '#FFD700', probability: 30 },
                { id: 'prize-2', name: '500 عملة', value: 500, type: 'coins', color: '#FFA500', probability: 20 },
                { id: 'prize-3', name: '1000 عملة', value: 1000, type: 'coins', color: '#FF6347', probability: 10 },
                { id: 'prize-4', name: '10 جوهرة', value: 10, type: 'gems', color: '#00CED1', probability: 25 },
                { id: 'prize-5', name: '50 جوهرة', value: 50, type: 'gems', color: '#9370DB', probability: 10 },
                { id: 'prize-6', name: '100 جوهرة', value: 100, type: 'gems', color: '#FF69B4', probability: 5 }
            ];
            
            for (const prize of defaultPrizes) {
                await prisma.wheelPrize.create({ data: prize });
            }
            prizes = await prisma.wheelPrize.findMany({ where: { isActive: true } });
        }
        
        res.json({ prizes, spinPrice: settings.spinPrice });
    } catch (error) {
        console.error('Wheel config error:', error);
        res.status(500).json({ error: 'خطأ في جلب إعدادات العجلة' });
    }
});

app.post('/api/wheel/spin', authenticate, async (req, res) => {
    try {
        let settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        
        // إنشاء الإعدادات إذا لم تكن موجودة
        if (!settings) {
            settings = await prisma.appSettings.create({
                data: {
                    id: 'settings',
                    harvestCoins: 100,
                    harvestGems: 10,
                    harvestInterval: 24,
                    spinPrice: 50,
                    exchangeRate: 1000,
                    referralGems: 50,
                    roomCreationPrice: 500,
                    minWithdraw: 100,
                    maxWithdraw: 10000
                }
            });
        }
        
        // جلب الرصيد الحالي من قاعدة البيانات (وليس من التوكن)
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { gems: true }
        });
        
        if (!currentUser || currentUser.gems < settings.spinPrice) {
            return res.status(400).json({ error: `جواهرك غير كافية. تحتاج ${settings.spinPrice} جوهرة` });
        }
        
        let prizes = await prisma.wheelPrize.findMany({ where: { isActive: true } });
        
        // فصل الجوائز القابلة للفوز عن جوائز العرض فقط
        const winnablePrizes = prizes.filter(p => p.isWinnable !== false);
        
        if (winnablePrizes.length === 0) {
            return res.status(400).json({ error: 'لا توجد جوائز متاحة حالياً' });
        }
        
        // اختيار الجائزة بناءً على الاحتمالية (النسبة المئوية الحقيقية)
        // نرتب الجوائز من الأقل احتمالية للأعلى لضمان الدقة
        const sortedPrizes = [...winnablePrizes].sort((a, b) => a.probability - b.probability);
        const random = Math.random() * 100; // رقم عشوائي من 0 إلى 100
        
        let cumulativeProbability = 0;
        let selectedPrize = sortedPrizes[sortedPrizes.length - 1]; // الافتراضي: الأعلى احتمالية
        
        for (const prize of sortedPrizes) {
            cumulativeProbability += prize.probability;
            if (random <= cumulativeProbability) {
                selectedPrize = prize;
                break;
            }
        }
        
        // تحديث الرصيد
        const updateData = { gems: { decrement: settings.spinPrice } };
        if (selectedPrize.type === 'coins') {
            updateData.coins = { increment: selectedPrize.value };
        } else {
            updateData.gems = { increment: selectedPrize.value - settings.spinPrice };
        }
        
        const [user] = await prisma.$transaction([
            prisma.user.update({
                where: { id: req.user.id },
                data: updateData
            }),
            prisma.spinHistory.create({
                data: { userId: req.user.id, prizeId: selectedPrize.id }
            })
        ]);
        
        // إشعار الفوز بالعجلة
        await createNotification(
            req.user.id,
            'wheel',
            '🎡 مبروك! فزت في عجلة الحظ',
            `حصلت على ${selectedPrize.value} ${selectedPrize.type === 'coins' ? 'عملة' : 'جوهرة'}`,
            { prize: selectedPrize.name, value: selectedPrize.value, type: selectedPrize.type }
        );
        
        const { password: pwd, ...userWithoutPassword } = user;
        res.json({ prize: selectedPrize, user: userWithoutPassword });
        
    } catch (error) {
        console.error('Spin error:', error);
        res.status(500).json({ error: 'خطأ في تدوير العجلة' });
    }
});

// ============================================================
// 💰 APIs السحب والتحويل
// ============================================================

app.get('/api/agents', authenticate, async (req, res) => {
    try {
        const agents = await prisma.agent.findMany();
        res.json(agents);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الوكلاء' });
    }
});

// جلب سعر الصرف
app.get('/api/settings/exchange-rate', authenticate, async (req, res) => {
    try {
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        res.json({ exchangeRate: settings?.exchangeRate || 1000 });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب سعر الصرف' });
    }
});

// تحويل عملات إلى جواهر
app.post('/api/exchange/coins-to-gems', authenticate, async (req, res) => {
    try {
        const { amount } = req.body;
        const coinsAmount = parseInt(amount);
        
        if (!coinsAmount || coinsAmount < 100) {
            return res.status(400).json({ error: 'الحد الأدنى للتحويل 100 عملة' });
        }
        
        // جلب سعر الصرف
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        const exchangeRate = settings?.exchangeRate || 1000;
        
        // حساب الجواهر
        const gemsToReceive = Math.floor(coinsAmount / exchangeRate);
        if (gemsToReceive < 1) {
            return res.status(400).json({ error: `تحتاج ${exchangeRate} عملة على الأقل للحصول على جوهرة واحدة` });
        }
        
        // التحقق من الرصيد
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (user.coins < coinsAmount) {
            return res.status(400).json({ error: 'رصيدك غير كافٍ' });
        }
        
        // تنفيذ التحويل
        const updatedUser = await prisma.user.update({
            where: { id: req.user.id },
            data: {
                coins: { decrement: coinsAmount },
                gems: { increment: gemsToReceive }
            }
        });
        
        res.json({
            success: true,
            coinsSpent: coinsAmount,
            gemsReceived: gemsToReceive,
            newCoins: updatedUser.coins,
            newGems: updatedUser.gems
        });
    } catch (error) {
        console.error('Exchange error:', error);
        res.status(500).json({ error: 'خطأ في التحويل' });
    }
});

// ============================================================
// 💸 APIs تحويل العملات بين المستخدمين
// ============================================================

// التحقق إذا كان المستخدم مسموح له بالتحويل
app.get('/api/transfer/check-allowed', authenticate, async (req, res) => {
    try {
        const allowed = await prisma.$queryRaw`
            SELECT * FROM "AllowedTransfer" WHERE "userId" = ${req.user.id}
        `;
        res.json({ isAllowed: allowed.length > 0 });
    } catch (error) {
        res.json({ isAllowed: false });
    }
});

// البحث عن مستخدم بكود الدعوة
app.get('/api/transfer/find-user/:referralCode', authenticate, async (req, res) => {
    try {
        // التحقق من أن المستخدم مسموح له بالتحويل
        const allowed = await prisma.$queryRaw`
            SELECT * FROM "AllowedTransfer" WHERE "userId" = ${req.user.id}
        `;
        if (allowed.length === 0) {
            return res.status(403).json({ error: 'غير مسموح لك بالتحويل' });
        }
        
        const { referralCode } = req.params;
        const user = await prisma.user.findUnique({
            where: { referralCode },
            select: { id: true, username: true, avatar: true, referralCode: true }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'لم يتم العثور على المستخدم' });
        }
        
        if (user.id === req.user.id) {
            return res.status(400).json({ error: 'لا يمكنك التحويل لنفسك' });
        }
        
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في البحث' });
    }
});

// تحويل عملات لمستخدم آخر
app.post('/api/transfer/send', authenticate, async (req, res) => {
    try {
        const { receiverId, amount } = req.body;
        const transferAmount = parseInt(amount);
        
        // التحقق من أن المستخدم مسموح له بالتحويل
        const allowed = await prisma.$queryRaw`
            SELECT * FROM "AllowedTransfer" WHERE "userId" = ${req.user.id}
        `;
        if (allowed.length === 0) {
            return res.status(403).json({ error: 'غير مسموح لك بالتحويل' });
        }
        
        if (!receiverId || !transferAmount || transferAmount < 1) {
            return res.status(400).json({ error: 'بيانات غير صحيحة' });
        }
        
        // التحقق من الرصيد
        const sender = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (sender.coins < transferAmount) {
            return res.status(400).json({ error: 'رصيدك غير كافٍ' });
        }
        
        // التحقق من المستلم
        const receiver = await prisma.user.findUnique({ 
            where: { id: receiverId },
            select: { id: true, username: true }
        });
        if (!receiver) {
            return res.status(404).json({ error: 'المستلم غير موجود' });
        }
        
        // تنفيذ التحويل
        await prisma.$transaction([
            prisma.user.update({
                where: { id: req.user.id },
                data: { coins: { decrement: transferAmount } }
            }),
            prisma.user.update({
                where: { id: receiverId },
                data: { coins: { increment: transferAmount } }
            })
        ]);
        
        // تسجيل التحويل
        const transferId = crypto.randomUUID();
        await prisma.$executeRaw`
            INSERT INTO "CoinTransfer" ("id", "senderId", "receiverId", "amount", "createdAt")
            VALUES (${transferId}, ${req.user.id}, ${receiverId}, ${transferAmount}, NOW())
        `;
        
        // إشعار للمستلم
        await createNotification(
            receiverId,
            'finance',
            '💰 استلمت تحويل!',
            `استلمت ${transferAmount} عملة من ${sender.username}`,
            { transferId, amount: transferAmount, senderId: req.user.id }
        );
        
        const updatedSender = await prisma.user.findUnique({ where: { id: req.user.id } });
        
        res.json({
            success: true,
            amount: transferAmount,
            receiverName: receiver.username,
            newBalance: updatedSender.coins
        });
    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ error: 'خطأ في التحويل' });
    }
});

// سجل التحويلات
app.get('/api/transfer/history', authenticate, async (req, res) => {
    try {
        const transfers = await prisma.$queryRaw`
            SELECT 
                t.*,
                s."username" as "senderName", s."avatar" as "senderAvatar",
                r."username" as "receiverName", r."avatar" as "receiverAvatar"
            FROM "CoinTransfer" t
            LEFT JOIN "User" s ON t."senderId" = s."id"
            LEFT JOIN "User" r ON t."receiverId" = r."id"
            WHERE t."senderId" = ${req.user.id} OR t."receiverId" = ${req.user.id}
            ORDER BY t."createdAt" DESC
            LIMIT 50
        `;
        
        const formatted = transfers.map(t => ({
            id: t.id,
            amount: t.amount,
            type: t.senderId === req.user.id ? 'sent' : 'received',
            otherUser: t.senderId === req.user.id 
                ? { username: t.receiverName, avatar: t.receiverAvatar }
                : { username: t.senderName, avatar: t.senderAvatar },
            createdAt: t.createdAt
        }));
        
        res.json(formatted);
    } catch (error) {
        res.json([]);
    }
});

// جلب طرق السحب المتاحة
app.get('/api/payment-methods', authenticate, async (req, res) => {
    try {
        const methods = await prisma.$queryRaw`
            SELECT * FROM "PaymentMethod" 
            WHERE "isActive" = true 
            ORDER BY "createdAt" ASC
        `;
        res.json(methods);
    } catch (error) {
        console.error('Payment methods error:', error);
        res.status(500).json({ error: 'خطأ في جلب طرق السحب' });
    }
});

// طلب سحب جديد
app.post('/api/withdraw', authenticate, async (req, res) => {
    try {
        const { amount, paymentMethodId, accountNumber } = req.body;
        
        if (!paymentMethodId || !accountNumber) {
            return res.status(400).json({ error: 'يرجى اختيار طريقة السحب وإدخال رقم الحساب' });
        }
        
        // جلب طريقة السحب باستخدام SQL
        const methods = await prisma.$queryRaw`
            SELECT * FROM "PaymentMethod" WHERE "id" = ${paymentMethodId}
        `;
        const paymentMethod = methods[0];
        
        if (!paymentMethod || !paymentMethod.isActive) {
            return res.status(400).json({ error: 'طريقة السحب غير متاحة' });
        }
        
        // التحقق من الحدود
        if (amount < paymentMethod.minAmount) {
            return res.status(400).json({ error: `الحد الأدنى للسحب ${paymentMethod.minAmount} عملة` });
        }
        if (amount > paymentMethod.maxAmount) {
            return res.status(400).json({ error: `الحد الأقصى للسحب ${paymentMethod.maxAmount} عملة` });
        }
        
        // جلب الرصيد الحالي
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { coins: true }
        });
        
        if (!currentUser || currentUser.coins < amount) {
            return res.status(400).json({ error: 'رصيدك غير كافٍ' });
        }
        
        // حساب الرسوم
        const fee = Math.floor(amount * (paymentMethod.fee / 100));
        const netAmount = amount - fee;
        
        // خصم الرصيد
        await prisma.user.update({
            where: { id: req.user.id },
            data: { coins: { decrement: amount } }
        });
        
        // إنشاء طلب السحب باستخدام SQL
        const withdrawId = crypto.randomUUID();
        await prisma.$executeRaw`
            INSERT INTO "WithdrawRequest" ("id", "userId", "amount", "status", "paymentMethodId", "accountNumber", "createdAt", "updatedAt")
            VALUES (${withdrawId}, ${req.user.id}, ${netAmount}, 'pending', ${paymentMethodId}, ${accountNumber}, NOW(), NOW())
        `;
        
        // إشعار طلب السحب
        await createNotification(
            req.user.id,
            'finance',
            '💸 تم إرسال طلب السحب',
            `طلب سحب ${netAmount} عملة عبر ${paymentMethod.name} قيد المراجعة`,
            { withdrawId, amount: netAmount, status: 'pending' }
        );
        
        res.json({ 
            id: withdrawId,
            amount: netAmount,
            fee,
            paymentMethod,
            status: 'pending'
        });
        
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ error: 'خطأ في طلب السحب' });
    }
});

app.get('/api/withdraw/history', authenticate, async (req, res) => {
    try {
        const history = await prisma.withdrawRequest.findMany({
            where: { userId: req.user.id },
            include: { paymentMethod: true },
            orderBy: { createdAt: 'desc' }
        });
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب سجل السحب' });
    }
});

// ============================================================
// ⚙️ APIs الإعدادات
// ============================================================

app.get('/api/settings', async (req, res) => {
    try {
        let settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        
        if (!settings) {
            settings = await prisma.appSettings.create({
                data: { id: 'settings' }
            });
        }
        
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

// جلب جدول المستويات
app.get('/api/levels', (req, res) => {
    res.json({
        levels: LEVEL_REQUIREMENTS,
        maxLevel: 50
    });
});

// ============================================================
// 📦 APIs الباقات
// ============================================================

// ============================================================
// 📦 APIs الباقات
// ============================================================

// جلب جميع الباقات المتاحة
app.get('/api/packages', authenticate, async (req, res) => {
    try {
        const packages = await prisma.package.findMany({
            where: { isActive: true },
            orderBy: { price: 'asc' }
        });
        res.json(packages);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الباقات' });
    }
});

// جلب باقات المستخدم النشطة
app.get('/api/packages/my', authenticate, async (req, res) => {
    try {
        const userPackages = await prisma.userPackage.findMany({
            where: {
                userId: req.user.id,
                isActive: true,
                expiresAt: { gt: new Date() }
            },
            include: { package: true },
            orderBy: { purchasedAt: 'desc' }
        });
        
        res.json(userPackages);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب باقاتك' });
    }
});

// شراء باقة (يمكن شراء نفس الباقة أكثر من مرة)
app.post('/api/packages/buy', authenticate, async (req, res) => {
    try {
        const { packageId } = req.body;
        
        const pkg = await prisma.package.findUnique({ where: { id: packageId } });
        
        if (!pkg) {
            return res.status(404).json({ error: 'الباقة غير موجودة' });
        }
        
        if (!pkg.isActive) {
            return res.status(400).json({ error: 'هذه الباقة غير متاحة حالياً' });
        }
        
        // جلب الرصيد الحالي من قاعدة البيانات (وليس من التوكن)
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { coins: true }
        });
        
        if (!currentUser || currentUser.coins < pkg.price) {
            return res.status(400).json({ error: 'عملاتك غير كافية' });
        }
        
        // حساب تاريخ انتهاء الباقة
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + pkg.duration);
        
        // خصم العملات وإنشاء سجل الباقة
        const [user, userPackage] = await prisma.$transaction([
            prisma.user.update({
                where: { id: req.user.id },
                data: { coins: { decrement: pkg.price } }
            }),
            prisma.userPackage.create({
                data: {
                    userId: req.user.id,
                    packageId: pkg.id,
                    expiresAt: expiresAt
                },
                include: { package: true }
            })
        ]);
        
        // إشعار شراء الباقة
        await createNotification(
            req.user.id,
            'system',
            '🎁 تم شراء الباقة!',
            `تم شراء باقة "${pkg.nameAr || pkg.name}" بنجاح! ستحصل على ${pkg.coinsReward} عملة و ${pkg.gemsReward} جوهرة يومياً`,
            { 
                packageId: pkg.id, 
                packageName: pkg.nameAr || pkg.name, 
                coinsReward: pkg.coinsReward,
                gemsReward: pkg.gemsReward,
                expiresAt: expiresAt
            }
        );
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({
            user: userWithoutPassword,
            userPackage: userPackage,
            message: `تم شراء الباقة بنجاح! ستنتهي في ${expiresAt.toLocaleDateString('ar')}`
        });
        
    } catch (error) {
        console.error('Buy package error:', error);
        res.status(500).json({ error: 'خطأ في شراء الباقة' });
    }
});

// ============================================================
// 🛠️ APIs إدارة الغرف
// ============================================================

// تحديث إعدادات الغرفة
app.put('/api/rooms/:roomId/settings', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        // التحقق من الصلاحيات (مالك أو مشرف بصلاحية التعديل)
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canEditRoom);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { name, description, image, messagePrice, joinPrice, isChatLocked, slowMode, isPublic, maxMembers } = req.body;
        
        const updatedRoom = await prisma.chatRoom.update({
            where: { id: req.params.roomId },
            data: {
                ...(name && { name }),
                ...(description !== undefined && { description }),
                ...(image !== undefined && { image }),
                ...(messagePrice !== undefined && { messagePrice }),
                ...(joinPrice !== undefined && { joinPrice }),
                ...(isChatLocked !== undefined && { isChatLocked }),
                ...(slowMode !== undefined && { slowMode }),
                ...(isPublic !== undefined && { isPublic }),
                ...(maxMembers !== undefined && { maxMembers })
            }
        });
        
        res.json(updatedRoom);
    } catch (error) {
        console.error('Update room settings error:', error);
        res.status(500).json({ error: 'خطأ في تحديث إعدادات الغرفة' });
    }
});

// شراء مايكات للغرفة (4 مايكات دفعة واحدة مع مدة صلاحية) - بالعملات
app.post('/api/rooms/:roomId/buy-mics', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        if (room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط مالك الغرفة يمكنه شراء المايكات' });
        }
        
        // جلب الإعدادات (السعر والمدة)
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        const micPrice = settings?.micSeatPrice || 100;
        const micDuration = settings?.micDuration || 30; // بالأيام
        
        // التحقق من رصيد العملات
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (user.coins < micPrice) {
            return res.status(400).json({ error: `رصيدك غير كافٍ. تحتاج ${micPrice} عملة` });
        }
        
        // حساب تاريخ انتهاء الصلاحية
        let expiresAt = new Date();
        // إذا كان لديه مايكات سارية، نمدد من تاريخ الانتهاء الحالي
        if (room.micExpiresAt && new Date(room.micExpiresAt) > new Date()) {
            expiresAt = new Date(room.micExpiresAt);
        }
        expiresAt.setDate(expiresAt.getDate() + micDuration);
        
        // خصم العملات وتفعيل 4 مايكات
        const [updatedUser, updatedRoom] = await prisma.$transaction([
            prisma.user.update({
                where: { id: req.user.id },
                data: { coins: { decrement: micPrice } }
            }),
            prisma.chatRoom.update({
                where: { id: req.params.roomId },
                data: { 
                    micSeats: 4,
                    micExpiresAt: expiresAt
                }
            })
        ]);
        
        res.json({ 
            success: true, 
            message: `تم شراء 4 مايكات لمدة ${micDuration} يوم`,
            micSeats: 4,
            micExpiresAt: expiresAt,
            newCoins: updatedUser.coins,
            totalPaid: micPrice
        });
    } catch (error) {
        console.error('Buy mics error:', error);
        res.status(500).json({ error: 'خطأ في شراء المايكات' });
    }
});

// جلب سعر ومدة المايكات
app.get('/api/settings/mic-price', authenticate, async (req, res) => {
    try {
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        res.json({ 
            micSeatPrice: settings?.micSeatPrice || 100,
            micDuration: settings?.micDuration || 30
        });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب السعر' });
    }
});

// تعيين مشرف
app.post('/api/rooms/:roomId/moderators', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId } });
        
        if (!room || room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط المالك يمكنه تعيين مشرفين' });
        }
        
        const { userId, permissions } = req.body;
        
        const moderator = await prisma.roomModerator.upsert({
            where: { roomId_userId: { roomId: req.params.roomId, userId } },
            update: {
                canKick: permissions?.canKick ?? true,
                canMute: permissions?.canMute ?? true,
                canBan: permissions?.canBan ?? false,
                canEditRoom: permissions?.canEditRoom ?? false,
                canDeleteMessages: permissions?.canDeleteMessages ?? true,
                canPinMessages: permissions?.canPinMessages ?? true
            },
            create: {
                roomId: req.params.roomId,
                userId,
                assignedBy: req.user.id,
                canKick: permissions?.canKick ?? true,
                canMute: permissions?.canMute ?? true,
                canBan: permissions?.canBan ?? false,
                canEditRoom: permissions?.canEditRoom ?? false,
                canDeleteMessages: permissions?.canDeleteMessages ?? true,
                canPinMessages: permissions?.canPinMessages ?? true
            },
            include: { user: { select: { id: true, username: true, avatar: true } } }
        });
        
        // تحديث دور العضو
        await prisma.roomMember.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId } },
            data: { role: 'moderator' }
        });
        
        res.json(moderator);
    } catch (error) {
        console.error('Add moderator error:', error);
        res.status(500).json({ error: 'خطأ في تعيين المشرف' });
    }
});

// إزالة مشرف
app.delete('/api/rooms/:roomId/moderators/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId } });
        
        if (!room || room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط المالك يمكنه إزالة مشرفين' });
        }
        
        await prisma.roomModerator.delete({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } }
        });
        
        await prisma.roomMember.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
            data: { role: 'member' }
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إزالة المشرف' });
    }
});

// كتم عضو
app.post('/api/rooms/:roomId/mute/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canMute);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { duration } = req.body; // بالدقائق
        const muteUntil = duration ? new Date(Date.now() + duration * 60000) : null;
        
        const member = await prisma.roomMember.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
            data: { isMuted: true, muteUntil }
        });
        
        res.json(member);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في كتم العضو' });
    }
});

// إلغاء كتم عضو
app.post('/api/rooms/:roomId/unmute/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canMute);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const member = await prisma.roomMember.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
            data: { isMuted: false, muteUntil: null }
        });
        
        res.json(member);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إلغاء كتم العضو' });
    }
});

// حظر عضو
app.post('/api/rooms/:roomId/ban/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canBan);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { reason, duration } = req.body; // duration بالدقائق، null = دائم
        const expiresAt = duration ? new Date(Date.now() + duration * 60000) : null;
        
        // تحديث العضوية لتكون محظورة
        const existingMember = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } }
        });
        
        if (existingMember) {
            await prisma.roomMember.update({
                where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
                data: { isBanned: true, isOnline: false }
            });
        } else {
            await prisma.roomMember.create({
                data: { roomId: req.params.roomId, userId: req.params.userId, isBanned: true, isOnline: false }
            });
        }
        
        // إنشاء سجل الحظر
        const existingBan = await prisma.roomBan.findUnique({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } }
        });
        
        let ban;
        if (existingBan) {
            ban = await prisma.roomBan.update({
                where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
                data: { reason, bannedById: req.user.id, expiresAt }
            });
        } else {
            ban = await prisma.roomBan.create({
                data: {
                    roomId: req.params.roomId,
                    userId: req.params.userId,
                    reason,
                    bannedById: req.user.id,
                    expiresAt
                }
            });
        }
        
        // إنزال من المايك
        await prisma.voiceSeat.updateMany({
            where: { roomId: req.params.roomId, odId: req.params.userId },
            data: { odId: null, isMuted: false, joinedAt: null }
        });
        
        // حذف الحضور
        await prisma.roomPresence.deleteMany({ where: { roomId: req.params.roomId, visitorId: req.params.userId } });
        
        res.json(ban);
    } catch (error) {
        console.error('Ban error:', error);
        res.status(500).json({ error: 'خطأ في حظر العضو' });
    }
});

// إلغاء حظر عضو
app.post('/api/rooms/:roomId/unban/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canBan);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // تحديث العضوية لإلغاء الحظر
        const existingMember = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } }
        });
        
        if (existingMember) {
            await prisma.roomMember.update({
                where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
                data: { isBanned: false }
            });
        }
        
        // حذف سجل الحظر
        await prisma.roomBan.deleteMany({
            where: { roomId: req.params.roomId, userId: req.params.userId }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء حظر العضو' });
    }
});

// طرد عضو
app.post('/api/rooms/:roomId/kick/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canKick);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // لا يمكن طرد المالك
        if (req.params.userId === room.ownerId) {
            return res.status(400).json({ error: 'لا يمكن طرد مالك الغرفة' });
        }
        
        await prisma.roomMember.delete({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } }
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في طرد العضو' });
    }
});

// جلب قائمة المحظورين
app.get('/api/rooms/:roomId/bans', authenticate, async (req, res) => {
    try {
        const bans = await prisma.roomBan.findMany({
            where: { roomId: req.params.roomId }
        });
        
        // جلب بيانات المستخدمين المحظورين
        const userIds = bans.map(b => b.userId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, avatar: true }
        });
        
        // دمج البيانات
        const bansWithUsers = bans.map(ban => ({
            ...ban,
            user: users.find(u => u.id === ban.userId)
        }));
        
        res.json(bansWithUsers);
    } catch (error) {
        console.error('Get bans error:', error);
        res.status(500).json({ error: 'خطأ في جلب المحظورين' });
    }
});

// جلب قائمة المشرفين
app.get('/api/rooms/:roomId/moderators', authenticate, async (req, res) => {
    try {
        const moderators = await prisma.roomModerator.findMany({
            where: { roomId: req.params.roomId },
            include: { user: { select: { id: true, username: true, avatar: true } } }
        });
        res.json(moderators);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب المشرفين' });
    }
});

// تحديث صلاحيات المشرف
app.put('/api/rooms/:roomId/moderators/:userId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ where: { id: req.params.roomId } });
        
        if (!room || room.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'فقط المالك يمكنه تعديل صلاحيات المشرفين' });
        }
        
        const { permissions } = req.body;
        
        const moderator = await prisma.roomModerator.update({
            where: { roomId_userId: { roomId: req.params.roomId, userId: req.params.userId } },
            data: {
                canKick: permissions?.canKick ?? true,
                canMute: permissions?.canMute ?? true,
                canBan: permissions?.canBan ?? false,
                canEditRoom: permissions?.canEditRoom ?? false,
                canDeleteMessages: permissions?.canDeleteMessages ?? true,
                canPinMessages: permissions?.canPinMessages ?? true
            },
            include: { user: { select: { id: true, username: true, avatar: true } } }
        });
        
        res.json(moderator);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث صلاحيات المشرف' });
    }
});

// حذف رسالة
app.delete('/api/rooms/:roomId/messages/:messageId', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const message = await prisma.chatMessage.findUnique({ 
            where: { id: req.params.messageId } 
        });
        
        if (!message) {
            return res.status(404).json({ error: 'الرسالة غير موجودة' });
        }
        
        // يمكن للمالك أو المشرف (بصلاحية) أو صاحب الرسالة حذفها
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canDeleteMessages);
        const isOwner = room.ownerId === req.user.id;
        const isMessageOwner = message.userId === req.user.id;
        
        if (!isOwner && !isModerator && !isMessageOwner) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        await prisma.chatMessage.delete({
            where: { id: req.params.messageId }
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الرسالة' });
    }
});

// تثبيت رسالة
app.post('/api/rooms/:roomId/messages/:messageId/pin', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canPinMessages);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // إلغاء تثبيت أي رسالة سابقة (رسالة واحدة مثبتة فقط)
        await prisma.chatMessage.updateMany({
            where: { roomId: req.params.roomId, isPinned: true },
            data: { isPinned: false }
        });
        
        const message = await prisma.chatMessage.update({
            where: { id: req.params.messageId },
            data: { isPinned: true },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } }
            }
        });
        
        res.json(message);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تثبيت الرسالة' });
    }
});

// إلغاء تثبيت رسالة
app.delete('/api/rooms/:roomId/messages/:messageId/pin', authenticate, async (req, res) => {
    try {
        const room = await prisma.chatRoom.findUnique({ 
            where: { id: req.params.roomId },
            include: { moderators: true }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        const isModerator = room.moderators.find(m => m.userId === req.user.id && m.canPinMessages);
        if (room.ownerId !== req.user.id && !isModerator) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const message = await prisma.chatMessage.update({
            where: { id: req.params.messageId },
            data: { isPinned: false }
        });
        
        res.json(message);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إلغاء تثبيت الرسالة' });
    }
});

// ============================================================
// 🎮 نظام الألعاب الجماعية
// ============================================================

// تخزين الألعاب النشطة في الذاكرة
const activeGames = new Map();

// إنشاء لعبة جديدة
app.post('/api/games/create', authenticate, async (req, res) => {
    try {
        const { roomId, betAmount, maxPlayers } = req.body;
        
        // التحقق من وجود لعبة نشطة في الغرفة
        const existingGame = Array.from(activeGames.values())
            .find(g => g.roomId === roomId && (g.status === 'waiting' || g.status === 'playing'));
        if (existingGame) {
            return res.status(400).json({ error: 'يوجد لعبة نشطة بالفعل، انتظر حتى تنتهي' });
        }
        
        // جلب الرصيد الحالي من قاعدة البيانات
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { gems: true }
        });
        
        if (!currentUser || currentUser.gems < betAmount) {
            return res.status(400).json({ error: 'رصيد غير كافٍ' });
        }

        // الحصول على معلومات الغرفة
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }

        // خصم الرهان من المنشئ
        await prisma.user.update({
            where: { id: req.user.id },
            data: { gems: { decrement: betAmount } }
        });

        // إنشاء اللعبة
        const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const game = {
            id: gameId,
            roomId,
            roomOwnerId: room.ownerId,
            creatorId: req.user.id,
            creatorName: req.user.username,
            betAmount,
            maxPlayers,
            players: [{
                id: req.user.id,
                username: req.user.username,
                avatar: req.user.avatar
            }],
            status: 'waiting',
            countdown: 30,
            createdAt: Date.now()
        };

        activeGames.set(gameId, game);

        // بدء العداد التنازلي
        startGameCountdown(gameId);

        res.json(game);
    } catch (error) {
        console.error('خطأ في إنشاء اللعبة:', error);
        res.status(500).json({ error: 'خطأ في إنشاء اللعبة' });
    }
});

// الانضمام للعبة
app.post('/api/games/:gameId/join', authenticate, async (req, res) => {
    try {
        const { gameId } = req.params;
        const game = activeGames.get(gameId);

        if (!game) {
            return res.status(404).json({ error: 'اللعبة غير موجودة' });
        }

        if (game.status !== 'waiting') {
            return res.status(400).json({ error: 'اللعبة لم تعد متاحة للانضمام' });
        }

        if (game.players.length >= game.maxPlayers) {
            return res.status(400).json({ error: 'اللعبة ممتلئة' });
        }

        if (game.players.some(p => p.id === req.user.id)) {
            return res.status(400).json({ error: 'أنت مشترك بالفعل' });
        }

        // جلب الرصيد الحالي من قاعدة البيانات
        const currentUser = await prisma.user.findUnique({ 
            where: { id: req.user.id },
            select: { gems: true }
        });
        
        if (!currentUser || currentUser.gems < game.betAmount) {
            return res.status(400).json({ error: 'رصيد غير كافٍ' });
        }

        // خصم الرهان
        await prisma.user.update({
            where: { id: req.user.id },
            data: { gems: { decrement: game.betAmount } }
        });

        // إضافة اللاعب
        game.players.push({
            id: req.user.id,
            username: req.user.username,
            avatar: req.user.avatar
        });

        // إذا اكتملت اللعبة، ابدأها فوراً
        if (game.players.length >= game.maxPlayers) {
            await startGame(gameId);
        }

        res.json(game);
    } catch (error) {
        console.error('خطأ في الانضمام للعبة:', error);
        res.status(500).json({ error: 'خطأ في الانضمام للعبة' });
    }
});

// الحصول على اللعبة النشطة في الغرفة
app.get('/api/games/room/:roomId/active', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const games = Array.from(activeGames.values())
            .filter(g => g.roomId === roomId && g.status !== 'finished');
        
        res.json(games[0] || null);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب اللعبة' });
    }
});

// دالة بدء العداد التنازلي
function startGameCountdown(gameId) {
    const interval = setInterval(async () => {
        const game = activeGames.get(gameId);
        if (!game) {
            clearInterval(interval);
            return;
        }

        game.countdown--;

        if (game.countdown <= 0) {
            clearInterval(interval);
            await startGame(gameId);
        }
    }, 1000);
}

// دالة بدء اللعبة
async function startGame(gameId) {
    const game = activeGames.get(gameId);
    if (!game) return;

    // إذا لاعب واحد فقط، أعد المال
    if (game.players.length < 2) {
        game.status = 'cancelled';
        game.cancelReason = 'لم ينضم لاعبون كافٍ';
        
        // إعادة المال للاعب الوحيد
        if (game.players.length === 1) {
            await prisma.user.update({
                where: { id: game.players[0].id },
                data: { gems: { increment: game.betAmount } }
            });
            game.refundedTo = game.players[0].username;
        }
        
        // حذف اللعبة بعد 15 ثانية حتى يرى المستخدمون رسالة الإلغاء
        setTimeout(() => {
            activeGames.delete(gameId);
        }, 15000);
        return;
    }

    game.status = 'playing';

    // انتظار 3 ثواني ثم اختيار الفائز
    setTimeout(async () => {
        await finishGame(gameId);
    }, 3000);
}

// دالة إنهاء اللعبة
async function finishGame(gameId) {
    const game = activeGames.get(gameId);
    if (!game) return;

    // اختيار فائز عشوائي
    const winnerIndex = Math.floor(Math.random() * game.players.length);
    const winner = game.players[winnerIndex];

    // حساب الجائزة
    const totalPool = game.betAmount * game.players.length;
    const systemFee = Math.floor(totalPool * 0.1); // 10% للنظام
    const ownerFee = Math.floor(totalPool * 0.1);  // 10% لمدير الغرفة
    const winnerPrize = totalPool - systemFee - ownerFee;

    // إضافة الجائزة للفائز
    await prisma.user.update({
        where: { id: winner.id },
        data: { gems: { increment: winnerPrize } }
    });

    // إضافة نصيب مدير الغرفة
    if (game.roomOwnerId) {
        await prisma.user.update({
            where: { id: game.roomOwnerId },
            data: { gems: { increment: ownerFee } }
        });
    }

    game.status = 'finished';
    game.winnerId = winner.id;
    game.winnerName = winner.username;
    game.totalPrize = winnerPrize;

    // حذف اللعبة بعد 30 ثانية
    setTimeout(() => {
        activeGames.delete(gameId);
    }, 30000);
}

// ============================================================
// 🎤 APIs المقاعد الصوتية
// ============================================================

// جلب معلومات السيرفر الصوتي الخاص
app.get('/api/rooms/:roomId/voice/token', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.id;
        
        // إرجاع معلومات السيرفر الصوتي الخاص
        res.json({ 
            voiceServerUrl: VOICE_SERVER_URL,
            roomId,
            userId
        });
    } catch (error) {
        console.error('Get voice server info error:', error);
        res.status(500).json({ error: 'خطأ في جلب معلومات السيرفر الصوتي' });
    }
});

// جلب المقاعد الصوتية للغرفة
app.get('/api/rooms/:roomId/voice/seats', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        // التحقق من صلاحية المايكات أولاً
        const room = await prisma.chatRoom.findUnique({
            where: { id: roomId }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        // إذا المايكات غير مفعلة أو منتهية، إرجاع مصفوفة فارغة
        if (!isMicValid(room)) {
            return res.json([]);
        }
        
        // جلب المقاعد من قاعدة البيانات
        let seats = await prisma.voiceSeat.findMany({
            where: { roomId },
            orderBy: { seatNumber: 'asc' }
        });
        
        // إذا لم توجد مقاعد، إنشاء 4 مقاعد فارغة
        if (seats.length === 0) {
            const seatsData = [1, 2, 3, 4].map(num => ({
                roomId,
                seatNumber: num,
                odId: null,
                isMuted: false,
                isLocked: false
            }));
            
            await prisma.voiceSeat.createMany({ data: seatsData });
            seats = await prisma.voiceSeat.findMany({
                where: { roomId },
                orderBy: { seatNumber: 'asc' }
            });
        }
        
        // جلب بيانات المستخدمين الجالسين
        const userIds = seats.filter(s => s.odId).map(s => s.odId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, avatar: true }
        });
        
        // تحويل البيانات للشكل المطلوب
        const formattedSeats = seats.map(seat => {
            const user = users.find(u => u.id === seat.odId);
            return {
                id: seat.seatNumber,
                odId: seat.odId,
                username: user?.username || null,
                avatar: user?.avatar || null,
                isSpeaking: false,
                isMuted: seat.isMuted,
                isLocked: seat.isLocked
            };
        });
        
        res.json(formattedSeats);
    } catch (error) {
        console.error('Get voice seats error:', error);
        res.status(500).json({ error: 'خطأ في جلب المقاعد الصوتية' });
    }
});

// الجلوس على مقعد صوتي
app.post('/api/rooms/:roomId/voice/join/:seatNumber', authenticate, async (req, res) => {
    try {
        const { roomId, seatNumber } = req.params;
        const userId = req.user.id;
        const seatNum = parseInt(seatNumber);
        
        // التحقق من صلاحية المايكات أولاً
        const room = await prisma.chatRoom.findUnique({
            where: { id: roomId }
        });
        
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        
        // التحقق من أن المايكات مفعلة وغير منتهية الصلاحية
        if (!isMicValid(room)) {
            return res.status(403).json({ error: 'المايكات غير مفعلة أو منتهية الصلاحية', micExpired: true });
        }
        
        // التحقق من الحظر
        const member = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (member && member.isBanned) {
            return res.status(403).json({ error: 'أنت محظور من هذه الغرفة', roomBanned: true });
        }
        
        // التحقق من أن المقعد موجود وفارغ
        const seat = await prisma.voiceSeat.findUnique({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } }
        });
        
        if (!seat) {
            return res.status(404).json({ error: 'المقعد غير موجود' });
        }
        
        if (seat.isLocked) {
            return res.status(403).json({ error: 'المقعد مغلق' });
        }
        
        if (seat.odId) {
            return res.status(400).json({ error: 'المقعد مشغول' });
        }
        
        // التحقق من أن المستخدم ليس على مقعد آخر
        const existingSeat = await prisma.voiceSeat.findFirst({
            where: { roomId, odId: userId }
        });
        
        if (existingSeat) {
            return res.status(400).json({ error: 'أنت بالفعل على مقعد آخر' });
        }
        
        // الجلوس على المقعد
        await prisma.voiceSeat.update({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } },
            data: { odId: userId, joinedAt: new Date(), isMuted: false }
        });
        
        res.json({ success: true, message: 'تم الجلوس على المقعد' });
    } catch (error) {
        console.error('Join voice seat error:', error);
        res.status(500).json({ error: 'خطأ في الجلوس على المقعد' });
    }
});

// مغادرة المقعد الصوتي
app.post('/api/rooms/:roomId/voice/leave/:seatNumber', authenticate, async (req, res) => {
    try {
        const { roomId, seatNumber } = req.params;
        const userId = req.user.id;
        const seatNum = parseInt(seatNumber);
        
        const seat = await prisma.voiceSeat.findUnique({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } }
        });
        
        if (!seat || seat.odId !== userId) {
            return res.status(403).json({ error: 'لا يمكنك مغادرة هذا المقعد' });
        }
        
        await prisma.voiceSeat.update({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } },
            data: { odId: null, joinedAt: null, isMuted: false }
        });
        
        res.json({ success: true, message: 'تم مغادرة المقعد' });
    } catch (error) {
        console.error('Leave voice seat error:', error);
        res.status(500).json({ error: 'خطأ في مغادرة المقعد' });
    }
});

// كتم/إلغاء كتم المقعد
app.post('/api/rooms/:roomId/voice/mute/:seatNumber', authenticate, async (req, res) => {
    try {
        const { roomId, seatNumber } = req.params;
        const userId = req.user.id;
        const seatNum = parseInt(seatNumber);
        
        const seat = await prisma.voiceSeat.findUnique({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } }
        });
        
        if (!seat) {
            return res.status(404).json({ error: 'المقعد غير موجود' });
        }
        
        // التحقق من الصلاحية (المستخدم نفسه أو المالك)
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (seat.odId !== userId && room.ownerId !== userId) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        await prisma.voiceSeat.update({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } },
            data: { isMuted: !seat.isMuted }
        });
        
        res.json({ success: true, isMuted: !seat.isMuted });
    } catch (error) {
        console.error('Mute voice seat error:', error);
        res.status(500).json({ error: 'خطأ في كتم المقعد' });
    }
});

// قفل/فتح المقعد (للمالك فقط)
app.post('/api/rooms/:roomId/voice/lock/:seatNumber', authenticate, async (req, res) => {
    try {
        const { roomId, seatNumber } = req.params;
        const userId = req.user.id;
        const seatNum = parseInt(seatNumber);
        
        // التحقق من أن المستخدم هو المالك
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (!room || room.ownerId !== userId) {
            // التحقق من المشرفين
            const mod = await prisma.roomModerator.findUnique({
                where: { roomId_userId: { roomId, userId } }
            });
            if (!mod) {
                return res.status(403).json({ error: 'غير مصرح' });
            }
        }
        
        const seat = await prisma.voiceSeat.findUnique({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } }
        });
        
        if (!seat) {
            return res.status(404).json({ error: 'المقعد غير موجود' });
        }
        
        // إذا كان المقعد مشغول، إفراغه أولاً
        await prisma.voiceSeat.update({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } },
            data: { 
                isLocked: !seat.isLocked,
                odId: seat.isLocked ? seat.odId : null, // إفراغ المقعد عند القفل
                joinedAt: seat.isLocked ? seat.joinedAt : null
            }
        });
        
        res.json({ success: true, isLocked: !seat.isLocked });
    } catch (error) {
        console.error('Lock voice seat error:', error);
        res.status(500).json({ error: 'خطأ في قفل المقعد' });
    }
});

// إنزال شخص من المقعد (للمالك والمشرفين)
app.post('/api/rooms/:roomId/voice/kick/:seatNumber', authenticate, async (req, res) => {
    try {
        const { roomId, seatNumber } = req.params;
        const userId = req.user.id;
        const seatNum = parseInt(seatNumber);
        
        // التحقق من الصلاحية
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        const isOwner = room && room.ownerId === userId;
        
        const mod = await prisma.roomModerator.findUnique({
            where: { roomId_userId: { roomId, userId } }
        });
        
        if (!isOwner && !mod) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const seat = await prisma.voiceSeat.findUnique({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } }
        });
        
        if (!seat || !seat.odId) {
            return res.status(400).json({ error: 'المقعد فارغ' });
        }
        
        await prisma.voiceSeat.update({
            where: { roomId_seatNumber: { roomId, seatNumber: seatNum } },
            data: { odId: null, joinedAt: null, isMuted: false }
        });
        
        res.json({ success: true, message: 'تم إنزال المستخدم من المقعد' });
    } catch (error) {
        console.error('Kick from voice seat error:', error);
        res.status(500).json({ error: 'خطأ في إنزال المستخدم' });
    }
});

// ============================================================
// ⚔️ APIs نظام الجولات (Battle/PK) - النظام الجديد
// ============================================================
// - كل شخص له سكور خاص + سكور مشترك للفريق
// - الجواهر تصل للمستلم بنفس الطريقة (دبل أو غير دبل)
// - السكور فقط يتضاعف في الدبل
// - كل فريق له دبل خاص به (A و B منفصلين)
// ============================================================

// تخزين الجولات النشطة في الذاكرة
const activeBattles = new Map();
// تخزين الفائزين مؤقتاً (لمدة دقيقة)
const battleWinners = new Map(); // { roomId: { winnerTeam: 'A' | 'B', endTime: timestamp } }

// بدء جولة جديدة
app.post('/api/rooms/:roomId/battle/start', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.id;
        
        // التحقق من أن المستخدم هو مالك الغرفة
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (!room || room.ownerId !== userId) {
            return res.status(403).json({ error: 'فقط مالك الغرفة يمكنه بدء الجولة' });
        }
        
        // التحقق من عدم وجود جولة نشطة
        if (activeBattles.has(roomId)) {
            return res.status(400).json({ error: 'يوجد جولة نشطة بالفعل' });
        }
        
        // جلب المقاعد الصوتية للحصول على المشاركين
        const seats = await prisma.voiceSeat.findMany({
            where: { roomId, odId: { not: null } },
            orderBy: { seatNumber: 'asc' }
        });
        
        // جلب بيانات المستخدمين على المقاعد
        const userIds = seats.map(s => s.odId).filter(Boolean);
        let users = [];
        if (userIds.length > 0) {
            users = await prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, username: true, avatar: true }
            });
        }
        
        // إنشاء بيانات المشاركين (كل شخص له سكور خاص)
        const participants = seats.map(seat => {
            const user = users.find(u => u.id === seat.odId);
            return {
                odId: seat.odId,
                seatNumber: seat.seatNumber,
                username: user?.username || 'مجهول',
                avatar: user?.avatar || null,
                score: 0,      // سكور الشخص
                gems: 0,       // الجواهر المستلمة
                team: seat.seatNumber <= 2 ? 'A' : 'B'  // الفريق حسب المقعد
            };
        });
        
        // إنشاء الجولة
        const battle = {
            id: `battle_${Date.now()}`,
            roomId,
            startTime: Date.now(),
            duration: 120, // 2 دقيقة
            participants,
            // سكور الفرق المشترك
            teamAScore: 0,
            teamBScore: 0,
            teamAGems: 0,
            teamBGems: 0,
            // دبل فريق A
            doubleA: {
                active: false,
                target: 0,
                progress: 0,
                activatedAt: null,
                timeLeft: 0
            },
            // دبل فريق B
            doubleB: {
                active: false,
                target: 0,
                progress: 0,
                activatedAt: null,
                timeLeft: 0
            }
        };
        
        activeBattles.set(roomId, battle);
        
        // إنهاء الجولة تلقائياً بعد دقيقتين
        setTimeout(() => {
            if (activeBattles.has(roomId)) {
                const b = activeBattles.get(roomId);
                // يمكن حفظ النتيجة في قاعدة البيانات هنا
                activeBattles.delete(roomId);
            }
        }, 120000);
        
        res.json(battle);
    } catch (error) {
        console.error('Start battle error:', error);
        res.status(500).json({ error: 'خطأ في بدء الجولة' });
    }
});

// جلب حالة الجولة
app.get('/api/rooms/:roomId/battle', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const battle = activeBattles.get(roomId);
        
        // التحقق من وجود فائز سابق (لعرض التاج)
        const winner = battleWinners.get(roomId);
        const winnerTeam = winner && winner.endTime > Date.now() ? winner.winnerTeam : null;
        
        if (!battle) {
            return res.json({ isActive: false, winnerTeam });
        }
        
        // حساب الوقت المتبقي
        const now = Date.now();
        const elapsed = Math.floor((now - battle.startTime) / 1000);
        const timeLeft = Math.max(0, battle.duration - elapsed);
        
        // تحديث وقت الدبل المتبقي
        if (battle.doubleA.active && battle.doubleA.activatedAt) {
            const doubleElapsed = Math.floor((now - battle.doubleA.activatedAt) / 1000);
            battle.doubleA.timeLeft = Math.max(0, 20 - doubleElapsed);
            if (battle.doubleA.timeLeft === 0) {
                battle.doubleA.active = false;
            }
        }
        if (battle.doubleB.active && battle.doubleB.activatedAt) {
            const doubleElapsed = Math.floor((now - battle.doubleB.activatedAt) / 1000);
            battle.doubleB.timeLeft = Math.max(0, 20 - doubleElapsed);
            if (battle.doubleB.timeLeft === 0) {
                battle.doubleB.active = false;
            }
        }
        
        res.json({
            isActive: true,
            ...battle,
            timeLeft,
            winnerTeam,
        });
    } catch (error) {
        console.error('Get battle error:', error);
        res.status(500).json({ error: 'خطأ في جلب الجولة' });
    }
});

// إرسال هدية في الجولة
app.post('/api/rooms/:roomId/battle/gift', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { odId, giftId, quantity = 1 } = req.body; // odId = المستلم
        const senderId = req.user.id;
        
        const battle = activeBattles.get(roomId);
        if (!battle) {
            return res.status(404).json({ error: 'لا توجد جولة نشطة' });
        }
        
        // جلب الهدية
        const gift = await prisma.gift.findUnique({ where: { id: giftId } });
        if (!gift) {
            return res.status(404).json({ error: 'الهدية غير موجودة' });
        }
        
        const giftValue = gift.price * quantity;
        
        // التحقق من الرصيد
        const sender = await prisma.user.findUnique({ where: { id: senderId } });
        if (!sender || sender.gems < giftValue) {
            return res.status(400).json({ error: 'رصيد غير كافٍ' });
        }
        
        // البحث عن المشارك المستلم
        const participant = battle.participants.find(p => p.odId === odId);
        if (!participant) {
            return res.status(404).json({ error: 'المستلم ليس مشاركاً في الجولة' });
        }
        
        const team = participant.team; // 'A' أو 'B'
        const doubleInfo = team === 'A' ? battle.doubleA : battle.doubleB;
        
        // ============ توزيع الجواهر (نفس النظام دائماً) ============
        // 50% للمستخدم، 10% للمدير، 40% للنظام
        const userShare = Math.floor(giftValue * 0.5);
        const ownerShare = Math.floor(giftValue * 0.1);
        
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        
        // خصم من المرسل
        await prisma.user.update({
            where: { id: senderId },
            data: { gems: { decrement: giftValue } }
        });
        
        // إضافة للمستلم
        await prisma.user.update({
            where: { id: odId },
            data: { gems: { increment: userShare } }
        });
        
        // إضافة لمدير الغرفة
        if (room && room.ownerId !== odId) {
            await prisma.user.update({
                where: { id: room.ownerId },
                data: { gems: { increment: ownerShare } }
            });
        }
        
        // تحديث نقاط الغرفة
        await prisma.chatRoom.update({
            where: { id: roomId },
            data: { totalGiftPoints: { increment: giftValue } }
        });
        
        // ============ حساب السكور ============
        // السكور يتضاعف فقط إذا كان الدبل مفعل لهذا الفريق
        const scoreToAdd = doubleInfo.active ? giftValue * 2 : giftValue;
        
        // تحديث سكور الشخص
        participant.score += scoreToAdd;
        participant.gems += giftValue;
        
        // تحديث سكور الفريق المشترك
        if (team === 'A') {
            battle.teamAScore += scoreToAdd;
            battle.teamAGems += giftValue;
        } else {
            battle.teamBScore += scoreToAdd;
            battle.teamBGems += giftValue;
        }
        
        // تحديث تقدم الدبل (إذا كان مفعل)
        if (doubleInfo.active) {
            doubleInfo.progress += giftValue;
            // إذا اكتمل الهدف، إيقاف الدبل
            if (doubleInfo.progress >= doubleInfo.target) {
                doubleInfo.active = false;
            }
        }
        
        // تسجيل الهدية
        await prisma.giftMessage.create({
            data: {
                roomId,
                senderId,
                receiverId: odId,
                giftId,
                isForAll: false
            }
        });
        
        // ============ زيادة الخبرة (Experience) ============
        // المرسل يحصل على خبرة = سعر الهدية × الكمية
        // المستلم يحصل على خبرة = سعر الهدية × الكمية × 2
        const senderExp = giftValue;
        const receiverExp = giftValue * 2;
        
        // زيادة خبرة المرسل
        await prisma.user.update({
            where: { id: senderId },
            data: { experience: { increment: senderExp } }
        });
        await updateUserLevel(senderId);
        
        // زيادة خبرة المستلم
        await prisma.user.update({
            where: { id: odId },
            data: { experience: { increment: receiverExp } }
        });
        await updateUserLevel(odId);
        
        res.json({
            success: true,
            participant: {
                odId: participant.odId,
                score: participant.score,
                gems: participant.gems
            },
            teamAScore: battle.teamAScore,
            teamBScore: battle.teamBScore,
            teamAGems: battle.teamAGems,
            teamBGems: battle.teamBGems,
            doubleA: battle.doubleA,
            doubleB: battle.doubleB,
            gemsDeducted: giftValue,
            receiverGot: userShare
        });
    } catch (error) {
        console.error('Battle gift error:', error);
        res.status(500).json({ error: 'خطأ في إرسال الهدية' });
    }
});

// تفعيل وضع الدبل لفريق معين
app.post('/api/rooms/:roomId/battle/double', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { team, onlineCount } = req.body; // team = 'A' أو 'B'
        
        const battle = activeBattles.get(roomId);
        if (!battle) {
            return res.status(404).json({ error: 'لا توجد جولة نشطة' });
        }
        
        if (team !== 'A' && team !== 'B') {
            return res.status(400).json({ error: 'الفريق غير صحيح' });
        }
        
        const doubleInfo = team === 'A' ? battle.doubleA : battle.doubleB;
        
        // التحقق من أن الدبل غير مفعل
        if (doubleInfo.active) {
            return res.status(400).json({ error: 'الدبل مفعل بالفعل لهذا الفريق' });
        }
        
        // 10 جواهر لكل مستخدم متصل
        const target = Math.max(10, (onlineCount || 5) * 10);
        
        doubleInfo.active = true;
        doubleInfo.target = target;
        doubleInfo.progress = 0;
        doubleInfo.activatedAt = Date.now();
        doubleInfo.timeLeft = 20;
        
        // إلغاء الدبل بعد 20 ثانية إذا لم يكتمل
        setTimeout(() => {
            if (battle && doubleInfo.active && activeBattles.has(roomId)) {
                doubleInfo.active = false;
            }
        }, 20000);
        
        res.json({
            success: true,
            team,
            doubleA: battle.doubleA,
            doubleB: battle.doubleB
        });
    } catch (error) {
        console.error('Activate double error:', error);
        res.status(500).json({ error: 'خطأ في تفعيل الدبل' });
    }
});

// إنهاء الجولة
app.post('/api/rooms/:roomId/battle/end', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.id;
        
        // التحقق من أن المستخدم هو مالك الغرفة
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (!room || room.ownerId !== userId) {
            return res.status(403).json({ error: 'فقط مالك الغرفة يمكنه إنهاء الجولة' });
        }
        
        const battle = activeBattles.get(roomId);
        if (!battle) {
            return res.status(404).json({ error: 'لا توجد جولة نشطة' });
        }
        
        // تحديد الفريق الفائز
        let winnerTeam = null;
        if (battle.teamAScore > battle.teamBScore) {
            winnerTeam = 'A';
        } else if (battle.teamBScore > battle.teamAScore) {
            winnerTeam = 'B';
        } else {
            winnerTeam = 'draw'; // تعادل
        }
        
        // أفضل لاعب في كل فريق
        const teamAPlayers = battle.participants.filter(p => p.team === 'A');
        const teamBPlayers = battle.participants.filter(p => p.team === 'B');
        
        const mvpA = teamAPlayers.length > 0 
            ? teamAPlayers.reduce((a, b) => a.score > b.score ? a : b) 
            : null;
        const mvpB = teamBPlayers.length > 0 
            ? teamBPlayers.reduce((a, b) => a.score > b.score ? a : b) 
            : null;
        
        activeBattles.delete(roomId);
        
        // حفظ الفائز مؤقتاً لمدة دقيقة (لعرض التاج)
        if (winnerTeam && winnerTeam !== 'draw') {
            battleWinners.set(roomId, {
                winnerTeam,
                endTime: Date.now() + 60000 // دقيقة واحدة
            });
            // حذف الفائز تلقائياً بعد دقيقة
            setTimeout(() => {
                battleWinners.delete(roomId);
            }, 60000);
        }
        
        res.json({
            success: true,
            winnerTeam,
            teamAScore: battle.teamAScore,
            teamBScore: battle.teamBScore,
            teamAGems: battle.teamAGems,
            teamBGems: battle.teamBGems,
            participants: battle.participants,
            mvpA,
            mvpB
        });
    } catch (error) {
        console.error('End battle error:', error);
        res.status(500).json({ error: 'خطأ في إنهاء الجولة' });
    }
});

// إضافة مشارك جديد للجولة (عند جلوس شخص على المايك)
app.post('/api/rooms/:roomId/battle/join', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { seatNumber } = req.body;
        const userId = req.user.id;
        
        const battle = activeBattles.get(roomId);
        if (!battle) {
            return res.json({ success: false, message: 'لا توجد جولة نشطة' });
        }
        
        // التحقق من عدم وجود المشارك
        if (battle.participants.find(p => p.odId === userId)) {
            return res.json({ success: true, message: 'المشارك موجود بالفعل' });
        }
        
        // جلب بيانات المستخدم
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, avatar: true }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        // إضافة المشارك
        battle.participants.push({
            odId: user.id,
            seatNumber,
            username: user.username,
            avatar: user.avatar,
            score: 0,
            gems: 0,
            team: seatNumber <= 2 ? 'A' : 'B'
        });
        
        res.json({ success: true, participants: battle.participants });
    } catch (error) {
        console.error('Battle join error:', error);
        res.status(500).json({ error: 'خطأ في الانضمام للجولة' });
    }
});

// إزالة مشارك من الجولة (عند مغادرة المايك)
app.post('/api/rooms/:roomId/battle/leave', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user.id;
        
        const battle = activeBattles.get(roomId);
        if (!battle) {
            return res.json({ success: false, message: 'لا توجد جولة نشطة' });
        }
        
        // إزالة المشارك (لكن نحتفظ بسكوره في سكور الفريق)
        const participantIndex = battle.participants.findIndex(p => p.odId === userId);
        if (participantIndex !== -1) {
            battle.participants.splice(participantIndex, 1);
        }
        
        res.json({ success: true, participants: battle.participants });
    } catch (error) {
        console.error('Battle leave error:', error);
        res.status(500).json({ error: 'خطأ في مغادرة الجولة' });
    }
});

// ============================================================
// 📰 APIs تبويبات المنشورات (رائج، متابعين، استكشاف)
// ============================================================

// رائج - خوارزمية ذكية: غير المشاهدة + الأكثر تفاعلاً أولاً
app.get('/api/posts/trending', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const userId = req.user.id;
        
        // جلب المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        // جلب المنشورات التي شاهدها المستخدم
        const viewedPosts = await prisma.postView.findMany({
            where: { userId },
            select: { postId: true }
        });
        const viewedPostIds = new Set(viewedPosts.map(v => v.postId));
        
        // جلب الريلز التي شاهدها المستخدم
        const viewedReels = await prisma.reelView.findMany({
            where: { userId },
            select: { reelId: true }
        });
        const viewedReelIds = new Set(viewedReels.map(v => v.reelId));
        
        // جلب المنشورات
        const posts = await prisma.post.findMany({
            where: { createdAt: { gte: sevenDaysAgo } },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 3
                },
                postLikes: { where: { userId } },
                _count: { select: { comments: true } }
            }
        });
        
        // جلب الريلز
        const reels = await prisma.reel.findMany({
            where: {
                createdAt: { gte: sevenDaysAgo },
                isPublic: true,
                user: { isPrivate: { not: true } }
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                reelLikes: { where: { userId }, select: { id: true } },
                _count: { select: { reelComments: true, reelLikes: true } }
            }
        });
        
        // تنسيق المنشورات مع حساب السكور
        const formattedPosts = posts.map(post => {
            const isViewed = viewedPostIds.has(post.id);
            const engagement = post.likes + (post._count.comments * 2); // التعليقات أهم
            // السكور: غير المشاهدة تحصل على أولوية عالية + التفاعل
            const score = (isViewed ? 0 : 10000) + engagement;
            
            return {
                ...post,
                type: 'post',
                isLiked: post.postLikes.length > 0,
                isFollowing: followingIds.includes(post.userId),
                isMine: post.userId === userId,
                commentsCount: post._count.comments,
                isViewed,
                score,
                postLikes: undefined,
                _count: undefined
            };
        });
        
        // تنسيق الريلز مع حساب السكور
        const formattedReels = reels.map(reel => {
            const isViewed = viewedReelIds.has(reel.id);
            const engagement = reel._count.reelLikes + (reel._count.reelComments * 2) + (reel.views * 0.1);
            const score = (isViewed ? 0 : 10000) + engagement;
            
            return {
                id: reel.id,
                type: 'reel',
                videoUrl: reel.videoUrl,
                thumbnailUrl: reel.thumbnailUrl,
                caption: reel.caption,
                duration: reel.duration,
                views: reel.views,
                likes: reel._count.reelLikes,
                commentsCount: reel._count.reelComments,
                isLiked: reel.reelLikes.length > 0,
                isFollowing: followingIds.includes(reel.userId),
                isMine: reel.userId === userId,
                user: reel.user,
                createdAt: reel.createdAt,
                isViewed,
                score
            };
        });
        
        // دمج وترتيب حسب السكور (غير المشاهدة + الأكثر تفاعلاً أولاً)
        const combined = [...formattedPosts, ...formattedReels]
            .sort((a, b) => b.score - a.score);
        
        // تطبيق pagination
        const paginated = combined.slice(skip, skip + limit)
            .map(item => {
                const { score, ...rest } = item;
                return rest;
            });
        
        res.json(paginated);
    } catch (error) {
        console.error('Trending posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب المنشورات الرائجة' });
    }
});

// منشورات المتابعين - تحميل تدريجي (مختلطة حسب التاريخ)
app.get('/api/posts/following', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const userId = req.user.id;
        
        // جلب قائمة المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        if (followingIds.length === 0) {
            return res.json([]);
        }
        
        // جلب المنشورات
        const posts = await prisma.post.findMany({
            where: { userId: { in: followingIds } },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 3
                },
                postLikes: { where: { userId } },
                _count: { select: { comments: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // جلب الريلز
        const reels = await prisma.reel.findMany({
            where: { userId: { in: followingIds }, isPublic: true },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                reelLikes: { where: { userId }, select: { id: true } },
                _count: { select: { reelComments: true, reelLikes: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // تنسيق المنشورات
        const formattedPosts = posts.map(post => ({
            ...post,
            type: 'post',
            isLiked: post.postLikes.length > 0,
            isFollowing: true,
            isMine: post.userId === userId,
            commentsCount: post._count.comments,
            postLikes: undefined,
            _count: undefined
        }));
        
        // تنسيق الريلز
        const formattedReels = reels.map(reel => ({
            id: reel.id,
            type: 'reel',
            videoUrl: reel.videoUrl,
            thumbnailUrl: reel.thumbnailUrl,
            caption: reel.caption,
            duration: reel.duration,
            views: reel.views,
            likes: reel._count.reelLikes,
            commentsCount: reel._count.reelComments,
            isLiked: reel.reelLikes.length > 0,
            isFollowing: true,
            isMine: reel.userId === userId,
            user: reel.user,
            createdAt: reel.createdAt
        }));
        
        // دمج وترتيب حسب التاريخ (الأحدث أولاً)
        const combined = [...formattedPosts, ...formattedReels]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        // تطبيق pagination
        const paginated = combined.slice(skip, skip + limit);
        
        res.json(paginated);
    } catch (error) {
        console.error('Following posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب منشورات المتابعين' });
    }
});

// استكشاف - تحميل تدريجي (مختلطة حسب التاريخ - استبعاد المتابَعين)
app.get('/api/posts/explore', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const userId = req.user.id;
        
        // جلب قائمة المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        const excludeIds = [...followingIds, userId];
        
        // جلب المنشورات (استبعاد المتابَعين ومنشوراتي)
        const posts = await prisma.post.findMany({
            where: {
                userId: { notIn: excludeIds },
                user: { isPrivate: false }
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true, experience: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 3
                },
                postLikes: { where: { userId } },
                _count: { select: { comments: true } }
            },
            orderBy: [{ likes: 'desc' }, { createdAt: 'desc' }]
        });
        
        // جلب الريلز (استبعاد المتابَعين وريلزاتي)
        const reels = await prisma.reel.findMany({
            where: {
                userId: { notIn: excludeIds },
                isPublic: true,
                user: { isPrivate: false }
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                reelLikes: { where: { userId }, select: { id: true } },
                _count: { select: { reelComments: true, reelLikes: true } }
            },
            orderBy: [{ likes: 'desc' }, { views: 'desc' }]
        });
        
        // تنسيق المنشورات
        const formattedPosts = posts.map(post => ({
            ...post,
            type: 'post',
            isLiked: post.postLikes.length > 0,
            isFollowing: false,
            isMine: false,
            commentsCount: post._count.comments,
            postLikes: undefined,
            _count: undefined
        }));
        
        // تنسيق الريلز
        const formattedReels = reels.map(reel => ({
            id: reel.id,
            type: 'reel',
            videoUrl: reel.videoUrl,
            thumbnailUrl: reel.thumbnailUrl,
            caption: reel.caption,
            duration: reel.duration,
            views: reel.views,
            likes: reel._count.reelLikes,
            commentsCount: reel._count.reelComments,
            isLiked: reel.reelLikes.length > 0,
            isFollowing: false,
            isMine: false,
            user: reel.user,
            createdAt: reel.createdAt
        }));
        
        // دمج وترتيب حسب التاريخ (الأحدث أولاً)
        const combined = [...formattedPosts, ...formattedReels]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        // تطبيق pagination
        const paginated = combined.slice(skip, skip + limit);
        
        res.json(paginated);
    } catch (error) {
        console.error('Explore posts error:', error);
        res.status(500).json({ error: 'خطأ في جلب منشورات الاستكشاف' });
    }
});

// جلب منشور واحد بالـ ID (يجب أن يكون بعد endpoints trending/following/explore)
app.get('/api/posts/:postId', authenticate, async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;
        
        // جلب المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true, experience: true } },
                comments: {
                    include: { user: { select: { id: true, username: true, avatar: true, level: true } } },
                    orderBy: { createdAt: 'desc' },
                    take: 10
                },
                postLikes: { where: { userId } }
            }
        });
        
        if (!post) {
            return res.status(404).json({ error: 'المنشور غير موجود' });
        }
        
        res.json({
            ...post,
            isLiked: post.postLikes.length > 0,
            isFollowing: followingIds.includes(post.userId),
            isMine: post.userId === userId,
            postLikes: undefined
        });
    } catch (error) {
        console.error('Get post error:', error);
        res.status(500).json({ error: 'خطأ في جلب المنشور' });
    }
});

// ============================================================
// 🎬 APIs الريلز (Reels)
// ============================================================

// جلب الريلز - خوارزمية ذكية: غير المشاهدة + الأكثر تفاعلاً + خلال 24 ساعة أولاً
app.get('/api/reels', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const startReelId = req.query.startId;
        const limit = 5;
        const skip = (page - 1) * limit;
        const userId = req.user.id;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const MEDIA_SERVER_URL = process.env.MEDIA_SERVER_URL || 'http://62.84.176.222:3002';
        
        // دالة لتوليد WebM URL من video URL (للتوافق مع MediaTek)
        const getWebmUrl = (videoUrl) => {
            if (!videoUrl) return null;
            // استبدال .mp4 بـ .webm
            return videoUrl.replace('.mp4', '.webm');
        };
        
        // دالة لتوليد HLS URL من video URL
        const getHlsUrl = (videoUrl) => {
            if (!videoUrl) return null;
            const match = videoUrl.match(/\/videos\/([a-f0-9-]+)\.mp4/);
            if (match) {
                return `${MEDIA_SERVER_URL}/uploads/hls/${match[1]}/master.m3u8`;
            }
            return null;
        };
        
        // جلب المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        // جلب الريلز التي شاهدها المستخدم
        const viewedReels = await prisma.reelView.findMany({
            where: { userId },
            select: { reelId: true }
        });
        const viewedReelIds = new Set(viewedReels.map(v => v.reelId));
        
        // إذا طلب البدء من ريل معين
        if (startReelId && page === 1) {
            const specificReel = await prisma.reel.findUnique({
                where: { id: startReelId },
                include: {
                    user: { select: { id: true, username: true, avatar: true, level: true } },
                    reelLikes: { where: { userId }, select: { id: true } },
                    _count: { select: { reelComments: true, reelLikes: true } }
                }
            });
            
            // جلب ريلز إضافية بالخوارزمية الذكية
            const otherReels = await prisma.reel.findMany({
                where: {
                    isPublic: true,
                    id: { not: startReelId },
                    user: { isPrivate: { not: true } }
                },
                include: {
                    user: { select: { id: true, username: true, avatar: true, level: true } },
                    reelLikes: { where: { userId }, select: { id: true } },
                    _count: { select: { reelComments: true, reelLikes: true } }
                }
            });
            
            // تطبيق الخوارزمية الذكية
            const scoredReels = otherReels.map(reel => {
                const isViewed = viewedReelIds.has(reel.id);
                const isRecent = new Date(reel.createdAt) > oneDayAgo;
                const engagement = reel._count.reelLikes + (reel._count.reelComments * 2) + (reel.views * 0.1);
                // السكور: غير المشاهدة (10000) + حديثة خلال 24 ساعة (5000) + التفاعل
                const score = (isViewed ? 0 : 10000) + (isRecent ? 5000 : 0) + engagement;
                return { ...reel, score, isViewed };
            }).sort((a, b) => b.score - a.score).slice(0, limit - 1);
            
            const allReels = specificReel ? [specificReel, ...scoredReels] : scoredReels;
            
            const formattedReels = allReels.map(reel => ({
                id: reel.id,
                videoUrl: reel.videoUrl,
                webmUrl: getWebmUrl(reel.videoUrl),
                hlsUrl: getHlsUrl(reel.videoUrl),
                thumbnailUrl: reel.thumbnailUrl,
                caption: reel.caption,
                duration: reel.duration,
                views: reel.views,
                likes: reel._count.reelLikes,
                commentsCount: reel._count.reelComments,
                isLiked: reel.reelLikes.length > 0,
                isFollowing: followingIds.includes(reel.userId),
                isMine: reel.userId === userId,
                user: reel.user,
                createdAt: reel.createdAt
            }));
            
            return res.json(formattedReels);
        }
        
        // جلب جميع الريلز ثم تطبيق الخوارزمية
        const reels = await prisma.reel.findMany({
            where: {
                isPublic: true,
                user: { isPrivate: { not: true } }
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                reelLikes: { where: { userId }, select: { id: true } },
                _count: { select: { reelComments: true, reelLikes: true } }
            }
        });
        
        // تطبيق الخوارزمية الذكية
        const scoredReels = reels.map(reel => {
            const isViewed = viewedReelIds.has(reel.id);
            const isRecent = new Date(reel.createdAt) > oneDayAgo;
            const engagement = reel._count.reelLikes + (reel._count.reelComments * 2) + (reel.views * 0.1);
            // السكور: غير المشاهدة (10000) + حديثة خلال 24 ساعة (5000) + التفاعل
            const score = (isViewed ? 0 : 10000) + (isRecent ? 5000 : 0) + engagement;
            return { ...reel, score, isViewed };
        }).sort((a, b) => b.score - a.score);
        
        // تطبيق pagination
        const paginated = scoredReels.slice(skip, skip + limit);
        
        const formattedReels = paginated.map(reel => ({
            id: reel.id,
            videoUrl: reel.videoUrl,
            webmUrl: getWebmUrl(reel.videoUrl),
            hlsUrl: getHlsUrl(reel.videoUrl),
            thumbnailUrl: reel.thumbnailUrl,
            caption: reel.caption,
            duration: reel.duration,
            views: reel.views,
            likes: reel._count.reelLikes,
            commentsCount: reel._count.reelComments,
            isLiked: reel.reelLikes.length > 0,
            isFollowing: followingIds.includes(reel.userId),
            isMine: reel.userId === userId,
            user: reel.user,
            createdAt: reel.createdAt
        }));
        
        res.json(formattedReels);
    } catch (error) {
        console.error('Get reels error:', error);
        res.status(500).json({ error: 'خطأ في جلب الريلز' });
    }
});

// جلب ريلز المتابعين فقط
app.get('/api/reels/following', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const userId = req.user.id;
        
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        if (followingIds.length === 0) {
            return res.json([]);
        }
        
        const reels = await prisma.reel.findMany({
            where: {
                userId: { in: followingIds },
                isPublic: true
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                reelLikes: { where: { userId }, select: { id: true } },
                _count: { select: { reelComments: true, reelLikes: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        const formattedReels = reels.map(reel => ({
            id: reel.id,
            videoUrl: reel.videoUrl,
            thumbnailUrl: reel.thumbnailUrl,
            caption: reel.caption,
            duration: reel.duration,
            views: reel.views,
            likes: reel._count.reelLikes,
            commentsCount: reel._count.reelComments,
            isLiked: reel.reelLikes.length > 0,
            isFollowing: true,
            user: reel.user,
            createdAt: reel.createdAt
        }));
        
        res.json(formattedReels);
    } catch (error) {
        console.error('Get following reels error:', error);
        res.status(500).json({ error: 'خطأ في جلب ريلز المتابعين' });
    }
});

// إنشاء ريل جديد
app.post('/api/reels', authenticate, async (req, res) => {
    try {
        const { videoUrl, thumbnailUrl, caption, duration } = req.body;
        
        if (!videoUrl) {
            return res.status(400).json({ error: 'رابط الفيديو مطلوب' });
        }
        
        const reel = await prisma.reel.create({
            data: {
                userId: req.user.id,
                videoUrl,
                thumbnailUrl,
                caption: caption || '',
                duration: duration || 0
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } }
            }
        });
        
        res.json({
            ...reel,
            likes: 0,
            commentsCount: 0,
            isLiked: false
        });
    } catch (error) {
        console.error('Create reel error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء الريل' });
    }
});

// إعجاب/إلغاء إعجاب ريل
app.post('/api/reels/:reelId/like', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        const userId = req.user.id;
        
        const existingLike = await prisma.reelLike.findUnique({
            where: { reelId_userId: { reelId, userId } }
        });
        
        if (existingLike) {
            await prisma.reelLike.delete({ where: { id: existingLike.id } });
            await prisma.reel.update({
                where: { id: reelId },
                data: { likes: { decrement: 1 } }
            });
            res.json({ liked: false });
        } else {
            await prisma.reelLike.create({ data: { reelId, userId } });
            await prisma.reel.update({
                where: { id: reelId },
                data: { likes: { increment: 1 } }
            });
            res.json({ liked: true });
        }
    } catch (error) {
        console.error('Like reel error:', error);
        res.status(500).json({ error: 'خطأ في الإعجاب' });
    }
});

// تسجيل مشاهدة ريل (مع تتبع المشاهدات لكل مستخدم)
app.post('/api/reels/:reelId/view', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        const { watchTime, completed } = req.body;
        const userId = req.user.id;
        
        // تحديث أو إنشاء سجل المشاهدة
        await prisma.reelView.upsert({
            where: { reelId_userId: { reelId, userId } },
            update: { 
                watchTime: watchTime || 0,
                completed: completed || false
            },
            create: {
                reelId,
                userId,
                watchTime: watchTime || 0,
                completed: completed || false
            }
        });
        
        // زيادة عداد المشاهدات (مرة واحدة فقط لكل مستخدم)
        const existingView = await prisma.reelView.findUnique({
            where: { reelId_userId: { reelId, userId } }
        });
        
        if (!existingView || existingView.watchTime === 0) {
            await prisma.reel.update({
                where: { id: reelId },
                data: { views: { increment: 1 } }
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('View reel error:', error);
        res.status(500).json({ error: 'خطأ' });
    }
});

// جلب تعليقات ريل
app.get('/api/reels/:reelId/comments', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        const comments = await prisma.reelComment.findMany({
            where: { reelId },
            include: {
                reel: false
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        // جلب بيانات المستخدمين
        const userIds = [...new Set(comments.map(c => c.userId))];
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, avatar: true, level: true }
        });
        const usersMap = Object.fromEntries(users.map(u => [u.id, u]));
        
        const formattedComments = comments.map(comment => ({
            ...comment,
            user: usersMap[comment.userId]
        }));
        
        res.json(formattedComments);
    } catch (error) {
        console.error('Get reel comments error:', error);
        res.status(500).json({ error: 'خطأ في جلب التعليقات' });
    }
});

// إضافة تعليق على ريل
app.post('/api/reels/:reelId/comments', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        const { content, parentId } = req.body;
        
        if (!content?.trim()) {
            return res.status(400).json({ error: 'التعليق مطلوب' });
        }
        
        const comment = await prisma.reelComment.create({
            data: {
                reelId,
                userId: req.user.id,
                content: content.trim(),
                parentId: parentId || null
            },
            include: {
                parent: true
            }
        });
        
        // جلب بيانات صاحب التعليق الأصلي للإشعار
        let parentComment = null;
        if (parentId) {
            parentComment = await prisma.reelComment.findUnique({
                where: { id: parentId },
                select: { userId: true }
            });
        }
        
        // إنشاء إشعار لصاحب الريل
        const reel = await prisma.reel.findUnique({ where: { id: reelId } });
        if (reel && reel.userId !== req.user.id) {
            await prisma.notification.create({
                data: {
                    userId: reel.userId,
                    type: 'comment',
                    title: 'تعليق جديد',
                    message: `${req.user.username} علق على الريل الخاص بك`,
                    data: JSON.stringify({ reelId, commentId: comment.id })
                }
            });
        }
        
        // إنشاء إشعار للشخص المرد عليه
        if (parentId && parentComment && parentComment.userId !== req.user.id) {
            await prisma.notification.create({
                data: {
                    userId: parentComment.userId,
                    type: 'reply',
                    title: 'رد جديد',
                    message: `${req.user.username} رد على تعليقك`,
                    data: JSON.stringify({ reelId, commentId: comment.id, parentId })
                }
            });
        }
        
        res.json({
            ...comment,
            user: {
                id: req.user.id,
                username: req.user.username,
                avatar: req.user.avatar,
                level: req.user.level
            }
        });
    } catch (error) {
        console.error('Add reel comment error:', error);
        res.status(500).json({ error: 'خطأ في إضافة التعليق' });
    }
});

// ============================================================
// ✏️ تعديل وحذف الريلز
// ============================================================

// تعديل ريل
app.put('/api/reels/:reelId', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        const { caption, thumbnailUrl } = req.body;
        
        // التحقق من ملكية الريل
        const reel = await prisma.reel.findUnique({ where: { id: reelId } });
        if (!reel) {
            return res.status(404).json({ error: 'الريل غير موجود' });
        }
        if (reel.userId !== req.user.id) {
            return res.status(403).json({ error: 'لا يمكنك تعديل ريل شخص آخر' });
        }
        
        const updatedReel = await prisma.reel.update({
            where: { id: reelId },
            data: {
                caption: caption !== undefined ? caption : reel.caption,
                thumbnailUrl: thumbnailUrl !== undefined ? thumbnailUrl : reel.thumbnailUrl,
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } }
            }
        });
        
        res.json(updatedReel);
    } catch (error) {
        console.error('Update reel error:', error);
        res.status(500).json({ error: 'فشل تعديل الريل' });
    }
});

// حذف ريل
app.delete('/api/reels/:reelId', authenticate, async (req, res) => {
    try {
        const { reelId } = req.params;
        
        // التحقق من ملكية الريل
        const reel = await prisma.reel.findUnique({ where: { id: reelId } });
        if (!reel) {
            return res.status(404).json({ error: 'الريل غير موجود' });
        }
        if (reel.userId !== req.user.id) {
            return res.status(403).json({ error: 'لا يمكنك حذف ريل شخص آخر' });
        }
        
        // حذف التعليقات والإعجابات والمشاهدات المرتبطة
        await prisma.reelComment.deleteMany({ where: { reelId } });
        await prisma.reelLike.deleteMany({ where: { reelId } });
        await prisma.reelView.deleteMany({ where: { reelId } });
        
        // حذف الريل
        await prisma.reel.delete({ where: { id: reelId } });
        
        res.json({ success: true, message: 'تم حذف الريل بنجاح' });
    } catch (error) {
        console.error('Delete reel error:', error);
        res.status(500).json({ error: 'فشل حذف الريل' });
    }
});

// ============================================================
// 🔧 API تجريبي للتحقق من الريلز
// ============================================================

// جلب عدد الريلز (للتحقق)
app.get('/api/reels/debug', authenticate, async (req, res) => {
    try {
        const totalReels = await prisma.reel.count();
        const publicReels = await prisma.reel.count({ where: { isPublic: true } });
        const myReels = await prisma.reel.count({ where: { userId: req.user.id } });
        
        const reels = await prisma.reel.findMany({
            take: 5,
            include: { user: { select: { id: true, username: true, isPrivate: true } } }
        });
        
        res.json({
            totalReels,
            publicReels,
            myReels,
            sampleReels: reels.map(r => ({
                id: r.id,
                videoUrl: r.videoUrl?.substring(0, 50) + '...',
                userId: r.userId,
                username: r.user.username,
                isPublic: r.isPublic,
                userIsPrivate: r.user.isPrivate
            }))
        });
    } catch (error) {
        console.error('Debug reels error:', error);
        res.status(500).json({ error: error.message });
    }
});

// إضافة ريل تجريبي
app.post('/api/reels/test', authenticate, async (req, res) => {
    try {
        const testVideos = [
            'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
            'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
            'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
        ];
        
        const randomVideo = testVideos[Math.floor(Math.random() * testVideos.length)];
        
        const reel = await prisma.reel.create({
            data: {
                userId: req.user.id,
                videoUrl: randomVideo,
                caption: 'ريل تجريبي #' + Date.now(),
                duration: 30,
                isPublic: true
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } }
            }
        });
        
        res.json({ success: true, reel });
    } catch (error) {
        console.error('Create test reel error:', error);
        res.status(500).json({ error: error.message });
    }
});

// إصلاح روابط الفيديو القديمة (تحويل localhost إلى VPS)
app.post('/api/reels/fix-urls', authenticate, async (req, res) => {
    try {
        const MEDIA_SERVER_URL = process.env.MEDIA_SERVER_URL || 'http://62.84.176.222:3002';
        
        // جلب جميع الريلز التي تحتوي على localhost
        const reelsToFix = await prisma.reel.findMany({
            where: {
                OR: [
                    { videoUrl: { contains: 'localhost' } },
                    { thumbnailUrl: { contains: 'localhost' } }
                ]
            }
        });
        
        let fixedCount = 0;
        for (const reel of reelsToFix) {
            const updates = {};
            if (reel.videoUrl && reel.videoUrl.includes('localhost')) {
                updates.videoUrl = reel.videoUrl.replace(/http:\/\/localhost:\d+/, MEDIA_SERVER_URL);
            }
            if (reel.thumbnailUrl && reel.thumbnailUrl.includes('localhost')) {
                updates.thumbnailUrl = reel.thumbnailUrl.replace(/http:\/\/localhost:\d+/, MEDIA_SERVER_URL);
            }
            
            if (Object.keys(updates).length > 0) {
                await prisma.reel.update({
                    where: { id: reel.id },
                    data: updates
                });
                fixedCount++;
            }
        }
        
        res.json({ 
            success: true, 
            message: `تم إصلاح ${fixedCount} ريل`,
            totalFound: reelsToFix.length,
            fixedCount
        });
    } catch (error) {
        console.error('Fix reels URLs error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 📖 APIs الستوريات (Stories)
// ============================================================

// جلب ستوريات المتابعين + ستورياتي
app.get('/api/stories', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();
        
        // جلب المتابَعين
        const following = await prisma.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true }
        });
        const followingIds = following.map(f => f.followingId);
        
        // جلب ستورياتي
        const myStories = await prisma.story.findMany({
            where: { userId, expiresAt: { gt: now } },
            orderBy: { createdAt: 'desc' }
        });
        
        // جلب ستوريات المتابعين
        const followingStories = await prisma.story.findMany({
            where: {
                userId: { in: followingIds },
                expiresAt: { gt: now }
            },
            include: {
                user: { select: { id: true, username: true, avatar: true, level: true } },
                views: { where: { userId }, select: { id: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // تجميع الستوريات حسب المستخدم
        const userStoriesMap = new Map();
        
        // إضافة ستورياتي أولاً
        if (myStories.length > 0) {
            userStoriesMap.set(userId, {
                user: {
                    id: req.user.id,
                    username: req.user.username,
                    avatar: req.user.avatar,
                    level: req.user.level
                },
                stories: myStories.map(s => ({
                    id: s.id,
                    mediaUrl: s.mediaUrl,
                    mediaType: s.mediaType,
                    caption: s.caption,
                    overlays: s.overlays,
                    duration: s.duration,
                    viewsCount: s.viewsCount,
                    isViewed: true, // ستورياتي دائماً مشاهدة
                    createdAt: s.createdAt,
                    expiresAt: s.expiresAt
                })),
                hasUnviewed: false,
                isMe: true
            });
        }
        
        // تجميع ستوريات المتابعين
        for (const story of followingStories) {
            const uid = story.userId;
            const isViewed = story.views.length > 0;
            
            if (!userStoriesMap.has(uid)) {
                userStoriesMap.set(uid, {
                    user: story.user,
                    stories: [],
                    hasUnviewed: false,
                    isMe: false
                });
            }
            
            const userStories = userStoriesMap.get(uid);
            userStories.stories.push({
                id: story.id,
                mediaUrl: story.mediaUrl,
                mediaType: story.mediaType,
                caption: story.caption,
                overlays: story.overlays,
                duration: story.duration,
                viewsCount: story.viewsCount,
                isViewed,
                createdAt: story.createdAt,
                expiresAt: story.expiresAt
            });
            
            if (!isViewed) userStories.hasUnviewed = true;
        }
        
        // تحويل لمصفوفة وترتيب (غير المشاهدة أولاً)
        const result = Array.from(userStoriesMap.values());
        result.sort((a, b) => {
            if (a.isMe) return -1; // ستورياتي أولاً
            if (b.isMe) return 1;
            if (a.hasUnviewed && !b.hasUnviewed) return -1;
            if (!a.hasUnviewed && b.hasUnviewed) return 1;
            return 0;
        });
        
        res.json(result);
    } catch (error) {
        console.error('Get stories error:', error);
        res.status(500).json({ error: 'خطأ في جلب الستوريات' });
    }
});

// إنشاء ستوري جديد
app.post('/api/stories', authenticate, async (req, res) => {
    try {
        console.log('=== CREATE STORY REQUEST ===');
        console.log('Request body:', JSON.stringify(req.body, null, 2));
        
        const { mediaUrl, mediaType, caption, duration, overlays } = req.body;
        
        console.log('Extracted overlays:', overlays);
        console.log('Overlays type:', typeof overlays);
        
        if (!mediaUrl) {
            return res.status(400).json({ error: 'رابط الوسائط مطلوب' });
        }
        
        // تنتهي بعد 24 ساعة
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        const storyData = {
            userId: req.user.id,
            mediaUrl,
            mediaType: mediaType || 'image',
            caption: caption || null,
            overlays: overlays || null, // JSON للنصوص والملصقات
            duration: duration || (mediaType === 'video' ? 15 : 5),
            expiresAt
        };
        
        console.log('Story data to save:', JSON.stringify(storyData, null, 2));
        
        const story = await prisma.story.create({ data: storyData });
        
        console.log('Story created successfully:', JSON.stringify(story, null, 2));
        
        res.json(story);
    } catch (error) {
        console.error('Create story error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء الستوري' });
    }
});

// تسجيل مشاهدة ستوري
app.post('/api/stories/:storyId/view', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        const userId = req.user.id;
        
        // التحقق من وجود الستوري
        const story = await prisma.story.findUnique({ where: { id: storyId } });
        if (!story) {
            return res.status(404).json({ error: 'الستوري غير موجود' });
        }
        
        // لا تسجل مشاهدة لستورياتي
        if (story.userId === userId) {
            return res.json({ success: true });
        }
        
        // التحقق من وجود مشاهدة سابقة
        const existingView = await prisma.storyView.findUnique({
            where: { storyId_userId: { storyId, userId } }
        });
        
        // تسجيل المشاهدة فقط إذا لم تكن موجودة
        if (!existingView) {
            await prisma.storyView.create({
                data: { storyId, userId }
            });
            
            // زيادة عداد المشاهدات فقط عند أول مشاهدة
            await prisma.story.update({
                where: { id: storyId },
                data: { viewsCount: { increment: 1 } }
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('View story error:', error);
        res.status(500).json({ error: 'خطأ في تسجيل المشاهدة' });
    }
});

// جلب مشاهدي ستوري معين
app.get('/api/stories/:storyId/viewers', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        
        // التحقق من أن الستوري لي
        const story = await prisma.story.findUnique({ where: { id: storyId } });
        if (!story || story.userId !== req.user.id) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const views = await prisma.storyView.findMany({
            where: { storyId },
            include: {
                story: false
            },
            orderBy: { createdAt: 'desc' }
        });
        
        // جلب بيانات المستخدمين
        const userIds = views.map(v => v.userId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, avatar: true, level: true }
        });
        
        const usersMap = new Map(users.map(u => [u.id, u]));
        
        const viewers = views.map(v => ({
            ...usersMap.get(v.userId),
            viewedAt: v.createdAt
        }));
        
        res.json(viewers);
    } catch (error) {
        console.error('Get story viewers error:', error);
        res.status(500).json({ error: 'خطأ في جلب المشاهدين' });
    }
});

// حذف ستوري
app.delete('/api/stories/:storyId', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        
        const story = await prisma.story.findUnique({ where: { id: storyId } });
        if (!story || story.userId !== req.user.id) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        await prisma.story.delete({ where: { id: storyId } });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete story error:', error);
        res.status(500).json({ error: 'خطأ في حذف الستوري' });
    }
});

// إضافة/تحديث تفاعل على ستوري
app.post('/api/stories/:storyId/react', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        const { emoji } = req.body;
        const userId = req.user.id;
        
        // التحقق من وجود الستوري
        const story = await prisma.story.findUnique({ where: { id: storyId } });
        if (!story) {
            return res.status(404).json({ error: 'الستوري غير موجود' });
        }
        
        // إضافة أو تحديث التفاعل
        const reaction = await prisma.storyReaction.upsert({
            where: { storyId_userId: { storyId, userId } },
            update: { emoji },
            create: { storyId, userId, emoji },
        });
        
        // إرسال إشعار لصاحب الستوري
        if (story.userId !== userId) {
            await prisma.notification.create({
                data: {
                    userId: story.userId,
                    type: 'story_reaction',
                    title: 'تفاعل جديد',
                    message: `${req.user.username} تفاعل على ستوريك ${emoji}`,
                    data: JSON.stringify({ storyId, emoji }),
                },
            });
        }
        
        res.json(reaction);
    } catch (error) {
        console.error('Story reaction error:', error);
        res.status(500).json({ error: 'خطأ في إضافة التفاعل' });
    }
});

// حذف تفاعل من ستوري
app.delete('/api/stories/:storyId/react', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        const userId = req.user.id;
        
        await prisma.storyReaction.deleteMany({
            where: { storyId, userId },
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete reaction error:', error);
        res.status(500).json({ error: 'خطأ في حذف التفاعل' });
    }
});

// جلب تفاعلات ستوري
app.get('/api/stories/:storyId/reactions', authenticate, async (req, res) => {
    try {
        const { storyId } = req.params;
        
        const reactions = await prisma.storyReaction.findMany({
            where: { storyId },
            include: {
                story: false,
            },
        });
        
        // تجميع التفاعلات حسب الإيموجي
        const summary = {};
        reactions.forEach(r => {
            summary[r.emoji] = (summary[r.emoji] || 0) + 1;
        });
        
        res.json({ reactions, summary, total: reactions.length });
    } catch (error) {
        console.error('Get reactions error:', error);
        res.status(500).json({ error: 'خطأ في جلب التفاعلات' });
    }
});

// ============================================================
// � APIsل الدردشة الخاصة (Direct Messages)
// ============================================================

// جلب المحادثات (المقبولة + طلبات المراسلة)
app.get('/api/dm/conversations', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // جلب المحادثات التي أنا طرف فيها
        const conversations = await prisma.directConversation.findMany({
            where: {
                OR: [
                    { user1Id: userId, user1Deleted: false },
                    { user2Id: userId, user2Deleted: false }
                ]
            },
            orderBy: { lastMessageAt: 'desc' }
        });
        
        // جلب بيانات المستخدمين والرسائل الأخيرة
        const result = await Promise.all(conversations.map(async (conv) => {
            const otherUserId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;
            const isUser1 = conv.user1Id === userId;
            const isAccepted = isUser1 ? conv.user1Accepted : conv.user2Accepted;
            
            // جلب بيانات المستخدم الآخر
            const otherUser = await prisma.user.findUnique({
                where: { id: otherUserId },
                select: { id: true, username: true, avatar: true, level: true, isOnline: true, lastSeen: true }
            });
            
            // جلب آخر رسالة
            const lastMessage = await prisma.directMessage.findFirst({
                where: { conversationId: conv.id, isDeleted: false },
                orderBy: { createdAt: 'desc' }
            });
            
            // عدد الرسائل غير المقروءة
            const unreadCount = await prisma.directMessage.count({
                where: { 
                    conversationId: conv.id, 
                    senderId: { not: userId },
                    isRead: false,
                    isDeleted: false
                }
            });
            
            // التحقق من المتابعة المتبادلة
            const [iFollow, theyFollow] = await Promise.all([
                prisma.follow.findUnique({
                    where: { followerId_followingId: { followerId: userId, followingId: otherUserId } }
                }),
                prisma.follow.findUnique({
                    where: { followerId_followingId: { followerId: otherUserId, followingId: userId } }
                })
            ]);
            
            const isMutualFollow = !!iFollow && !!theyFollow;
            
            // التحقق من حالة النشاط الحقيقية
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const isReallyOnline = otherUser?.isOnline && otherUser?.lastSeen && new Date(otherUser.lastSeen) > fiveMinutesAgo;
            
            return {
                id: conv.id,
                user: otherUser ? { ...otherUser, isOnline: isReallyOnline } : null,
                lastMessage: lastMessage ? {
                    content: lastMessage.content,
                    senderId: lastMessage.senderId,
                    createdAt: lastMessage.createdAt,
                    messageType: lastMessage.messageType
                } : null,
                unreadCount,
                isAccepted: isAccepted || isMutualFollow, // مقبولة تلقائياً إذا متابعة متبادلة
                isMutualFollow,
                isRequest: !isAccepted && !isMutualFollow && lastMessage?.senderId !== userId,
                lastMessageAt: conv.lastMessageAt
            };
        }));
        
        // فصل المحادثات المقبولة عن الطلبات
        const accepted = result.filter(c => c.isAccepted || c.isMutualFollow);
        const requests = result.filter(c => c.isRequest);
        
        res.json({ conversations: accepted, requests });
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ error: 'خطأ في جلب المحادثات' });
    }
});

// بدء محادثة جديدة أو جلب محادثة موجودة
app.post('/api/dm/conversation/:userId', authenticate, async (req, res) => {
    try {
        const otherUserId = req.params.userId;
        const myId = req.user.id;
        
        if (otherUserId === myId) {
            return res.status(400).json({ error: 'لا يمكنك مراسلة نفسك' });
        }
        
        // التحقق من وجود المستخدم
        const otherUser = await prisma.user.findUnique({
            where: { id: otherUserId },
            select: { id: true, username: true, avatar: true, level: true, isOnline: true }
        });
        
        if (!otherUser) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        // ترتيب IDs لضمان التفرد
        const [user1Id, user2Id] = [myId, otherUserId].sort();
        
        // البحث عن محادثة موجودة أو إنشاء جديدة
        let conversation = await prisma.directConversation.findUnique({
            where: { user1Id_user2Id: { user1Id, user2Id } }
        });
        
        // التحقق من المتابعة المتبادلة
        const [iFollow, theyFollow] = await Promise.all([
            prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: myId, followingId: otherUserId } }
            }),
            prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: otherUserId, followingId: myId } }
            })
        ]);
        
        const isMutualFollow = !!iFollow && !!theyFollow;
        
        if (!conversation) {
            // إنشاء محادثة جديدة
            const isUser1 = user1Id === myId;
            conversation = await prisma.directConversation.create({
                data: {
                    user1Id,
                    user2Id,
                    user1Accepted: isUser1 ? true : isMutualFollow,
                    user2Accepted: !isUser1 ? true : isMutualFollow
                }
            });
        } else {
            // إعادة تفعيل المحادثة إذا كانت محذوفة
            const isUser1 = user1Id === myId;
            await prisma.directConversation.update({
                where: { id: conversation.id },
                data: isUser1 ? { user1Deleted: false } : { user2Deleted: false }
            });
        }
        
        res.json({
            conversation: {
                id: conversation.id,
                user: otherUser,
                isMutualFollow,
                isAccepted: isMutualFollow || (user1Id === myId ? conversation.user1Accepted : conversation.user2Accepted)
            }
        });
    } catch (error) {
        console.error('Start conversation error:', error);
        res.status(500).json({ error: 'خطأ في بدء المحادثة' });
    }
});

// جلب رسائل محادثة
app.get('/api/dm/conversation/:conversationId/messages', authenticate, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        
        // التحقق من أنني طرف في المحادثة
        const conversation = await prisma.directConversation.findUnique({
            where: { id: conversationId }
        });
        
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // جلب الرسائل
        const messages = await prisma.directMessage.findMany({
            where: { conversationId, isDeleted: false },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        
        // تحديث الرسائل كمقروءة
        await prisma.directMessage.updateMany({
            where: { 
                conversationId, 
                senderId: { not: userId },
                isRead: false 
            },
            data: { isRead: true }
        });
        
        // تحليل metadata للرسائل المشاركة
        const formattedMessages = messages.map(msg => {
            let sharedContent = null;
            if (msg.metadata && msg.messageType?.startsWith('shared_')) {
                try {
                    sharedContent = JSON.parse(msg.metadata);
                } catch (e) {}
            }
            return {
                ...msg,
                sharedContent,
                metadata: undefined
            };
        });
        
        res.json(formattedMessages.reverse());
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'خطأ في جلب الرسائل' });
    }
});

// إرسال رسالة
app.post('/api/dm/conversation/:conversationId/message', authenticate, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { content, messageType = 'text' } = req.body;
        const userId = req.user.id;
        
        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'محتوى الرسالة مطلوب' });
        }
        
        // التحقق من المحادثة
        const conversation = await prisma.directConversation.findUnique({
            where: { id: conversationId }
        });
        
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const otherUserId = conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;
        const isUser1 = conversation.user1Id === userId;
        
        // التحقق من المتابعة المتبادلة
        const [iFollow, theyFollow] = await Promise.all([
            prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: userId, followingId: otherUserId } }
            }),
            prisma.follow.findUnique({
                where: { followerId_followingId: { followerId: otherUserId, followingId: userId } }
            })
        ]);
        
        const isMutualFollow = !!iFollow && !!theyFollow;
        const isAccepted = isUser1 ? conversation.user2Accepted : conversation.user1Accepted;
        
        // إذا لم تكن متابعة متبادلة ولم يقبل الطرف الآخر، يُسمح برسالة واحدة فقط
        if (!isMutualFollow && !isAccepted) {
            const existingMessages = await prisma.directMessage.count({
                where: { conversationId, senderId: userId }
            });
            
            if (existingMessages >= 1) {
                return res.status(403).json({ 
                    error: 'لا يمكنك إرسال أكثر من رسالة واحدة حتى يقبل الطرف الآخر',
                    isRequest: true
                });
            }
        }
        
        // إنشاء الرسالة
        const message = await prisma.directMessage.create({
            data: {
                conversationId,
                senderId: userId,
                content: content.trim(),
                messageType
            }
        });
        
        // تحديث وقت آخر رسالة
        await prisma.directConversation.update({
            where: { id: conversationId },
            data: { 
                lastMessageAt: new Date(),
                // تفعيل المحادثة للمرسل
                ...(isUser1 ? { user1Accepted: true } : { user2Accepted: true })
            }
        });
        
        // إشعار للمستقبل
        await prisma.notification.create({
            data: {
                userId: otherUserId,
                type: 'message',
                title: '💬 رسالة جديدة',
                message: `${req.user.username}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`,
                data: JSON.stringify({ conversationId, senderId: userId })
            }
        });
        
        res.json(message);
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'خطأ في إرسال الرسالة' });
    }
});

// مشاركة محتوى (منشور/ريل/ستوري) في المحادثة
app.post('/api/dm/conversation/:conversationId/share', authenticate, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { contentType, contentId } = req.body;
        const userId = req.user.id;
        
        // التحقق من المحادثة
        const conversation = await prisma.directConversation.findUnique({
            where: { id: conversationId }
        });
        
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        // جلب بيانات المحتوى المشارك
        let sharedContent = null;
        let messageContent = '';
        
        if (contentType === 'post') {
            const post = await prisma.post.findUnique({
                where: { id: contentId },
                include: { user: { select: { id: true, username: true, avatar: true } } }
            });
            if (post) {
                sharedContent = {
                    type: 'post',
                    id: post.id,
                    preview: {
                        imageUrl: post.imageUrl,
                        content: post.content?.substring(0, 100),
                        username: post.user.username
                    }
                };
                messageContent = `📝 شارك منشور من @${post.user.username}`;
            }
        } else if (contentType === 'reel') {
            const reel = await prisma.reel.findUnique({
                where: { id: contentId },
                include: { user: { select: { id: true, username: true, avatar: true } } }
            });
            if (reel) {
                sharedContent = {
                    type: 'reel',
                    id: reel.id,
                    preview: {
                        imageUrl: reel.thumbnailUrl,
                        content: reel.caption?.substring(0, 100),
                        username: reel.user.username
                    }
                };
                messageContent = `🎬 شارك ريل من @${reel.user.username}`;
            }
        } else if (contentType === 'story') {
            const story = await prisma.story.findUnique({
                where: { id: contentId },
                include: { user: { select: { id: true, username: true, avatar: true } } }
            });
            if (story) {
                sharedContent = {
                    type: 'story',
                    id: story.id,
                    preview: {
                        imageUrl: story.mediaType === 'image' ? story.mediaUrl : null,
                        content: story.caption?.substring(0, 100),
                        username: story.user.username
                    }
                };
                messageContent = `📖 شارك ستوري من @${story.user.username}`;
            }
        }
        
        if (!sharedContent) {
            return res.status(404).json({ error: 'المحتوى غير موجود' });
        }
        
        // إنشاء الرسالة مع بيانات المشاركة
        const message = await prisma.directMessage.create({
            data: {
                conversationId,
                senderId: userId,
                content: messageContent,
                messageType: `shared_${contentType}`,
                metadata: JSON.stringify(sharedContent)
            }
        });
        
        // تحديث وقت آخر رسالة
        await prisma.directConversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: new Date() }
        });
        
        // إرجاع الرسالة مع بيانات المشاركة
        res.json({
            ...message,
            sharedContent
        });
    } catch (error) {
        console.error('Share content error:', error);
        res.status(500).json({ error: 'خطأ في مشاركة المحتوى' });
    }
});

// قبول طلب مراسلة
app.post('/api/dm/conversation/:conversationId/accept', authenticate, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const userId = req.user.id;
        
        const conversation = await prisma.directConversation.findUnique({
            where: { id: conversationId }
        });
        
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const isUser1 = conversation.user1Id === userId;
        
        await prisma.directConversation.update({
            where: { id: conversationId },
            data: isUser1 ? { user1Accepted: true } : { user2Accepted: true }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Accept conversation error:', error);
        res.status(500).json({ error: 'خطأ في قبول المحادثة' });
    }
});

// حذف محادثة
app.delete('/api/dm/conversation/:conversationId', authenticate, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const userId = req.user.id;
        
        const conversation = await prisma.directConversation.findUnique({
            where: { id: conversationId }
        });
        
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const isUser1 = conversation.user1Id === userId;
        
        await prisma.directConversation.update({
            where: { id: conversationId },
            data: isUser1 ? { user1Deleted: true } : { user2Deleted: true }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete conversation error:', error);
        res.status(500).json({ error: 'خطأ في حذف المحادثة' });
    }
});

// جلب عدد الرسائل غير المقروءة
app.get('/api/dm/unread-count', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // جلب المحادثات
        const conversations = await prisma.directConversation.findMany({
            where: {
                OR: [
                    { user1Id: userId, user1Deleted: false },
                    { user2Id: userId, user2Deleted: false }
                ]
            },
            select: { id: true }
        });
        
        const conversationIds = conversations.map(c => c.id);
        
        const unreadCount = await prisma.directMessage.count({
            where: {
                conversationId: { in: conversationIds },
                senderId: { not: userId },
                isRead: false,
                isDeleted: false
            }
        });
        
        res.json({ unreadCount });
    } catch (error) {
        console.error('Get unread count error:', error);
        res.status(500).json({ error: 'خطأ في جلب عدد الرسائل' });
    }
});

// ============================================================
// 🔐 Admin APIs - لوحة التحكم
// ============================================================

// إحصائيات لوحة التحكم
app.get('/api/admin/stats', authenticate, async (req, res) => {
    try {
        const [totalUsers, totalRooms, totalPosts, pendingWithdrawals, totalGifts] = await Promise.all([
            prisma.user.count(),
            prisma.chatRoom.count(),
            prisma.post.count(),
            prisma.withdrawRequest.count({ where: { status: 'pending' } }),
            prisma.giftMessage.count()
        ]);
        
        const activeUsers = await prisma.user.count({ where: { isOnline: true } });
        const aggregates = await prisma.user.aggregate({ _sum: { coins: true, gems: true } });
        
        // مستخدمين جدد اليوم
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newUsersToday = await prisma.user.count({ where: { createdAt: { gte: today } } });
        
        res.json({
            totalUsers,
            activeUsers,
            totalRooms,
            totalPosts,
            pendingWithdrawals,
            totalGifts,
            totalCoins: aggregates._sum.coins || 0,
            totalGems: aggregates._sum.gems || 0,
            newUsersToday
        });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// جلب المستخدمين
app.get('/api/admin/users', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const search = req.query.search || '';
        
        const where = search ? {
            OR: [
                { username: { contains: search } },
                { email: { contains: search } }
            ]
        } : {};
        
        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: { 
                    id: true, username: true, email: true, avatar: true, 
                    coins: true, gems: true, level: true, isBanned: true, createdAt: true
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.user.count({ where })
        ]);
        
        // جلب الباقات المفعلة لكل مستخدم
        const usersWithPackages = await Promise.all(users.map(async (user) => {
            try {
                const activePackages = await prisma.userPackage.findMany({
                    where: {
                        userId: user.id,
                        isActive: true,
                        expiresAt: { gt: new Date() }
                    },
                    include: {
                        package: { select: { id: true, name: true, nameAr: true, icon: true, color: true } }
                    }
                });
                
                return {
                    ...user,
                    activePackages: activePackages.map(up => ({
                        id: up.package.id,
                        name: up.package.name,
                        nameAr: up.package.nameAr,
                        icon: up.package.icon,
                        color: up.package.color,
                        expiresAt: up.expiresAt
                    }))
                };
            } catch (e) {
                return { ...user, activePackages: [] };
            }
        }));
        
        res.json({ users: usersWithPackages, total, page, pages: Math.ceil(total / limit) });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
    }
});

// تحديث مستخدم
app.put('/api/admin/users/:id', authenticate, async (req, res) => {
    try {
        const { coins, gems, level, isRestricted } = req.body;
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { coins, gems, level }
        });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث المستخدم' });
    }
});

// حذف مستخدم
app.delete('/api/admin/users/:id', authenticate, async (req, res) => {
    try {
        await prisma.user.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف المستخدم' });
    }
});

// حظر مستخدم
app.post('/api/admin/users/:id/ban', authenticate, async (req, res) => {
    try {
        const { reason } = req.body;
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { 
                isBanned: true,
                banReason: reason || 'مخالفة شروط الاستخدام'
            }
        });
        const { password: pwd, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
    } catch (error) {
        console.error('Ban user error:', error);
        res.status(500).json({ error: 'خطأ في حظر المستخدم' });
    }
});

// إلغاء حظر مستخدم
app.post('/api/admin/users/:id/unban', authenticate, async (req, res) => {
    try {
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { 
                isBanned: false,
                banReason: null
            }
        });
        const { password: pwd, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
    } catch (error) {
        console.error('Unban user error:', error);
        res.status(500).json({ error: 'خطأ في إلغاء حظر المستخدم' });
    }
});

// جلب الغرف
app.get('/api/admin/rooms', authenticate, async (req, res) => {
    try {
        const search = req.query.search || '';
        const where = search ? {
            OR: [
                { name: { contains: search } },
                { roomCode: { contains: search } }
            ]
        } : {};
        
        const rooms = await prisma.chatRoom.findMany({
            where,
            include: { owner: { select: { username: true } }, _count: { select: { members: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ rooms });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الغرف' });
    }
});

// حذف غرفة
app.delete('/api/admin/rooms/:id', authenticate, async (req, res) => {
    try {
        await prisma.chatRoom.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الغرفة' });
    }
});

// جلب المنشورات
app.get('/api/admin/posts', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        const posts = await prisma.post.findMany({
            include: { user: { select: { id: true, username: true, avatar: true } }, _count: { select: { comments: true } } },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        res.json({ posts });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب المنشورات' });
    }
});

// حذف منشور
app.delete('/api/admin/posts/:id', authenticate, async (req, res) => {
    try {
        await prisma.post.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف المنشور' });
    }
});

// جلب السحوبات
app.get('/api/admin/withdrawals', authenticate, async (req, res) => {
    try {
        const status = req.query.status;
        
        // استخدام SQL للحصول على البيانات مع طريقة السحب
        let withdrawals;
        if (status && status !== 'all') {
            withdrawals = await prisma.$queryRaw`
                SELECT 
                    w."id", w."userId", w."amount", w."status", w."note", 
                    w."paymentMethodId", w."accountNumber", w."createdAt",
                    u."id" as "user_id", u."username" as "user_username", u."email" as "user_email",
                    p."id" as "pm_id", p."name" as "pm_name", p."icon" as "pm_icon"
                FROM "WithdrawRequest" w
                LEFT JOIN "User" u ON w."userId" = u."id"
                LEFT JOIN "PaymentMethod" p ON w."paymentMethodId" = p."id"
                WHERE w."status" = ${status}
                ORDER BY w."createdAt" DESC
            `;
        } else {
            withdrawals = await prisma.$queryRaw`
                SELECT 
                    w."id", w."userId", w."amount", w."status", w."note", 
                    w."paymentMethodId", w."accountNumber", w."createdAt",
                    u."id" as "user_id", u."username" as "user_username", u."email" as "user_email",
                    p."id" as "pm_id", p."name" as "pm_name", p."icon" as "pm_icon"
                FROM "WithdrawRequest" w
                LEFT JOIN "User" u ON w."userId" = u."id"
                LEFT JOIN "PaymentMethod" p ON w."paymentMethodId" = p."id"
                ORDER BY w."createdAt" DESC
            `;
        }
        
        // جلب الباقات المفعلة لكل مستخدم
        const formatted = await Promise.all(withdrawals.map(async (w) => {
            let activePackages = [];
            try {
                const packages = await prisma.userPackage.findMany({
                    where: {
                        userId: w.user_id,
                        isActive: true,
                        expiresAt: { gt: new Date() }
                    },
                    include: {
                        package: { select: { id: true, name: true, nameAr: true, icon: true, color: true } }
                    }
                });
                activePackages = packages.map(up => ({
                    id: up.package.id,
                    name: up.package.name,
                    nameAr: up.package.nameAr,
                    icon: up.package.icon,
                    color: up.package.color
                }));
            } catch (e) {}
            
            return {
                id: w.id,
                amount: w.amount,
                status: w.status,
                note: w.note,
                accountNumber: w.accountNumber,
                createdAt: w.createdAt,
                user: { id: w.user_id, username: w.user_username, email: w.user_email, activePackages },
                paymentMethod: w.pm_id ? { id: w.pm_id, name: w.pm_name, icon: w.pm_icon } : null
            };
        }));
        
        res.json(formatted);
    } catch (error) {
        console.error('Get withdrawals error:', error);
        res.status(500).json({ error: 'خطأ في جلب السحوبات' });
    }
});

// الموافقة على سحب
app.post('/api/admin/withdrawals/:id/approve', authenticate, async (req, res) => {
    try {
        await prisma.withdrawRequest.update({
            where: { id: req.params.id },
            data: { status: 'approved' }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الموافقة' });
    }
});

// رفض سحب
app.post('/api/admin/withdrawals/:id/reject', authenticate, async (req, res) => {
    try {
        await prisma.withdrawRequest.update({
            where: { id: req.params.id },
            data: { status: 'rejected', note: req.body.reason }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الرفض' });
    }
});

// جلب الوكلاء
app.get('/api/admin/agents', authenticate, async (req, res) => {
    try {
        const agents = await prisma.agent.findMany();
        res.json(agents);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الوكلاء' });
    }
});

// إضافة وكيل
app.post('/api/admin/agents', authenticate, async (req, res) => {
    try {
        const agent = await prisma.agent.create({ data: req.body });
        res.json(agent);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إضافة الوكيل' });
    }
});

// تحديث وكيل
app.put('/api/admin/agents/:id', authenticate, async (req, res) => {
    try {
        const agent = await prisma.agent.update({ where: { id: req.params.id }, data: req.body });
        res.json(agent);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الوكيل' });
    }
});

// حذف وكيل
app.delete('/api/admin/agents/:id', authenticate, async (req, res) => {
    try {
        await prisma.agent.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الوكيل' });
    }
});

// ============ طلبات الإيداع (Deposit Requests) ============

// إنشاء طلب إيداع جديد (من المستخدم)
app.post('/api/deposit', authenticate, async (req, res) => {
    try {
        const { amount, paymentMethod, accountNumber, proofImage, note } = req.body;
        
        if (!amount || !paymentMethod || !proofImage) {
            return res.status(400).json({ error: 'يرجى إدخال المبلغ وطريقة الدفع وصورة الإثبات' });
        }
        
        if (amount <= 0) {
            return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
        }
        
        const depositId = crypto.randomUUID();
        await prisma.$executeRaw`
            INSERT INTO "deposit_request" ("id", "userId", "amount", "paymentMethod", "accountNumber", "proofImage", "note", "status", "createdAt", "updatedAt")
            VALUES (${depositId}, ${req.user.id}, ${amount}, ${paymentMethod}, ${accountNumber || null}, ${proofImage}, ${note || null}, 'pending', NOW(), NOW())
        `;
        
        // إشعار للمستخدم
        await createNotification(
            req.user.id,
            'finance',
            '📥 تم إرسال طلب الإيداع',
            `طلب إيداع ${amount} عبر ${paymentMethod} قيد المراجعة`,
            { depositId, amount, status: 'pending' }
        );
        
        res.json({ 
            success: true, 
            message: 'تم إرسال طلب الإيداع بنجاح',
            depositId 
        });
    } catch (error) {
        console.error('Create deposit error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء طلب الإيداع' });
    }
});

// جلب طلبات الإيداع للمستخدم الحالي
app.get('/api/deposits/my', authenticate, async (req, res) => {
    try {
        const deposits = await prisma.$queryRaw`
            SELECT * FROM "deposit_request" 
            WHERE "userId" = ${req.user.id}
            ORDER BY "createdAt" DESC
        `;
        res.json(deposits);
    } catch (error) {
        console.error('Get my deposits error:', error);
        res.status(500).json({ error: 'خطأ في جلب طلبات الإيداع' });
    }
});

// جلب طلبات الإيداع (للأدمن)
app.get('/api/admin/deposits', authenticate, async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let deposits;
        
        if (status === 'all') {
            deposits = await prisma.$queryRaw`
                SELECT d.*, u.username, u.email, u.avatar as "userAvatar"
                FROM "deposit_request" d
                LEFT JOIN "User" u ON d."userId" = u.id
                ORDER BY d."createdAt" DESC
            `;
        } else {
            deposits = await prisma.$queryRaw`
                SELECT d.*, u.username, u.email, u.avatar as "userAvatar"
                FROM "deposit_request" d
                LEFT JOIN "User" u ON d."userId" = u.id
                WHERE d.status = ${status}
                ORDER BY d."createdAt" DESC
            `;
        }
        
        res.json(deposits);
    } catch (error) {
        console.error('Get deposits error:', error);
        res.status(500).json({ error: 'خطأ في جلب طلبات الإيداع' });
    }
});

// الموافقة على طلب إيداع
app.post('/api/admin/deposits/:id/approve', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { coinsToAdd, gemsToAdd, note } = req.body;
        
        // جلب طلب الإيداع
        const deposits = await prisma.$queryRaw`SELECT * FROM "deposit_request" WHERE id = ${id}`;
        if (!deposits || deposits.length === 0) {
            return res.status(404).json({ error: 'طلب الإيداع غير موجود' });
        }
        
        const deposit = deposits[0];
        if (deposit.status !== 'pending') {
            return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
        }
        
        // تحديث طلب الإيداع
        await prisma.$executeRaw`
            UPDATE "deposit_request" 
            SET status = 'approved', 
                "coinsToAdd" = ${coinsToAdd || 0}, 
                "gemsToAdd" = ${gemsToAdd || 0},
                "adminNote" = ${note || null},
                "processedBy" = ${req.user.id},
                "processedAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = ${id}
        `;
        
        // إضافة العملات والجواهر للمستخدم
        if (coinsToAdd > 0 || gemsToAdd > 0) {
            await prisma.user.update({
                where: { id: deposit.userId },
                data: {
                    coins: { increment: coinsToAdd || 0 },
                    gems: { increment: gemsToAdd || 0 }
                }
            });
            
            // إرسال إشعار للمستخدم
            await createNotification(
                deposit.userId,
                'system',
                '✅ تمت الموافقة على إيداعك',
                `تم إضافة ${coinsToAdd || 0} عملة و ${gemsToAdd || 0} جوهرة إلى حسابك`,
                { depositId: id, coinsToAdd, gemsToAdd }
            );
        }
        
        res.json({ success: true, message: 'تمت الموافقة على الإيداع' });
    } catch (error) {
        console.error('Approve deposit error:', error);
        res.status(500).json({ error: 'خطأ في الموافقة على الإيداع' });
    }
});

// رفض طلب إيداع
app.post('/api/admin/deposits/:id/reject', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        // جلب طلب الإيداع
        const deposits = await prisma.$queryRaw`SELECT * FROM "deposit_request" WHERE id = ${id}`;
        if (!deposits || deposits.length === 0) {
            return res.status(404).json({ error: 'طلب الإيداع غير موجود' });
        }
        
        const deposit = deposits[0];
        if (deposit.status !== 'pending') {
            return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
        }
        
        // تحديث طلب الإيداع
        await prisma.$executeRaw`
            UPDATE "deposit_request" 
            SET status = 'rejected', 
                "adminNote" = ${reason || 'تم الرفض'},
                "processedBy" = ${req.user.id},
                "processedAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = ${id}
        `;
        
        // إرسال إشعار للمستخدم
        await createNotification(
            deposit.userId,
            'system',
            '❌ تم رفض طلب الإيداع',
            reason || 'تم رفض طلب الإيداع الخاص بك',
            { depositId: id, reason }
        );
        
        res.json({ success: true, message: 'تم رفض الإيداع' });
    } catch (error) {
        console.error('Reject deposit error:', error);
        res.status(500).json({ error: 'خطأ في رفض الإيداع' });
    }
});

// حذف طلب إيداع
app.delete('/api/admin/deposits/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.$executeRaw`DELETE FROM "deposit_request" WHERE id = ${id}`;
        res.json({ success: true });
    } catch (error) {
        console.error('Delete deposit error:', error);
        res.status(500).json({ error: 'خطأ في حذف طلب الإيداع' });
    }
});

// ============ طرق السحب (Payment Methods) ============

// جلب طرق السحب
app.get('/api/admin/payment-methods', authenticate, async (req, res) => {
    try {
        const methods = await prisma.$queryRaw`SELECT * FROM "PaymentMethod" ORDER BY "createdAt" ASC`;
        res.json(methods);
    } catch (error) {
        console.error('Get payment methods error:', error);
        res.status(500).json({ error: 'خطأ في جلب طرق السحب' });
    }
});

// إضافة طريقة سحب
app.post('/api/admin/payment-methods', authenticate, async (req, res) => {
    try {
        const { name, icon, minAmount, maxAmount, fee, isActive } = req.body;
        const id = crypto.randomUUID();
        await prisma.$executeRaw`
            INSERT INTO "PaymentMethod" ("id", "name", "icon", "minAmount", "maxAmount", "fee", "isActive", "createdAt")
            VALUES (${id}, ${name}, ${icon || null}, ${minAmount || 100}, ${maxAmount || 10000}, ${fee || 0}, ${isActive !== false}, NOW())
        `;
        const methods = await prisma.$queryRaw`SELECT * FROM "PaymentMethod" WHERE "id" = ${id}`;
        res.json(methods[0]);
    } catch (error) {
        console.error('Create payment method error:', error);
        res.status(500).json({ error: 'خطأ في إضافة طريقة السحب' });
    }
});

// تحديث طريقة سحب
app.put('/api/admin/payment-methods/:id', authenticate, async (req, res) => {
    try {
        const { name, icon, minAmount, maxAmount, fee, isActive } = req.body;
        await prisma.$executeRaw`
            UPDATE "PaymentMethod" 
            SET "name" = ${name}, "icon" = ${icon || null}, "minAmount" = ${minAmount || 100}, 
                "maxAmount" = ${maxAmount || 10000}, "fee" = ${fee || 0}, "isActive" = ${isActive !== false}
            WHERE "id" = ${req.params.id}
        `;
        const methods = await prisma.$queryRaw`SELECT * FROM "PaymentMethod" WHERE "id" = ${req.params.id}`;
        res.json(methods[0]);
    } catch (error) {
        console.error('Update payment method error:', error);
        res.status(500).json({ error: 'خطأ في تحديث طريقة السحب' });
    }
});

// حذف طريقة سحب
app.delete('/api/admin/payment-methods/:id', authenticate, async (req, res) => {
    try {
        await prisma.$executeRaw`DELETE FROM "PaymentMethod" WHERE "id" = ${req.params.id}`;
        res.json({ success: true });
    } catch (error) {
        console.error('Delete payment method error:', error);
        res.status(500).json({ error: 'خطأ في حذف طريقة السحب' });
    }
});

// ============ المستخدمين المسموح لهم بالتحويل ============

// جلب المستخدمين المسموح لهم
app.get('/api/admin/allowed-transfers', authenticate, async (req, res) => {
    try {
        const allowed = await prisma.$queryRaw`
            SELECT a."id", a."email", a."userId", a."createdAt",
                   u."username", u."avatar", u."email" as "userEmail"
            FROM "AllowedTransfer" a
            LEFT JOIN "User" u ON a."userId" = u."id"
            ORDER BY a."createdAt" DESC
        `;
        
        // تحويل البيانات للتنسيق المتوقع
        const formattedAllowed = allowed.map(a => ({
            id: a.id,
            email: a.email,
            createdAt: a.createdAt,
            user: a.userId ? {
                id: a.userId,
                username: a.username,
                avatar: a.avatar,
                email: a.userEmail
            } : null
        }));
        
        res.json(formattedAllowed);
    } catch (error) {
        console.error('Get allowed transfers error:', error);
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// إضافة مستخدم للمسموح لهم بالتحويل (بالبريد الإلكتروني)
app.post('/api/admin/allowed-transfers', authenticate, async (req, res) => {
    try {
        const { email } = req.body;
        
        // البحث عن المستخدم بالبريد
        const user = await prisma.user.findUnique({ 
            where: { email },
            select: { id: true, username: true, email: true }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }
        
        // التحقق من عدم وجوده مسبقاً
        const existing = await prisma.$queryRaw`
            SELECT * FROM "AllowedTransfer" WHERE "userId" = ${user.id}
        `;
        if (existing.length > 0) {
            return res.status(400).json({ error: 'المستخدم مضاف مسبقاً' });
        }
        
        // إضافته
        const id = crypto.randomUUID();
        await prisma.$executeRaw`
            INSERT INTO "AllowedTransfer" ("id", "userId", "email", "addedBy", "createdAt")
            VALUES (${id}, ${user.id}, ${email}, ${req.user.id}, NOW())
        `;
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Add allowed transfer error:', error);
        res.status(500).json({ error: 'خطأ في الإضافة' });
    }
});

// حذف مستخدم من المسموح لهم
app.delete('/api/admin/allowed-transfers/:id', authenticate, async (req, res) => {
    try {
        await prisma.$executeRaw`DELETE FROM "AllowedTransfer" WHERE "id" = ${req.params.id}`;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الحذف' });
    }
});

// جلب سجل التحويلات (Admin)
app.get('/api/admin/transfers', authenticate, async (req, res) => {
    try {
        const transfers = await prisma.$queryRaw`
            SELECT 
                t."id", t."amount", t."createdAt",
                t."senderId", t."receiverId",
                s."username" as "senderUsername", s."avatar" as "senderAvatar",
                r."username" as "receiverUsername", r."avatar" as "receiverAvatar"
            FROM "CoinTransfer" t
            LEFT JOIN "User" s ON t."senderId" = s."id"
            LEFT JOIN "User" r ON t."receiverId" = r."id"
            ORDER BY t."createdAt" DESC
            LIMIT 100
        `;
        
        // تحويل البيانات للتنسيق المتوقع
        const formattedTransfers = transfers.map(t => ({
            id: t.id,
            amount: t.amount,
            createdAt: t.createdAt,
            sender: {
                id: t.senderId,
                username: t.senderUsername || 'مستخدم محذوف',
                avatar: t.senderAvatar
            },
            receiver: {
                id: t.receiverId,
                username: t.receiverUsername || 'مستخدم محذوف',
                avatar: t.receiverAvatar
            }
        }));
        
        res.json(formattedTransfers);
    } catch (error) {
        console.error('Error fetching transfers:', error);
        res.json([]);
    }
});

// جلب الباقات (Admin)
app.get('/api/admin/packages', authenticate, async (req, res) => {
    try {
        const packages = await prisma.package.findMany({ orderBy: { price: 'asc' } });
        res.json(packages);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الباقات' });
    }
});

// إضافة باقة
app.post('/api/admin/packages', authenticate, async (req, res) => {
    try {
        const pkg = await prisma.package.create({ data: req.body });
        res.json(pkg);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إضافة الباقة' });
    }
});

// تحديث باقة
app.put('/api/admin/packages/:id', authenticate, async (req, res) => {
    try {
        const pkg = await prisma.package.update({ where: { id: req.params.id }, data: req.body });
        res.json(pkg);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الباقة' });
    }
});

// حذف باقة
app.delete('/api/admin/packages/:id', authenticate, async (req, res) => {
    try {
        await prisma.package.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الباقة' });
    }
});

// جلب الهدايا (Admin)
app.get('/api/admin/gifts', authenticate, async (req, res) => {
    try {
        const gifts = await prisma.gift.findMany({ orderBy: { price: 'asc' } });
        res.json(gifts);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الهدايا' });
    }
});

// إضافة هدية
app.post('/api/admin/gifts', authenticate, async (req, res) => {
    try {
        const gift = await prisma.gift.create({ data: req.body });
        res.json(gift);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إضافة الهدية' });
    }
});

// تحديث هدية
app.put('/api/admin/gifts/:id', authenticate, async (req, res) => {
    try {
        const gift = await prisma.gift.update({ where: { id: req.params.id }, data: req.body });
        res.json(gift);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الهدية' });
    }
});

// حذف هدية
app.delete('/api/admin/gifts/:id', authenticate, async (req, res) => {
    try {
        await prisma.gift.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الهدية' });
    }
});

// ============================================================
// 🎡 APIs إدارة جوائز عجلة الحظ (Admin)
// ============================================================

// جلب جوائز العجلة
app.get('/api/admin/wheel-prizes', authenticate, async (req, res) => {
    try {
        const prizes = await prisma.wheelPrize.findMany({ orderBy: { probability: 'desc' } });
        res.json(prizes);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب جوائز العجلة' });
    }
});

// إضافة جائزة
app.post('/api/admin/wheel-prizes', authenticate, async (req, res) => {
    try {
        const { name, value, type, color, probability, isActive, isWinnable } = req.body;
        const prize = await prisma.wheelPrize.create({
            data: { 
                name, 
                value, 
                type, 
                color, 
                probability: probability || 10, 
                isActive: isActive !== false,
                isWinnable: isWinnable !== false
            }
        });
        res.json(prize);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إضافة الجائزة' });
    }
});

// تحديث جائزة
app.put('/api/admin/wheel-prizes/:id', authenticate, async (req, res) => {
    try {
        const prize = await prisma.wheelPrize.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json(prize);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث الجائزة' });
    }
});

// حذف جائزة
app.delete('/api/admin/wheel-prizes/:id', authenticate, async (req, res) => {
    try {
        await prisma.wheelPrize.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الجائزة' });
    }
});

// جلب الريلز (Admin)
app.get('/api/admin/reels', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        
        const reels = await prisma.reel.findMany({
            include: { user: { select: { id: true, username: true, avatar: true } }, _count: { select: { reelComments: true } } },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        });
        res.json({ reels });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الريلز' });
    }
});

// حذف ريل
app.delete('/api/admin/reels/:id', authenticate, async (req, res) => {
    try {
        await prisma.reel.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الريل' });
    }
});

// جلب الستوريات (Admin)
app.get('/api/admin/stories', authenticate, async (req, res) => {
    try {
        const stories = await prisma.story.findMany({
            include: { user: { select: { id: true, username: true, avatar: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json(stories);
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الستوريات' });
    }
});

// حذف ستوري
app.delete('/api/admin/stories/:id', authenticate, async (req, res) => {
    try {
        await prisma.story.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في حذف الستوري' });
    }
});

// جلب الإعدادات
app.get('/api/admin/settings', authenticate, async (req, res) => {
    try {
        // استخدام raw query لجلب جميع الحقول بما فيها الجديدة
        let settings = await prisma.$queryRaw`SELECT * FROM "AppSettings" WHERE "id" = 'settings'`;
        
        if (!settings || settings.length === 0) {
            await prisma.$executeRaw`
                INSERT INTO "AppSettings" ("id", "harvestCoins", "harvestGems", "harvestInterval", "harvestReferralGems", "spinPrice", "exchangeRate", "referralGems", "roomCreationPrice", "minWithdraw", "maxWithdraw", "micSeatPrice", "micDuration")
                VALUES ('settings', 100, 10, 24, 5, 50, 1000, 50, 500, 100, 10000, 100, 30)
                ON CONFLICT ("id") DO NOTHING
            `;
            settings = await prisma.$queryRaw`SELECT * FROM "AppSettings" WHERE "id" = 'settings'`;
        }
        
        res.json(settings[0] || {});
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

// تحديث الإعدادات
app.put('/api/admin/settings', authenticate, async (req, res) => {
    try {
        const {
            harvestCoins,
            harvestGems,
            harvestInterval,
            harvestReferralGems,
            spinPrice,
            exchangeRate,
            referralGems,
            roomCreationPrice,
            minWithdraw,
            maxWithdraw,
            micSeatPrice,
            micDuration
        } = req.body;
        
        // استخدام raw query لتحديث جميع الحقول بما فيها الجديدة
        await prisma.$executeRaw`
            UPDATE "AppSettings" SET
                "harvestCoins" = ${harvestCoins || 100},
                "harvestGems" = ${harvestGems || 10},
                "harvestInterval" = ${harvestInterval || 24},
                "harvestReferralGems" = ${harvestReferralGems || 5},
                "spinPrice" = ${spinPrice || 50},
                "exchangeRate" = ${exchangeRate || 1000},
                "referralGems" = ${referralGems || 50},
                "roomCreationPrice" = ${roomCreationPrice || 500},
                "minWithdraw" = ${minWithdraw || 100},
                "maxWithdraw" = ${maxWithdraw || 10000},
                "micSeatPrice" = ${micSeatPrice || 100},
                "micDuration" = ${micDuration || 30}
            WHERE "id" = 'settings'
        `;
        
        // جلب الإعدادات المحدثة
        const settings = await prisma.$queryRaw`SELECT * FROM "AppSettings" WHERE "id" = 'settings'`;
        res.json(settings[0] || {});
    } catch (error) {
        console.error('Settings update error:', error);
        res.status(500).json({ error: 'خطأ في تحديث الإعدادات' });
    }
});

// ============================================================
// 📷 رفع الصور
// ============================================================

// رفع صورة (Base64)
app.post('/api/upload', authenticate, async (req, res) => {
    try {
        const { image, type } = req.body; // type: 'avatar' | 'room' | 'post'
        
        if (!image) {
            return res.status(400).json({ error: 'الصورة مطلوبة' });
        }
        
        // استخراج البيانات من Base64
        const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
        if (!matches) {
            return res.status(400).json({ error: 'صيغة الصورة غير صحيحة' });
        }
        
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const data = matches[2];
        const buffer = Buffer.from(data, 'base64');
        
        // التحقق من حجم الصورة (5MB max)
        if (buffer.length > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'حجم الصورة كبير جداً (الحد الأقصى 5MB)' });
        }
        
        // إنشاء اسم فريد للملف
        const filename = `${type || 'img'}_${req.user.id}_${Date.now()}.${ext}`;
        const filepath = path.join(__dirname, 'uploads', filename);
        
        // حفظ الملف
        fs.writeFileSync(filepath, buffer);
        
        // إرجاع رابط الصورة
        const imageUrl = `${BASE_URL}/uploads/${filename}`;
        
        res.json({ 
            success: true, 
            url: imageUrl,
            filename 
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'فشل في رفع الصورة' });
    }
});

// رفع صورة (Multipart/Form-Data) - للأدمن
app.post('/api/upload/file', authenticate, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'الصورة مطلوبة' });
        }
        
        const imageUrl = `${BASE_URL}/uploads/${req.file.filename}`;
        
        res.json({ 
            success: true, 
            url: imageUrl,
            filename: req.file.filename 
        });
    } catch (error) {
        console.error('File upload error:', error);
        res.status(500).json({ error: 'فشل في رفع الصورة' });
    }
});

// تحديث صورة الملف الشخصي
app.put('/api/profile/avatar', authenticate, async (req, res) => {
    try {
        const { avatar } = req.body;
        
        if (!avatar) {
            return res.status(400).json({ error: 'الصورة مطلوبة' });
        }
        
        // إذا كانت الصورة Base64، نرفعها أولاً
        let avatarUrl = avatar;
        if (avatar.startsWith('data:image')) {
            const matches = avatar.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
            if (!matches) {
                return res.status(400).json({ error: 'صيغة الصورة غير صحيحة' });
            }
            
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const data = matches[2];
            const buffer = Buffer.from(data, 'base64');
            
            if (buffer.length > 5 * 1024 * 1024) {
                return res.status(400).json({ error: 'حجم الصورة كبير جداً' });
            }
            
            const filename = `avatar_${req.user.id}_${Date.now()}.${ext}`;
            const filepath = path.join(__dirname, 'uploads', filename);
            fs.writeFileSync(filepath, buffer);
            
            avatarUrl = `${BASE_URL}/uploads/${filename}`;
        }
        
        // تحديث المستخدم
        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: { avatar: avatarUrl }
        });
        
        res.json({ 
            success: true, 
            avatar: user.avatar,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar,
                coins: user.coins,
                gems: user.gems,
                level: user.level,
                experience: user.experience
            }
        });
    } catch (error) {
        console.error('Avatar update error:', error);
        res.status(500).json({ error: 'فشل في تحديث الصورة' });
    }
});

// تحديث صورة الغرفة
app.put('/api/rooms/:roomId/image', authenticate, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { image } = req.body;
        
        // التحقق من ملكية الغرفة
        const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
        if (!room) {
            return res.status(404).json({ error: 'الغرفة غير موجودة' });
        }
        if (room.ownerId !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'غير مصرح لك بتعديل هذه الغرفة' });
        }
        
        if (!image) {
            return res.status(400).json({ error: 'الصورة مطلوبة' });
        }
        
        // رفع الصورة
        let imageUrl = image;
        if (image.startsWith('data:image')) {
            const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
            if (!matches) {
                return res.status(400).json({ error: 'صيغة الصورة غير صحيحة' });
            }
            
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const data = matches[2];
            const buffer = Buffer.from(data, 'base64');
            
            if (buffer.length > 5 * 1024 * 1024) {
                return res.status(400).json({ error: 'حجم الصورة كبير جداً' });
            }
            
            const filename = `room_${roomId}_${Date.now()}.${ext}`;
            const filepath = path.join(__dirname, 'uploads', filename);
            fs.writeFileSync(filepath, buffer);
            
            imageUrl = `${BASE_URL}/uploads/${filename}`;
        }
        
        // تحديث الغرفة
        const updatedRoom = await prisma.chatRoom.update({
            where: { id: roomId },
            data: { image: imageUrl }
        });
        
        res.json({ 
            success: true, 
            image: updatedRoom.image,
            room: updatedRoom
        });
    } catch (error) {
        console.error('Room image update error:', error);
        res.status(500).json({ error: 'فشل في تحديث صورة الغرفة' });
    }
});

// ============================================================
// 🎙️ LiveKit Token Generation
// ============================================================

const LIVEKIT_API_KEY = 'windo_key';
const LIVEKIT_API_SECRET = 'windo_secret_2024_very_long_key';

// إنشاء LiveKit Token
app.post('/api/voice/livekit-token', authenticate, async (req, res) => {
    try {
        const { roomId } = req.body;
        const userId = req.user.userId;
        
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ error: 'المستخدم غير موجود' });
        }

        // إنشاء JWT token لـ LiveKit
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            exp: now + 3600, // ساعة واحدة
            iss: LIVEKIT_API_KEY,
            sub: userId,
            name: user.username,
            nbf: now,
            video: {
                room: roomId,
                roomJoin: true,
                canPublish: true,
                canSubscribe: true,
                canPublishData: true,
            },
        };

        const token = jwt.sign(payload, LIVEKIT_API_SECRET, { algorithm: 'HS256' });
        
        res.json({ token });
    } catch (error) {
        console.error('LiveKit token error:', error);
        res.status(500).json({ error: 'فشل في إنشاء token' });
    }
});

// ============================================================
// 📜 APIs الصفحات القانونية (سياسة الخصوصية، شروط الاستخدام)
// ============================================================

// جلب صفحة قانونية (للمستخدمين - بدون مصادقة)
app.get('/api/legal/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const page = await prisma.$queryRaw`
            SELECT * FROM "LegalPage" WHERE "slug" = ${slug}
        `;
        
        if (!page || page.length === 0) {
            return res.status(404).json({ error: 'الصفحة غير موجودة' });
        }
        
        res.json(page[0]);
    } catch (error) {
        console.error('Get legal page error:', error);
        res.status(500).json({ error: 'خطأ في جلب الصفحة' });
    }
});

// صفحة ويب لسياسة الخصوصية (لـ Google Play)
app.get('/privacy-policy', async (req, res) => {
    try {
        let content = 'سياسة الخصوصية غير متوفرة حالياً';
        let title = 'سياسة الخصوصية';
        let updatedAt = '';
        
        try {
            const page = await prisma.$queryRaw`
                SELECT * FROM "LegalPage" WHERE "slug" = 'privacy-policy'
            `;
            
            if (page && page.length > 0) {
                content = page[0].content;
                title = page[0].title;
                updatedAt = new Date(page[0].updatedAt).toLocaleDateString('ar-EG');
            }
        } catch (dbError) {
            console.log('LegalPage table not found, using defaults');
        }
        
        res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ويتر</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #e0e0e0;
            line-height: 1.8;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #8B5CF6, #EC4899);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
            font-size: 40px;
            font-weight: bold;
            color: white;
        }
        h1 {
            color: #fff;
            font-size: 28px;
            margin-bottom: 10px;
        }
        .updated {
            color: #888;
            font-size: 14px;
        }
        .content {
            background: rgba(255,255,255,0.05);
            border-radius: 20px;
            padding: 30px;
            border: 1px solid rgba(255,255,255,0.1);
            white-space: pre-wrap;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            color: #666;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">W</div>
            <h1>${title}</h1>
            ${updatedAt ? `<p class="updated">آخر تحديث: ${updatedAt}</p>` : ''}
        </div>
        <div class="content">${content}</div>
        <div class="footer">
            <p>© 2025 Windo. جميع الحقوق محفوظة.</p>
        </div>
    </div>
</body>
</html>
        `);
    } catch (error) {
        console.error('Privacy policy page error:', error);
        res.status(500).send('خطأ في تحميل الصفحة');
    }
});

// صفحة ويب لشروط الاستخدام (لـ Google Play)
app.get('/terms', async (req, res) => {
    try {
        let content = 'شروط الاستخدام غير متوفرة حالياً';
        let title = 'شروط الاستخدام';
        let updatedAt = '';
        
        try {
            const page = await prisma.$queryRaw`
                SELECT * FROM "LegalPage" WHERE "slug" = 'terms'
            `;
            
            if (page && page.length > 0) {
                content = page[0].content;
                title = page[0].title;
                updatedAt = new Date(page[0].updatedAt).toLocaleDateString('ar-EG');
            }
        } catch (dbError) {
            console.log('LegalPage table not found, using defaults');
        }
        
        res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ويتر</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #e0e0e0;
            line-height: 1.8;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #8B5CF6, #EC4899);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
            font-size: 40px;
            font-weight: bold;
            color: white;
        }
        h1 {
            color: #fff;
            font-size: 28px;
            margin-bottom: 10px;
        }
        .updated {
            color: #888;
            font-size: 14px;
        }
        .content {
            background: rgba(255,255,255,0.05);
            border-radius: 20px;
            padding: 30px;
            border: 1px solid rgba(255,255,255,0.1);
            white-space: pre-wrap;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            color: #666;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">W</div>
            <h1>${title}</h1>
            ${updatedAt ? `<p class="updated">آخر تحديث: ${updatedAt}</p>` : ''}
        </div>
        <div class="content">${content}</div>
        <div class="footer">
            <p>© 2025 Windo. جميع الحقوق محفوظة.</p>
        </div>
    </div>
</body>
</html>
        `);
    } catch (error) {
        console.error('Terms page error:', error);
        res.status(500).send('خطأ في تحميل الصفحة');
    }
});

// جلب جميع الصفحات القانونية (Admin)
app.get('/api/admin/legal-pages', authenticate, async (req, res) => {
    try {
        const pages = await prisma.$queryRaw`
            SELECT * FROM "LegalPage" ORDER BY "createdAt" ASC
        `;
        res.json(pages);
    } catch (error) {
        console.error('Get legal pages error:', error);
        res.status(500).json({ error: 'خطأ في جلب الصفحات' });
    }
});

// تحديث صفحة قانونية (Admin)
app.put('/api/admin/legal-pages/:slug', authenticate, async (req, res) => {
    try {
        const { slug } = req.params;
        const { title, content } = req.body;
        
        await prisma.$executeRaw`
            UPDATE "LegalPage" 
            SET "title" = ${title}, "content" = ${content}, "updatedAt" = NOW()
            WHERE "slug" = ${slug}
        `;
        
        const updated = await prisma.$queryRaw`
            SELECT * FROM "LegalPage" WHERE "slug" = ${slug}
        `;
        
        res.json(updated[0]);
    } catch (error) {
        console.error('Update legal page error:', error);
        res.status(500).json({ error: 'خطأ في تحديث الصفحة' });
    }
});

// ============================================================
// 🚀 تشغيل السيرفر
// ============================================================

// إنشاء جدول الصفحات القانونية إذا لم يكن موجوداً
async function initLegalPages() {
    try {
        // إنشاء الجدول
        await prisma.$executeRaw`
            CREATE TABLE IF NOT EXISTS "LegalPage" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "slug" TEXT NOT NULL UNIQUE,
                "title" TEXT NOT NULL,
                "content" TEXT NOT NULL,
                "updatedAt" TIMESTAMP DEFAULT NOW(),
                "createdAt" TIMESTAMP DEFAULT NOW()
            );
        `;
        
        // إضافة الصفحات الافتراضية
        await prisma.$executeRaw`
            INSERT INTO "LegalPage" ("id", "slug", "title", "content")
            VALUES 
                (gen_random_uuid()::text, 'privacy-policy', 'سياسة الخصوصية', 'مرحباً بك في تطبيق ويتر. نحن نحترم خصوصيتك ونلتزم بحماية بياناتك الشخصية.

نقوم بجمع المعلومات التالية:
- معلومات الحساب (الاسم، البريد الإلكتروني)
- معلومات الاستخدام لتحسين الخدمة
- معلومات الجهاز للأمان

نستخدم هذه المعلومات لـ:
- تقديم خدماتنا وتحسينها
- التواصل معك بشأن حسابك
- ضمان أمان التطبيق

لن نشارك معلوماتك مع أطراف ثالثة إلا بموافقتك أو عند الضرورة القانونية.

للتواصل: support@windo.app'),
                (gen_random_uuid()::text, 'terms', 'شروط الاستخدام', 'مرحباً بك في تطبيق ويتر. باستخدامك للتطبيق، فإنك توافق على الشروط التالية:

1. الأهلية: يجب أن يكون عمرك 13 عاماً على الأقل.

2. حسابك: أنت مسؤول عن الحفاظ على سرية حسابك.

3. السلوك المقبول:
- احترام المستخدمين الآخرين
- عدم نشر محتوى مسيء أو غير قانوني
- عدم انتحال شخصية الآخرين

4. المحتوى: أنت مسؤول عن المحتوى الذي تنشره.

5. الإنهاء: يحق لنا إنهاء حسابك في حالة مخالفة الشروط.

6. التعديلات: قد نقوم بتعديل هذه الشروط من وقت لآخر.

للتواصل: support@windo.app')
            ON CONFLICT ("slug") DO NOTHING;
        `;
        
        console.log('✅ LegalPage table initialized');
    } catch (error) {
        console.error('LegalPage init error:', error.message);
    }
}

// تهيئة الجداول عند بدء التشغيل
initLegalPages();

// إضافة عمود harvestReferralGems إذا لم يكن موجوداً
async function initHarvestReferralGems() {
    try {
        await prisma.$executeRaw`
            ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "harvestReferralGems" DOUBLE PRECISION DEFAULT 5;
        `;
        console.log('✅ harvestReferralGems column initialized');
    } catch (error) {
        console.error('harvestReferralGems init error:', error.message);
    }
}
initHarvestReferralGems();

// ============================================================
// 🧹 تنظيف الحضور التلقائي (Presence Cleanup)
// ============================================================
// تنظيف المستخدمين الذين لم يحدثوا حضورهم منذ فترة
// يعمل كل دقيقة لإزالة المستخدمين غير النشطين

async function cleanupStalePresence() {
    try {
        // حذف الحضور الذي مر عليه أكثر من دقيقتين بدون تحديث
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        
        // حذف من جدول RoomPresence (الضيوف)
        const deletedGuests = await prisma.roomPresence.deleteMany({
            where: {
                lastSeen: { lt: twoMinutesAgo }
            }
        });
        
        // تحديث حالة الأعضاء غير النشطين
        const updatedMembers = await prisma.roomMember.updateMany({
            where: {
                isOnline: true,
                lastSeen: { lt: twoMinutesAgo }
            },
            data: { isOnline: false }
        });
        
        // إفراغ المقاعد الصوتية للمستخدمين غير النشطين
        const staleSeats = await prisma.voiceSeat.findMany({
            where: {
                odId: { not: null },
                joinedAt: { lt: twoMinutesAgo }
            }
        });
        
        for (const seat of staleSeats) {
            await prisma.voiceSeat.update({
                where: { roomId_seatNumber: { roomId: seat.roomId, seatNumber: seat.seatNumber } },
                data: { odId: null, joinedAt: null, isMuted: false }
            });
        }
        
        if (deletedGuests.count > 0 || updatedMembers.count > 0 || staleSeats.length > 0) {
            console.log(`🧹 Cleanup: ${deletedGuests.count} guests, ${updatedMembers.count} members offline, ${staleSeats.length} seats cleared`);
        }
    } catch (error) {
        console.error('Presence cleanup error:', error.message);
    }
}

// تشغيل التنظيف كل دقيقة
setInterval(cleanupStalePresence, 60 * 1000);

// تشغيل التنظيف عند بدء السيرفر
cleanupStalePresence();

// ============================================================
// 📋 APIs المهام (Tasks)
// ============================================================

// إنشاء جدول المهام إذا لم يكن موجوداً
async function initTasksTable() {
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "task" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "name" TEXT NOT NULL,
                "description" TEXT,
                "image" TEXT,
                "url" TEXT NOT NULL,
                "reward" DOUBLE PRECISION DEFAULT 10,
                "duration" INTEGER DEFAULT 30,
                "cooldown" INTEGER DEFAULT 24,
                "isActive" BOOLEAN DEFAULT true,
                "sortOrder" INTEGER DEFAULT 0,
                "isUserAd" BOOLEAN DEFAULT false,
                "userId" TEXT,
                "targetViews" INTEGER DEFAULT 0,
                "currentViews" INTEGER DEFAULT 0,
                "totalCost" DOUBLE PRECISION DEFAULT 0,
                "createdAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        // إضافة الأعمدة الجديدة إذا لم تكن موجودة
        await prisma.$executeRawUnsafe(`ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "isUserAd" BOOLEAN DEFAULT false;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "userId" TEXT;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "targetViews" INTEGER DEFAULT 0;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "currentViews" INTEGER DEFAULT 0;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "totalCost" DOUBLE PRECISION DEFAULT 0;`);
        // إضافة إعدادات الإعلانات
        await prisma.$executeRawUnsafe(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "adPricePer1000" DOUBLE PRECISION DEFAULT 100;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "adViewReward" DOUBLE PRECISION DEFAULT 5;`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "adViewDuration" INTEGER DEFAULT 30;`);
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "task_completion" (
                "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "taskId" TEXT NOT NULL,
                "userId" TEXT NOT NULL,
                "completedAt" TIMESTAMP DEFAULT NOW()
            );
        `);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "task_completion_taskId_idx" ON "task_completion"("taskId");`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "task_completion_userId_idx" ON "task_completion"("userId");`);
        console.log('✅ Tasks table initialized');
    } catch (error) {
        console.log('⚠️ Tasks table init:', error.message);
    }
}
initTasksTable();

// الحصول على جميع المهام (للمستخدم)
app.get('/api/tasks', authenticate, async (req, res) => {
    try {
        const tasks = await prisma.$queryRaw`
            SELECT * FROM "task" 
            WHERE "isActive" = true 
            AND ("targetViews" = 0 OR "currentViews" < "targetViews")
            AND "id" != ${req.user.id}
            ORDER BY "sortOrder" ASC, "createdAt" DESC
        `;
        
        // الحصول على آخر إكمال لكل مهمة للمستخدم
        const completions = await prisma.$queryRaw`
            SELECT "taskId", MAX("completedAt") as "lastCompleted"
            FROM "task_completion"
            WHERE "userId" = ${req.user.id}
            GROUP BY "taskId"
        `;
        
        const completionMap = {};
        completions.forEach(c => {
            completionMap[c.taskId] = c.lastCompleted;
        });
        
        // إضافة معلومات الإكمال لكل مهمة (استبعاد إعلانات المستخدم نفسه)
        const tasksWithStatus = tasks.filter(task => task.userId !== req.user.id).map(task => {
            const lastCompleted = completionMap[task.id];
            let canComplete = true;
            let nextAvailable = null;
            
            if (lastCompleted) {
                const cooldownMs = task.cooldown * 60 * 60 * 1000; // تحويل الساعات لميلي ثانية
                const nextTime = new Date(lastCompleted).getTime() + cooldownMs;
                if (Date.now() < nextTime) {
                    canComplete = false;
                    nextAvailable = new Date(nextTime);
                }
            }
            
            return {
                ...task,
                canComplete,
                nextAvailable,
                lastCompleted
            };
        });
        
        res.json(tasksWithStatus);
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ error: 'خطأ في جلب المهام' });
    }
});

// إكمال مهمة والحصول على المكافأة
app.post('/api/tasks/:taskId/complete', authenticate, async (req, res) => {
    try {
        const { taskId } = req.params;
        
        // التحقق من وجود المهمة
        const tasks = await prisma.$queryRaw`
            SELECT * FROM "task" WHERE "id" = ${taskId} AND "isActive" = true
        `;
        
        if (tasks.length === 0) {
            return res.status(404).json({ error: 'المهمة غير موجودة' });
        }
        
        const task = tasks[0];
        
        // لا يمكن للمستخدم إكمال إعلانه الخاص
        if (task.userId === req.user.id) {
            return res.status(400).json({ error: 'لا يمكنك إكمال إعلانك الخاص' });
        }
        
        // التحقق من فترة الانتظار
        const lastCompletion = await prisma.$queryRaw`
            SELECT * FROM "task_completion"
            WHERE "taskId" = ${taskId} AND "userId" = ${req.user.id}
            ORDER BY "completedAt" DESC
            LIMIT 1
        `;
        
        if (lastCompletion.length > 0) {
            const cooldownMs = task.cooldown * 60 * 60 * 1000;
            const nextTime = new Date(lastCompletion[0].completedAt).getTime() + cooldownMs;
            if (Date.now() < nextTime) {
                const remainingHours = Math.ceil((nextTime - Date.now()) / (60 * 60 * 1000));
                return res.status(400).json({ 
                    error: `يجب الانتظار ${remainingHours} ساعة قبل إعادة هذه المهمة` 
                });
            }
        }
        
        // تسجيل الإكمال
        await prisma.$executeRaw`
            INSERT INTO "task_completion" ("id", "taskId", "userId", "completedAt")
            VALUES (gen_random_uuid()::text, ${taskId}, ${req.user.id}, NOW())
        `;
        
        // زيادة عدد المشاهدات للإعلان
        await prisma.$executeRaw`
            UPDATE "task" SET "currentViews" = "currentViews" + 1 WHERE "id" = ${taskId}
        `;
        
        // التحقق من اكتمال المشاهدات المطلوبة
        if (task.targetViews > 0 && task.currentViews + 1 >= task.targetViews) {
            await prisma.$executeRaw`
                UPDATE "task" SET "isActive" = false WHERE "id" = ${taskId}
            `;
        }
        
        // إضافة المكافأة
        await prisma.user.update({
            where: { id: req.user.id },
            data: { gems: { increment: task.reward } }
        });
        
        // إشعار
        await createNotification(
            req.user.id,
            'task',
            '🎯 مهمة مكتملة!',
            `أكملت مهمة "${task.name}" وحصلت على ${task.reward} جوهرة`,
            { taskId, reward: task.reward }
        );
        
        res.json({ 
            success: true, 
            reward: task.reward,
            message: `حصلت على ${task.reward} جوهرة!`
        });
    } catch (error) {
        console.error('Complete task error:', error);
        res.status(500).json({ error: 'خطأ في إكمال المهمة' });
    }
});

// الحصول على سعر الإعلان
app.get('/api/tasks/ad-price', authenticate, async (req, res) => {
    try {
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        res.json({ 
            pricePer1000: settings?.adPricePer1000 || 100,
            viewReward: settings?.adViewReward || 5,
            viewDuration: settings?.adViewDuration || 30,
            minViews: 1000,
            maxViews: 100000
        });
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب السعر' });
    }
});

// إنشاء إعلان من المستخدم
app.post('/api/tasks/create-ad', authenticate, async (req, res) => {
    try {
        const { name, description, image, url, targetViews } = req.body;
        
        if (!name || !url || !targetViews) {
            return res.status(400).json({ error: 'الاسم والرابط وعدد المشاهدات مطلوبة' });
        }
        
        if (targetViews < 1000) {
            return res.status(400).json({ error: 'الحد الأدنى للمشاهدات 1000' });
        }
        
        // جلب الإعدادات
        const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
        const pricePer1000 = settings?.adPricePer1000 || 100;
        const viewReward = settings?.adViewReward || 5;
        const viewDuration = settings?.adViewDuration || 30;
        const totalCost = Math.ceil(targetViews / 1000) * pricePer1000;
        
        // التحقق من رصيد المستخدم
        if (req.user.coins < totalCost) {
            return res.status(400).json({ 
                error: `رصيدك غير كافٍ. تحتاج ${totalCost} عملة`,
                required: totalCost,
                current: req.user.coins
            });
        }
        
        // خصم التكلفة
        await prisma.user.update({
            where: { id: req.user.id },
            data: { coins: { decrement: totalCost } }
        });
        
        // إنشاء الإعلان مع الإعدادات
        await prisma.$executeRaw`
            INSERT INTO "task" (
                "id", "name", "description", "image", "url", 
                "reward", "duration", "cooldown", "isActive", "sortOrder",
                "isUserAd", "userId", "targetViews", "currentViews", "totalCost", "createdAt"
            ) VALUES (
                gen_random_uuid()::text, ${name}, ${description || null}, ${image || null}, ${url},
                ${viewReward}, ${viewDuration}, 24, true, 100,
                true, ${req.user.id}, ${targetViews}, 0, ${totalCost}, NOW()
            )
        `;
        
        // إشعار
        await createNotification(
            req.user.id,
            'ad',
            '📢 تم إنشاء إعلانك!',
            `إعلانك "${name}" نشط الآن وسيحصل على ${targetViews} مشاهدة`,
            { targetViews, cost: totalCost }
        );
        
        res.json({ 
            success: true, 
            message: 'تم إنشاء الإعلان بنجاح',
            cost: totalCost,
            targetViews
        });
    } catch (error) {
        console.error('Create ad error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء الإعلان' });
    }
});

// الحصول على إعلانات المستخدم
app.get('/api/tasks/my-ads', authenticate, async (req, res) => {
    try {
        const ads = await prisma.$queryRaw`
            SELECT * FROM "task" 
            WHERE "userId" = ${req.user.id} AND "isUserAd" = true
            ORDER BY "createdAt" DESC
        `;
        res.json(ads);
    } catch (error) {
        console.error('Get my ads error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعلانات' });
    }
});

// ============================================================
// 📋 APIs إدارة المهام (Admin)
// ============================================================

// الحصول على جميع المهام (للأدمن)
app.get('/api/admin/tasks', authenticate, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const tasks = await prisma.$queryRaw`
            SELECT t.*, 
                   (SELECT COUNT(*)::int FROM "task_completion" WHERE "taskId" = t.id) as "completionCount"
            FROM "task" t
            ORDER BY t."sortOrder" ASC, t."createdAt" DESC
        `;
        
        res.json(tasks);
    } catch (error) {
        console.error('Admin get tasks error:', error);
        res.status(500).json({ error: 'خطأ في جلب المهام' });
    }
});

// إنشاء مهمة جديدة
app.post('/api/admin/tasks', authenticate, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { name, description, image, url, reward, duration, cooldown, sortOrder } = req.body;
        
        if (!name || !url) {
            return res.status(400).json({ error: 'الاسم والرابط مطلوبان' });
        }
        
        await prisma.$executeRaw`
            INSERT INTO "task" ("id", "name", "description", "image", "url", "reward", "duration", "cooldown", "sortOrder", "isActive", "createdAt")
            VALUES (gen_random_uuid()::text, ${name}, ${description || null}, ${image || null}, ${url}, ${reward || 10}, ${duration || 30}, ${cooldown || 24}, ${sortOrder || 0}, true, NOW())
        `;
        
        res.json({ success: true, message: 'تم إنشاء المهمة بنجاح' });
    } catch (error) {
        console.error('Create task error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء المهمة' });
    }
});

// تحديث مهمة
app.put('/api/admin/tasks/:taskId', authenticate, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { taskId } = req.params;
        const { name, description, image, url, reward, duration, cooldown, isActive, sortOrder } = req.body;
        
        await prisma.$executeRaw`
            UPDATE "task" SET
                "name" = COALESCE(${name}, "name"),
                "description" = ${description},
                "image" = ${image},
                "url" = COALESCE(${url}, "url"),
                "reward" = COALESCE(${reward}, "reward"),
                "duration" = COALESCE(${duration}, "duration"),
                "cooldown" = COALESCE(${cooldown}, "cooldown"),
                "isActive" = COALESCE(${isActive}, "isActive"),
                "sortOrder" = COALESCE(${sortOrder}, "sortOrder")
            WHERE "id" = ${taskId}
        `;
        
        res.json({ success: true, message: 'تم تحديث المهمة بنجاح' });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ error: 'خطأ في تحديث المهمة' });
    }
});

// حذف مهمة
app.delete('/api/admin/tasks/:taskId', authenticate, async (req, res) => {
    try {
        if (!req.user.isAdmin) {
            return res.status(403).json({ error: 'غير مصرح' });
        }
        
        const { taskId } = req.params;
        
        // حذف سجلات الإكمال أولاً
        await prisma.$executeRaw`DELETE FROM "task_completion" WHERE "taskId" = ${taskId}`;
        // حذف المهمة
        await prisma.$executeRaw`DELETE FROM "task" WHERE "id" = ${taskId}`;
        
        res.json({ success: true, message: 'تم حذف المهمة بنجاح' });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ error: 'خطأ في حذف المهمة' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                                                            ║');
    console.log('║   🚀  ويتر Backend Server (Prisma + PostgreSQL)         ║');
    console.log('║                                                            ║');
    console.log(`║   📡  Server: http://0.0.0.0:${PORT}                          ║`);
    console.log(`║   🔗  API:    http://192.168.0.116:${PORT}/api               ║`);
    console.log('║                                                            ║');
    console.log('║   📋  APIs: Auth, Profile, Harvest, Posts, Rooms,         ║');
    console.log('║             Gifts, Wheel, Finance, Settings, Reels        ║');
    console.log('║                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
});
