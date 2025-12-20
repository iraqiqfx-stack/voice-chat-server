import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const email = 'a@a.a';
    const amount = 1000000;

    console.log(`🔍 جاري البحث عن الحساب: ${email}...`);

    try {
        const user = await prisma.user.update({
            where: { email: email },
            data: {
                coins: amount,
                gems: amount
            }
        });

        console.log(`✅ تم شحن الحساب بنجاح!`);
        console.log(`👤 المستخدم: ${user.username}`);
        console.log(`💰 العملات (Coins): ${user.coins}`);
        console.log(`💎 الجواهر (Gems): ${user.gems}`);
    } catch (error) {
        if (error.code === 'P2025') {
            console.error(`❌ الحساب ${email} غير موجود.`);
            
            // محاولة إنشاء الحساب إذا لم يكن موجوداً (اختياري، لكن مفيد للتجارب)
            // console.log('جاري إنشاء الحساب...');
            // ... creation logic
        } else {
            console.error('❌ حدث خطأ:', error);
        }
    } finally {
        await prisma.$disconnect();
    }
}

main();
