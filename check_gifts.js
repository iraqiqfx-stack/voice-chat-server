import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const gifts = await prisma.gift.findMany();
    console.log('📦 الهدايا الموجودة في قاعدة البيانات:');
    gifts.forEach(g => {
        console.log(`- ${g.name} (${g.id}):`);
        console.log(`  📸 ImageUrl: ${g.imageUrl ? g.imageUrl.substring(0, 50) + '...' : 'NULL'}`);
    });
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
