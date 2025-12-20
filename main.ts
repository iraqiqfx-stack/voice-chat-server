import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

const app = new Application();
const router = new Router();

// Demo data
const users = new Map();

// Auth Routes
router.post("/api/auth/register", async (ctx) => {
    const body = await ctx.request.body().value;
    const id = crypto.randomUUID();
    const user = { id, ...body, coins: 0, gems: 100, referralCode: id.slice(0, 8).toUpperCase(), createdAt: new Date().toISOString() };
    users.set(id, user);
    ctx.response.body = { user, token: "demo-token", refreshToken: "demo-refresh" };
});

router.post("/api/auth/login", async (ctx) => {
    const body = await ctx.request.body().value;
    const user = { id: "1", username: "مستخدم", email: body.email, coins: 1000, gems: 500, referralCode: "ABC123" };
    ctx.response.body = { user, token: "demo-token", refreshToken: "demo-refresh" };
});

// Harvest Routes
router.get("/api/harvest/status", (ctx) => {
    ctx.response.body = { coins: 100, gems: 10, canHarvest: true, packageLevel: 1, packageMultiplier: 1, lastHarvest: "", nextHarvest: "" };
});

router.post("/api/harvest/collect", (ctx) => {
    ctx.response.body = { coins: 100, gems: 10 };
});

// Posts Routes
router.get("/api/posts", (ctx) => {
    ctx.response.body = [
        { id: "1", userId: "1", content: "مرحباً بالجميع! 🎉", likes: 15, comments: [], createdAt: new Date().toISOString(), user: { id: "1", username: "أحمد", coins: 100, gems: 50, referralCode: "ABC123", email: "", createdAt: "" } },
    ];
});

// Rooms Routes
router.get("/api/rooms", (ctx) => {
    ctx.response.body = [
        { id: "1", name: "الغرفة العامة", ownerId: "1", level: 3, usersCount: 42, createdAt: "" },
        { id: "2", name: "غرفة VIP", ownerId: "2", level: 5, usersCount: 15, createdAt: "" },
    ];
});

// Wheel Routes
router.get("/api/wheel/config", (ctx) => {
    ctx.response.body = {
        prizes: [
            { id: "1", name: "100 دينار", value: 100, type: "coins", color: "#FFD700" },
            { id: "2", name: "50 جوهرة", value: 50, type: "gems", color: "#4ECDC4" },
        ],
        spinPrice: 50
    };
});

router.post("/api/wheel/spin", (ctx) => {
    const prize = { id: "1", name: "100 دينار", value: 100, type: "coins", color: "#FFD700" };
    ctx.response.body = { prize, user: { id: "1", coins: 1100, gems: 450 } };
});

// Finance Routes
router.get("/api/agents", (ctx) => {
    ctx.response.body = [
        { id: "1", name: "وكيل 1 - أحمد", status: "online" },
        { id: "2", name: "وكيل 2 - محمد", status: "online" },
    ];
});

router.post("/api/withdraw", async (ctx) => {
    const body = await ctx.request.body().value;
    ctx.response.body = { id: crypto.randomUUID(), ...body, status: "pending", createdAt: new Date().toISOString() };
});

router.get("/api/withdraw/history", (ctx) => {
    ctx.response.body = [{ id: "1", amount: 500, status: "approved", agentId: "1", createdAt: "2024-01-15" }];
});

// Profile Routes
router.get("/api/profile", (ctx) => {
    ctx.response.body = { id: "1", username: "مستخدم", email: "user@example.com", coins: 1000, gems: 500, referralCode: "ABC123" };
});

router.get("/api/profile/team", (ctx) => {
    ctx.response.body = [
        { id: "1", username: "أحمد محمد", coins: 1500, gems: 200, referralCode: "", email: "", createdAt: "2024-01-10" },
        { id: "2", username: "فاطمة علي", coins: 800, gems: 100, referralCode: "", email: "", createdAt: "2024-01-12" },
    ];
});

// Settings
router.get("/api/settings", (ctx) => {
    ctx.response.body = { harvestCoins: 100, harvestGems: 10, spinPrice: 50, exchangeRate: 1000, referralGems: 50, roomCreationPrice: 500 };
});

// CORS & Routes
app.use(oakCors());
app.use(router.routes());
app.use(router.allowedMethods());

console.log("🚀 Server running on http://localhost:8000");
await app.listen({ port: 8000 });
