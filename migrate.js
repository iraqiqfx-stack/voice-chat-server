// سكريبت لإضافة الأعمدة الناقصة في قاعدة البيانات
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function migrate() {
    console.log('🔄 بدء تحديث قاعدة البيانات...');
    
    try {
        // إضافة عمود metadata لجدول ChatMessage
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "metadata" TEXT;
        `);
        console.log('✅ تم إضافة عمود metadata لجدول ChatMessage');
        
        // إضافة عمود replyToId لجدول ChatMessage (للرد على الرسائل)
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;
        `);
        console.log('✅ تم إضافة عمود replyToId لجدول ChatMessage');
        
        // إضافة عمود micSeats لجدول ChatRoom (عدد المايكات)
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "ChatRoom" ADD COLUMN IF NOT EXISTS "micSeats" INTEGER DEFAULT 0;
        `);
        console.log('✅ تم إضافة عمود micSeats لجدول ChatRoom');
        
        // إضافة عمود micSeatPrice لجدول AppSettings (سعر المايك)
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "micSeatPrice" DOUBLE PRECISION DEFAULT 100;
        `);
        console.log('✅ تم إضافة عمود micSeatPrice لجدول AppSettings');
        
        console.log('✅ تم تحديث قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تحديث قاعدة البيانات:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

migrate();
