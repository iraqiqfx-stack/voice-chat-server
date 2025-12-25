// سكريبت لإضافة الأعمدة الناقصة في قاعدة البيانات باستخدام SQL مباشر
import pg from 'pg';
const { Client } = pg;

async function migrate() {
    console.log('🔄 بدء تحديث قاعدة البيانات...');
    
    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL غير موجود!');
        process.exit(1);
    }
    
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    
    try {
        await client.connect();
        console.log('✅ تم الاتصال بقاعدة البيانات');
        
        // إضافة عمود micSeats لجدول ChatRoom
        await client.query(`ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micSeats" INTEGER DEFAULT 0;`);
        console.log('✅ micSeats');
        
        // إضافة عمود micExpiresAt لجدول ChatRoom
        await client.query(`ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micExpiresAt" TIMESTAMP;`);
        console.log('✅ micExpiresAt');
        
        // إضافة عمود micSeatPrice لجدول AppSettings
        await client.query(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micSeatPrice" DOUBLE PRECISION DEFAULT 100;`);
        console.log('✅ micSeatPrice');
        
        // إضافة عمود micDuration لجدول AppSettings
        await client.query(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micDuration" INTEGER DEFAULT 30;`);
        console.log('✅ micDuration');
        
        // إضافة حقول الوكلاء الجديدة
        await client.query(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT;`);
        await client.query(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "telegram" TEXT;`);
        await client.query(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "address" TEXT;`);
        console.log('✅ Agent fields (whatsapp, telegram, address)');
        
        // إضافة عمود metadata لجدول ChatMessage
        await client.query(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "metadata" TEXT;`);
        console.log('✅ metadata');
        
        // إضافة عمود replyToId لجدول ChatMessage
        await client.query(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;`);
        console.log('✅ replyToId');
        
        // إنشاء جدول PaymentMethod إذا لم يكن موجوداً
        await client.query(`
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
        console.log('✅ PaymentMethod table');
        
        // إضافة أعمدة السحب الجديدة
        await client.query(`ALTER TABLE "WithdrawRequest" ADD COLUMN IF NOT EXISTS "paymentMethodId" TEXT;`);
        await client.query(`ALTER TABLE "WithdrawRequest" ADD COLUMN IF NOT EXISTS "accountNumber" TEXT;`);
        console.log('✅ WithdrawRequest fields (paymentMethodId, accountNumber)');
        
        console.log('✅ تم تحديث قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تحديث قاعدة البيانات:', error.message);
    } finally {
        await client.end();
    }
}

migrate();
