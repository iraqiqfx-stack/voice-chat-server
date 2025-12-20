import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 بدء إضافة البيانات الأولية...');

    // إنشاء حساب المدير
    const adminPassword = await bcrypt.hash('admin123', 10);
    await prisma.user.upsert({
        where: { email: 'admin@windo.com' },
        update: { isAdmin: true },
        create: {
            username: 'Admin',
            email: 'admin@windo.com',
            password: adminPassword,
            referralCode: 'ADMIN001',
            coins: 1000000,
            gems: 100000,
            level: 100,
            isAdmin: true
        }
    });
    console.log('✅ تم إنشاء حساب المدير');
    console.log('   📧 البريد: admin@windo.com');
    console.log('   🔑 كلمة المرور: admin123');

    // إنشاء الإعدادات
    await prisma.appSettings.upsert({
        where: { id: 'settings' },
        update: {},
        create: {
            id: 'settings',
            harvestCoins: 100,
            harvestGems: 10,
            harvestInterval: 24,
            spinPrice: 50,
            exchangeRate: 1000,
            referralGems: 50,
            roomCreationPrice: 500,
            minWithdraw: 100,
            maxWithdraw: 10000
        }
    });
    console.log('✅ تم إنشاء الإعدادات');

    // إنشاء الهدايا
    // 1. Glowing Heart (القلب المضيء) - Basic
    // 2. Fire Rocket (الصاروخ الناري) - Rare
    // 3. Luxury Yacht (اليخت الفاخر) - Epic
    // 4. Lion King (الأسد الملك) - Legendary
    // 5. Gold Car (السيارة الذهبية) - Ultra Legendary
    
    const gifts = [
        // ========== الهدايا العادية (Basic) - 20 هدية ==========
        { id: 'rose-1', name: 'Rose', nameAr: 'وردة', price: 1, animation: 'basic', color: '#FF6B6B', rarity: 'basic', image: '🌹' },
        { id: 'heart-1', name: 'Heart', nameAr: 'قلب', price: 2, animation: 'basic', color: '#FF69B4', rarity: 'basic', image: '❤️' },
        { id: 'kiss-1', name: 'Kiss', nameAr: 'قبلة', price: 5, animation: 'basic', color: '#FF1493', rarity: 'basic', image: '💋' },
        { id: 'star-1', name: 'Star', nameAr: 'نجمة', price: 8, animation: 'basic', color: '#FFD700', rarity: 'basic', image: '⭐' },
        { id: 'candy-1', name: 'Candy', nameAr: 'حلوى', price: 10, animation: 'basic', color: '#FF69B4', rarity: 'basic', image: '🍬' },
        { id: 'coffee-1', name: 'Coffee', nameAr: 'قهوة', price: 15, animation: 'basic', color: '#8B4513', rarity: 'basic', image: '☕' },
        { id: 'icecream-1', name: 'Ice Cream', nameAr: 'آيس كريم', price: 20, animation: 'basic', color: '#FFB6C1', rarity: 'basic', image: '🍦' },
        { id: 'cake-1', name: 'Cake', nameAr: 'كيك', price: 25, animation: 'basic', color: '#FF69B4', rarity: 'basic', image: '🎂' },
        { id: 'balloon-1', name: 'Balloon', nameAr: 'بالون', price: 30, animation: 'basic', color: '#FF6347', rarity: 'basic', image: '🎈' },
        { id: 'gift-1', name: 'Gift Box', nameAr: 'صندوق هدية', price: 40, animation: 'basic', color: '#FF4500', rarity: 'basic', image: '🎁' },
        { id: 'teddy-1', name: 'Teddy Bear', nameAr: 'دبدوب', price: 50, animation: 'basic', color: '#D2691E', rarity: 'basic', image: '🧸' },
        { id: 'flower-1', name: 'Bouquet', nameAr: 'باقة ورد', price: 60, animation: 'basic', color: '#FF69B4', rarity: 'basic', image: '💐' },
        { id: 'ring-1', name: 'Ring', nameAr: 'خاتم', price: 80, animation: 'basic', color: '#FFD700', rarity: 'basic', image: '💍' },
        { id: 'perfume-1', name: 'Perfume', nameAr: 'عطر', price: 100, animation: 'basic', color: '#DDA0DD', rarity: 'basic', image: '🧴' },
        { id: 'crown-1', name: 'Crown', nameAr: 'تاج', price: 120, animation: 'basic', color: '#FFD700', rarity: 'basic', image: '👑' },
        { id: 'diamond-1', name: 'Diamond', nameAr: 'ألماسة', price: 150, animation: 'basic', color: '#00CED1', rarity: 'basic', image: '💎' },
        { id: 'firework-1', name: 'Firework', nameAr: 'ألعاب نارية', price: 180, animation: 'basic', color: '#FF4500', rarity: 'basic', image: '🎆' },
        { id: 'trophy-1', name: 'Trophy', nameAr: 'كأس', price: 200, animation: 'basic', color: '#FFD700', rarity: 'basic', image: '🏆' },
        { id: 'castle-1', name: 'Castle', nameAr: 'قلعة', price: 250, animation: 'basic', color: '#9370DB', rarity: 'basic', image: '🏰' },
        { id: 'rainbow-1', name: 'Rainbow', nameAr: 'قوس قزح', price: 300, animation: 'basic', color: '#FF69B4', rarity: 'basic', image: '🌈' },
        
        // ========== الهدايا المتوسطة (Rare) - 10 هدايا ==========
        { id: 'heart-basic', name: 'Glowing Heart', nameAr: 'القلب المضيء', price: 500, animation: 'heart-basic', color: '#FF69B4', rarity: 'rare', image: '💖' },
        { id: 'gem-rare', name: 'Magic Gem', nameAr: 'الجوهرة السحرية', price: 800, animation: 'gem-common', color: '#00CED1', rarity: 'rare', image: '💠' },
        { id: 'unicorn-rare', name: 'Unicorn', nameAr: 'يونيكورن', price: 1000, animation: 'heart-basic', color: '#FF69B4', rarity: 'rare', image: '🦄' },
        { id: 'dragon-rare', name: 'Dragon', nameAr: 'تنين', price: 1500, animation: 'heart-basic', color: '#FF4500', rarity: 'rare', image: '🐉' },
        { id: 'phoenix-rare', name: 'Phoenix', nameAr: 'طائر الفينيق', price: 2000, animation: 'heart-basic', color: '#FF6347', rarity: 'rare', image: '🔥' },
        { id: 'rocket-rare', name: 'Fire Rocket', nameAr: 'الصاروخ الناري', price: 2500, animation: 'rocket-rare', color: '#FF4500', rarity: 'rare', image: '🚀' },
        { id: 'plane-rare', name: 'Private Jet', nameAr: 'طائرة خاصة', price: 3000, animation: 'rocket-rare', color: '#4169E1', rarity: 'rare', image: '✈️' },
        { id: 'helicopter-rare', name: 'Helicopter', nameAr: 'هليكوبتر', price: 3500, animation: 'rocket-rare', color: '#32CD32', rarity: 'rare', image: '🚁' },
        { id: 'sports-car-rare', name: 'Sports Car', nameAr: 'سيارة رياضية', price: 4000, animation: 'car-ultra', color: '#FF0000', rarity: 'rare', image: '🚗' },
        { id: 'motorcycle-rare', name: 'Motorcycle', nameAr: 'دراجة نارية', price: 4500, animation: 'car-ultra', color: '#000000', rarity: 'rare', image: '🏍️' },
        
        // ========== الهدايا المميزة (Epic/Legendary/Ultra) - 10 هدايا ==========
        { id: 'yacht-epic', name: 'Luxury Yacht', nameAr: 'اليخت الفاخر', price: 10000, animation: 'yacht-epic', color: '#4169E1', rarity: 'epic', image: '🛥️' },
        { id: 'mansion-epic', name: 'Mansion', nameAr: 'قصر فاخر', price: 15000, animation: 'yacht-epic', color: '#FFD700', rarity: 'epic', image: '🏛️' },
        { id: 'island-epic', name: 'Private Island', nameAr: 'جزيرة خاصة', price: 20000, animation: 'yacht-epic', color: '#00CED1', rarity: 'epic', image: '🏝️' },
        { id: 'spaceship-epic', name: 'Spaceship', nameAr: 'سفينة فضائية', price: 25000, animation: 'rocket-rare', color: '#9370DB', rarity: 'epic', image: '🛸' },
        { id: 'lion-legendary', name: 'Lion King', nameAr: 'الأسد الملك', price: 50000, animation: 'lion-legendary', color: '#FFD700', rarity: 'legendary', image: '🦁' },
        { id: 'tiger-legendary', name: 'Royal Tiger', nameAr: 'النمر الملكي', price: 60000, animation: 'lion-legendary', color: '#FF8C00', rarity: 'legendary', image: '🐅' },
        { id: 'eagle-legendary', name: 'Golden Eagle', nameAr: 'النسر الذهبي', price: 70000, animation: 'lion-legendary', color: '#FFD700', rarity: 'legendary', image: '🦅' },
        { id: 'car-ultra', name: 'Gold Car', nameAr: 'السيارة الذهبية', price: 100000, animation: 'car-ultra', color: '#FFD700', rarity: 'ultra', image: '🏎️' },
        { id: 'palace-ultra', name: 'Royal Palace', nameAr: 'القصر الملكي', price: 150000, animation: 'yacht-epic', color: '#FFD700', rarity: 'ultra', image: '👑' },
        { id: 'world-ultra', name: 'The World', nameAr: 'العالم', price: 200000, animation: 'yacht-epic', color: '#00CED1', rarity: 'ultra', image: '🌍' },
    ];

    for (const gift of gifts) {
        await prisma.gift.upsert({
            where: { id: gift.id },
            update: gift,
            create: gift
        });
    }
    console.log('✅ تم إنشاء الهدايا الجديدة');

    // إنشاء جوائز العجلة
    const prizes = [
        { id: 'prize-1', name: '100 عملة', value: 100, type: 'coins', color: '#FFD700', probability: 30 },
        { id: 'prize-2', name: '500 عملة', value: 500, type: 'coins', color: '#FFA500', probability: 20 },
        { id: 'prize-3', name: '1000 عملة', value: 1000, type: 'coins', color: '#FF6347', probability: 10 },
        { id: 'prize-4', name: '10 جوهرة', value: 10, type: 'gems', color: '#00CED1', probability: 25 },
        { id: 'prize-5', name: '50 جوهرة', value: 50, type: 'gems', color: '#9370DB', probability: 10 },
        { id: 'prize-6', name: '100 جوهرة', value: 100, type: 'gems', color: '#FF69B4', probability: 5 }
    ];

    for (const prize of prizes) {
        await prisma.wheelPrize.upsert({
            where: { id: prize.id },
            update: prize,
            create: prize
        });
    }
    console.log('✅ تم إنشاء جوائز العجلة');

    // إنشاء الوكلاء
    const agents = [
        { id: 'agent-1', name: 'أحمد الوكيل', phone: '+966500000001', status: 'online' },
        { id: 'agent-2', name: 'محمد الصراف', phone: '+966500000002', status: 'online' },
        { id: 'agent-3', name: 'خالد المالي', phone: '+966500000003', status: 'offline' }
    ];

    for (const agent of agents) {
        await prisma.agent.upsert({
            where: { id: agent.id },
            update: agent,
            create: agent
        });
    }
    console.log('✅ تم إنشاء الوكلاء');

    // إنشاء الباقات الجديدة (يمكن شراء نفس الباقة أكثر من مرة)
    const packages = [
        { 
            id: 'pkg-starter', 
            name: 'Starter', 
            nameAr: 'المبتدئ', 
            price: 500, 
            coinsReward: 50, 
            gemsReward: 5, 
            duration: 30, 
            icon: '🌱',
            color: '#10B981',
            features: JSON.stringify(['50 عملة يومياً', '5 جواهر يومياً', 'مدة 30 يوم']) 
        },
        { 
            id: 'pkg-bronze', 
            name: 'Bronze', 
            nameAr: 'البرونزي', 
            price: 1000, 
            coinsReward: 120, 
            gemsReward: 12, 
            duration: 30, 
            icon: '🥉',
            color: '#CD7F32',
            features: JSON.stringify(['120 عملة يومياً', '12 جوهرة يومياً', 'مدة 30 يوم']) 
        },
        { 
            id: 'pkg-silver', 
            name: 'Silver', 
            nameAr: 'الفضي', 
            price: 2500, 
            coinsReward: 300, 
            gemsReward: 30, 
            duration: 30, 
            icon: '🥈',
            color: '#C0C0C0',
            features: JSON.stringify(['300 عملة يومياً', '30 جوهرة يومياً', 'مدة 30 يوم', 'شارة فضية']) 
        },
        { 
            id: 'pkg-gold', 
            name: 'Gold', 
            nameAr: 'الذهبي', 
            price: 5000, 
            coinsReward: 700, 
            gemsReward: 70, 
            duration: 30, 
            icon: '🥇',
            color: '#FFD700',
            features: JSON.stringify(['700 عملة يومياً', '70 جوهرة يومياً', 'مدة 30 يوم', 'شارة ذهبية']) 
        },
        { 
            id: 'pkg-platinum', 
            name: 'Platinum', 
            nameAr: 'البلاتيني', 
            price: 10000, 
            coinsReward: 1500, 
            gemsReward: 150, 
            duration: 30, 
            icon: '💎',
            color: '#E5E4E2',
            features: JSON.stringify(['1500 عملة يومياً', '150 جوهرة يومياً', 'مدة 30 يوم', 'شارة بلاتينية']) 
        },
        { 
            id: 'pkg-diamond', 
            name: 'Diamond', 
            nameAr: 'الماسي', 
            price: 25000, 
            coinsReward: 4000, 
            gemsReward: 400, 
            duration: 30, 
            icon: '👑',
            color: '#B9F2FF',
            features: JSON.stringify(['4000 عملة يومياً', '400 جوهرة يومياً', 'مدة 30 يوم', 'شارة ماسية', 'دعم VIP']) 
        }
    ];

    for (const pkg of packages) {
        await prisma.package.upsert({
            where: { id: pkg.id },
            update: pkg,
            create: pkg
        });
    }
    console.log('✅ تم إنشاء الباقات الجديدة');

    console.log('🎉 تم إضافة جميع البيانات الأولية بنجاح!');
}

main()
    .catch((e) => {
        console.error('❌ خطأ:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
