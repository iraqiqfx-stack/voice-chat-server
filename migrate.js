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
        try {
            await client.query(`ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micSeats" INTEGER DEFAULT 0;`);
            console.log('✅ تم إضافة/التحقق من عمود micSeats لجدول ChatRoom');
        } catch (e) {
            console.log('⚠️ micSeats:', e.message);
        }
        
        // إضافة عمود micSeatPrice لجدول AppSettings
        try {
            await client.query(`ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micSeatPrice" DOUBLE PRECISION DEFAULT 100;`);
            console.log('✅ تم إضافة/التحقق من عمود micSeatPrice لجدول AppSettings');
        } catch (e) {
            console.log('⚠️ micSeatPrice:', e.message);
        }
        
        // إضافة عمود metadata لجدول ChatMessage
        try {
            await client.query(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "metadata" TEXT;`);
            console.log('✅ تم إضافة/التحقق من عمود metadata لجدول ChatMessage');
        } catch (e) {
            console.log('⚠️ metadata:', e.message);
        }
        
        // إضافة عمود replyToId لجدول ChatMessage
        try {
            await client.query(`ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;`);
            console.log('✅ تم إضافة/التحقق من عمود replyToId لجدول ChatMessage');
        } catch (e) {
            console.log('⚠️ replyToId:', e.message);
        }
        
        // التحقق من الأعمدة
        const result = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'ChatRoom' AND column_name = 'micSeats'
        `);
        console.log('📊 التحقق من micSeats:', result.rows.length > 0 ? 'موجود ✅' : 'غير موجود ❌');
        
        const result2 = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'AppSettings' AND column_name = 'micSeatPrice'
        `);
        console.log('📊 التحقق من micSeatPrice:', result2.rows.length > 0 ? 'موجود ✅' : 'غير موجود ❌');
        
        console.log('✅ تم تحديث قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تحديث قاعدة البيانات:', error.message);
        console.error(error);
    } finally {
        await client.end();
    }
}

migrate();
