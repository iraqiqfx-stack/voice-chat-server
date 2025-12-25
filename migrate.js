// سكريبت لإضافة الأعمدة الناقصة في قاعدة البيانات باستخدام SQL مباشر
const { Client } = require('pg');

async function migrate() {
    console.log('🔄 بدء تحديث قاعدة البيانات...');
    
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    
    try {
        await client.connect();
        console.log('✅ تم الاتصال بقاعدة البيانات');
        
        // إضافة عمود metadata لجدول ChatMessage
        await client.query(`
            ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "metadata" TEXT;
        `);
        console.log('✅ تم إضافة عمود metadata لجدول ChatMessage');
        
        // إضافة عمود replyToId لجدول ChatMessage
        await client.query(`
            ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;
        `);
        console.log('✅ تم إضافة عمود replyToId لجدول ChatMessage');
        
        // إضافة عمود micSeats لجدول ChatRoom
        await client.query(`
            ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micSeats" INTEGER DEFAULT 0;
        `);
        console.log('✅ تم إضافة عمود micSeats لجدول ChatRoom');
        
        // إضافة عمود micSeatPrice لجدول AppSettings
        await client.query(`
            ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micSeatPrice" DOUBLE PRECISION DEFAULT 100;
        `);
        console.log('✅ تم إضافة عمود micSeatPrice لجدول AppSettings');
        
        console.log('✅ تم تحديث قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تحديث قاعدة البيانات:', error.message);
    } finally {
        await client.end();
    }
}

migrate();
