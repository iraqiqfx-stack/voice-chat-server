import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🔄 جاري تحديث البيانات...');

    // تحديث أسعار الهدايا (10 أضعاف)
    await prisma.gift.update({
        where: { id: 'heart-basic' },
        data: { price: 100 }
    });
    await prisma.gift.update({
        where: { id: 'rocket-rare' },
        data: { price: 5000 }
    });
    await prisma.gift.update({
        where: { id: 'yacht-epic' },
        data: { price: 20000 }
    });
    await prisma.gift.update({
        where: { id: 'lion-legendary' },
        data: { price: 50000 }
    });
    await prisma.gift.update({
        where: { id: 'car-ultra' },
        data: { price: 100000 }
    });
    console.log('✅ تم تحديث أسعار الهدايا (10x)');

    // إضافة الرصيد للمستخدم a@a.a
    const user = await prisma.user.findUnique({
        where: { email: 'a@a.a' }
    });

    if (user) {
        const updated = await prisma.user.update({
            where: { email: 'a@a.a' },
            data: { 
                coins: { increment: 100000000 },
                gems: { increment: 100000000 } 
            }
        });
        console.log('✅ تم إضافة الرصيد للمستخدم a@a.a');
        console.log(`   العملات: ${updated.coins.toLocaleString()}`);
        console.log(`   الجواهر: ${updated.gems.toLocaleString()}`);
    } else {
        console.log('❌ المستخدم a@a.a غير موجود');
    }

    console.log('🎉 تم تحديث البيانات بنجاح!');
}

main()
    .catch((e) => {
        console.error('❌ خطأ:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
