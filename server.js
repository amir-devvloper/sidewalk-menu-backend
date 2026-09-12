const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

function requiredEnv(name, minLength = 1) {
    const value = String(process.env[name] || "").trim();
    if (value.length < minLength) throw new Error(`Missing/invalid environment variable: ${name}`);
    return value;
}

requiredEnv("SUPABASE_URL");
requiredEnv("SUPABASE_SECRET_KEY", 20);
requiredEnv("JWT_SECRET", 32);
requiredEnv("ADMIN_USERNAME");
requiredEnv("ADMIN_PASSWORD_HASH", 20);

const allowedOrigins = String(process.env.FRONTEND_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

if (allowedOrigins.length === 0) {
    throw new Error("FRONTEND_ORIGINS must contain at least one exact origin.");
}

const isAllowedOrigin = origin => !origin || allowedOrigins.includes(origin);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "geolocation=(self), microphone=(), camera=()",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
    });
    next();
});
app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"]
}));
app.use(express.json({
    limit: "100kb",
    verify(req, res, buffer) {
        if (req.originalUrl?.startsWith("/api/orders/payment/webhook")) {
            req.rawBody = Buffer.from(buffer);
        }
    }
}));

app.get("/", (req, res) => res.json({ success: true, message: "SIDE WALK API Running" }));
app.get("/api/health", (req, res) => res.json({ success: true }));

function createRateLimiter({ windowMs, limit, message }) {
    const buckets = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || req.socket.remoteAddress || "unknown";
        const current = buckets.get(key);
        if (!current || now - current.startedAt >= windowMs) {
            buckets.set(key, { startedAt: now, count: 1 });
            return next();
        }
        current.count += 1;
        if (current.count > limit) {
            const retryAfter = Math.ceil((windowMs - (now - current.startedAt)) / 1000);
            res.set("Retry-After", String(retryAfter));
            return res.status(429).json({ success: false, message });
        }
        next();
    };
}

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, limit: 10,
    message: "تعداد تلاش‌های ورود بیش از حد مجاز است."
});
const orderCreateLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000, limit: 30,
    message: "تعداد درخواست‌های ثبت سفارش بیش از حد مجاز است."
});
const trackingLimiter = createRateLimiter({
    windowMs: 5 * 60 * 1000, limit: 60,
    message: "تعداد درخواست‌های پیگیری بیش از حد مجاز است."
});

const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");

app.use("/api/admin/login", loginLimiter);
app.use("/api/admin", adminRoutes.router);
app.use("/api/products", productRoutes);
app.post("/api/orders", orderCreateLimiter);
app.use("/api/orders", (req, res, next) => {
    // Aban webhooks come from a shared server IP and must not be throttled by
    // the customer tracking limiter; authenticity is enforced by HMAC + verify.
    if (req.path === "/payment/webhook") return next();
    return trackingLimiter(req, res, next);
});
app.use("/api/orders", orderRoutes);

app.use((req, res) => {
    res.status(404).json({ success: false, message: "مسیر پیدا نشد." });
});

app.use((err, req, res, next) => {
    if (err.message === "Origin not allowed by CORS") {
        return res.status(403).json({ success: false, message: "Origin غیرمجاز است." });
    }
    console.error("Unhandled server error:", err.message);
    return res.status(500).json({ success: false, message: "خطای داخلی سرور." });
});

if (require.main === module) {
    const PORT = Number(process.env.PORT || 5000);
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
