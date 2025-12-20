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
        
        console.log('✅ تم تحديث قاعدة البيانات بنجاح!');
    } catch (error) {
        console.error('❌ خطأ في تحديث قاعدة البيانات:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

migrate();
