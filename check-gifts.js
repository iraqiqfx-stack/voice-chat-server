import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
    const gifts = await prisma.gift.findMany();
    console.log('الهدايا الموجودة:');
    gifts.forEach(g => console.log(`  - ${g.id}: ${g.nameAr} (${g.price} عملة)`));
    await prisma.$disconnect();
}

check();
