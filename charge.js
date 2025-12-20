import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function chargeUser() {
    const user = await prisma.user.update({
        where: { email: 'a@a.a' },
        data: {
            coins: 1000000,
            gems: 1000000
        }
    });
    
    console.log('✅ تم شحن الحساب بنجاح!');
    console.log(`👤 المستخدم: ${user.username}`);
    console.log(`💰 العملات: ${user.coins}`);
    console.log(`💎 الجواهر: ${user.gems}`);
}

chargeUser()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
