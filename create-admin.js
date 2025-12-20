import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createAdmin() {
    console.log('🔐 إنشاء حساب المدير...');
    
    const adminPassword = await bcrypt.hash('admin123', 10);
    
    try {
        // إنشاء أو تحديث المستخدم
        const admin = await prisma.user.upsert({
            where: { email: 'admin@windo.com' },
            update: { password: adminPassword },
            create: {
                username: 'Admin',
                email: 'admin@windo.com',
                password: adminPassword,
                referralCode: 'ADMIN001',
                coins: 1000000,
                gems: 100000,
                level: 100
            }
        });
        
        // تحديث isAdmin باستخدام raw query
        await prisma.$executeRaw`UPDATE User SET isAdmin = 1 WHERE email = 'admin@windo.com'`;
        
        console.log('✅ تم إنشاء/تحديث حساب المدير بنجاح!');
        console.log('');
        console.log('╔════════════════════════════════════════╗');
        console.log('║     بيانات الدخول للوحة التحكم        ║');
        console.log('╠════════════════════════════════════════╣');
        console.log('║  📧 البريد: admin@windo.com           ║');
        console.log('║  🔑 كلمة المرور: admin123             ║');
        console.log('╚════════════════════════════════════════╝');
        console.log('');
        console.log('🌐 رابط لوحة التحكم: http://localhost:5173');
        
    } catch (error) {
        console.error('❌ خطأ:', error);
    } finally {
        await prisma.$disconnect();
    }
}

createAdmin();
