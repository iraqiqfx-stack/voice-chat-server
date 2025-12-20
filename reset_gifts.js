import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log('🗑️ حذف جميع الهدايا القديمة...');
    
    // حذف رسائل الهدايا أولاً (بسبب العلاقة)
    await prisma.giftMessage.deleteMany({});
    console.log('✅ تم حذف رسائل الهدايا');
    
    // حذف جميع الهدايا
    await prisma.gift.deleteMany({});
    console.log('✅ تم حذف جميع الهدايا');
    
    // إعادة إنشاء الهدايا الجديدة
    const gifts = [
        { 
            id: 'heart-basic',
            name: 'Glowing Heart', 
            nameAr: 'القلب المضيء', 
            price: 10, 
            animation: 'heart-basic', 
            color: '#FF69B4', 
            rarity: 'basic',
            image: '❤️',
            imageUrl: 'https://media.giphy.com/media/LpDmM2wSt6kTm/giphy.gif'
        },
        { 
            id: 'rocket-rare',
            name: 'Fire Rocket', 
            nameAr: 'الصاروخ الناري', 
            price: 500, 
            animation: 'rocket-rare', 
            color: '#FF4500', 
            rarity: 'rare',
            image: '🚀',
            imageUrl: 'https://media.giphy.com/media/HjqF2JRhBgwdlQzR7r/giphy.gif'
        },
        { 
            id: 'yacht-epic',
            name: 'Luxury Yacht', 
            nameAr: 'اليخت الفاخر', 
            price: 2000, 
            animation: 'yacht-epic', 
            color: '#4169E1', 
            rarity: 'epic',
            image: '⛵',
            imageUrl: 'https://media.giphy.com/media/3o6Zt6ML68TCu86C2s/giphy.gif'
        },
        { 
            id: 'lion-legendary',
            name: 'Lion King', 
            nameAr: 'الأسد الملك', 
            price: 5000, 
            animation: 'lion-legendary', 
            color: '#FFD700', 
            rarity: 'legendary',
            image: '🦁',
            imageUrl: 'https://media.giphy.com/media/3o7TKR1b2X5g4d1aCc/giphy.gif'
        },
        { 
            id: 'car-ultra',
            name: 'Gold Car', 
            nameAr: 'السيارة الذهبية', 
            price: 10000, 
            animation: 'car-ultra', 
            color: '#FFD700', 
            rarity: 'ultra',
            image: '🚘',
            imageUrl: 'https://media.giphy.com/media/l41lFw057lAJQMlxS/giphy.gif'
        }
    ];
    
    for (const gift of gifts) {
        await prisma.gift.create({ data: gift });
        console.log(`✅ تم إنشاء: ${gift.nameAr}`);
    }
    
    console.log('🎉 تم إعادة إنشاء جميع الهدايا بنجاح!');
    
    // عرض البيانات للتأكد
    const allGifts = await prisma.gift.findMany();
    console.log('\n📦 الهدايا الحالية:');
    allGifts.forEach(g => {
        console.log(`${g.nameAr}: ${g.imageUrl}`);
    });
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
