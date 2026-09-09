const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin } = require("../middleware/auth");

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30m";
const COOKIE_MAX_AGE_MS = 30 * 60 * 1000;


function verifyPassword(password, encoded) {
    return new Promise(resolve => {
        const parts = String(encoded || "").split("$");
        if (parts.length !== 3 || parts[0] !== "scrypt") return resolve(false);
        const salt = parts[1];
        const expectedHex = parts[2];
        if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(expectedHex)) return resolve(false);
        crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
            if (err) return resolve(false);
            const expected = Buffer.from(expectedHex, "hex");
            resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
        });
    });
}

function requireAdminConfig() {
    const required = ["ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "JWT_SECRET"];
    return required.every(name => String(process.env[name] || "").trim());
}

router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    next();
});

router.post("/login", async (req, res) => {
    try {
        if (!requireAdminConfig()) {
            return res.status(500).json({
                success: false,
                message: "تنظیمات ورود مدیر روی سرور کامل نیست."
            });
        }

        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";

        if (!username || !password || username.length > 100 || password.length > 200) {
            return res.status(400).json({
                success: false,
                message: "اطلاعات ورود نامعتبر است."
            });
        }

        const expectedUsername = Buffer.from(String(process.env.ADMIN_USERNAME));
        const suppliedUsername = Buffer.from(username);
        const usernameMatches =
            suppliedUsername.length === expectedUsername.length &&
            crypto.timingSafeEqual(suppliedUsername, expectedUsername);
        const passwordMatches = await verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);

        if (!usernameMatches || !passwordMatches) {
            return res.status(401).json({
                success: false,
                message: "رمز یا نام کاربری اشتباه است"
            });
        }

        const token = jwt.sign(
            {
                role: "admin"
            },
            process.env.JWT_SECRET,
            {
                algorithm: "HS256",
                expiresIn: JWT_EXPIRES_IN,
                issuer: "sidewalk-admin",
                audience: "sidewalk-admin-panel",
                subject: "admin"
            }
        );

        return res.json({
            success: true,
            token,
            expiresIn: JWT_EXPIRES_IN
        });
    } catch (error) {
        console.error("Admin login error:", error.message);
        return res.status(500).json({
            success: false,
            message: "ورود در حال حاضر امکان‌پذیر نیست."
        });
    }
});

router.post("/logout", verifyAdmin, (req, res) => {
    return res.json({ success: true });
});

router.get("/me", verifyAdmin, (req, res) => {
    res.json({
        success: true,
        admin: {
            role: req.admin.role
        }
    });
});

router.use(verifyAdmin);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function parseDateParam(value, fallback) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function bucketKey(date, group) {
    const d = new Date(date);
    if (group === "month") {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    if (group === "week") {
        // ISO-ish week bucket: Saturday-start week to match the local work week.
        const weekStart = new Date(d);
        const dayIndex = (weekStart.getDay() + 1) % 7; // شنبه = 0
        weekStart.setDate(weekStart.getDate() - dayIndex);
        return weekStart.toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 10); // day
}

// Aggregated sales report: totals, averages, a time series bucketed by
// day/week/month, best-selling products, and a breakdown by order type.
router.get("/reports", async (req, res) => {
    try {
        const group = ["day", "week", "month"].includes(req.query.group) ? req.query.group : "day";
        const to = parseDateParam(req.query.to, new Date());
        const from = parseDateParam(
            req.query.from,
            new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
        );

        const { data, error } = await supabase
            .from("orders")
            .select("order_code,items,total,status,delivery_method,created_at")
            .gte("created_at", from.toISOString())
            .lte("created_at", to.toISOString())
            .order("created_at", { ascending: true })
            .limit(5000);

        if (error) {
            console.error("Reports error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در تهیه گزارش." });
        }

        const orders = data || [];
        const activeOrders = orders.filter(order => order.status !== "لغو شد");

        const totalOrders = activeOrders.length;
        const totalSales = activeOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
        const averageOrder = totalOrders ? Math.round(totalSales / totalOrders) : 0;

        const byBucket = new Map();
        for (const order of activeOrders) {
            const key = bucketKey(order.created_at, group);
            const entry = byBucket.get(key) || { bucket: key, orders: 0, sales: 0 };
            entry.orders += 1;
            entry.sales += Number(order.total || 0);
            byBucket.set(key, entry);
        }
        const series = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

        const byDeliveryMethod = { restaurant: 0, delivery: 0, pickup: 0 };
        const byDeliveryMethodSales = { restaurant: 0, delivery: 0, pickup: 0 };
        for (const order of activeOrders) {
            const method = byDeliveryMethod.hasOwnProperty(order.delivery_method) ? order.delivery_method : "restaurant";
            byDeliveryMethod[method] += 1;
            byDeliveryMethodSales[method] += Number(order.total || 0);
        }

        const productStats = new Map();
        for (const order of activeOrders) {
            for (const item of order.items || []) {
                const key = item.productId || item.name;
                const entry = productStats.get(key) || { name: item.name, quantity: 0, revenue: 0 };
                entry.quantity += Number(item.quantity || 0);
                entry.revenue += Number(item.price || 0) * Number(item.quantity || 0);
                productStats.set(key, entry);
            }
        }
        const topProducts = [...productStats.values()]
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, 10);

        const cancelledCount = orders.length - activeOrders.length;

        return res.json({
            success: true,
            report: {
                from: from.toISOString(),
                to: to.toISOString(),
                group,
                totalOrders,
                totalSales,
                averageOrder,
                cancelledCount,
                series,
                byDeliveryMethod,
                byDeliveryMethodSales,
                topProducts
            }
        });
    } catch (error) {
        console.error("Reports error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در تهیه گزارش." });
    }
});

function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

// CSV export of raw orders in range, for spreadsheets. Requires the same
// admin auth as everything else on this router (sent as a normal
// Authorization header, not a bare link, since this is sensitive data).
router.get("/reports/export.csv", async (req, res) => {
    try {
        const to = parseDateParam(req.query.to, new Date());
        const from = parseDateParam(
            req.query.from,
            new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
        );

        const { data, error } = await supabase
            .from("orders")
            .select("order_code,customer_name,customer_phone,table_number,delivery_method,items,total,status,created_at")
            .gte("created_at", from.toISOString())
            .lte("created_at", to.toISOString())
            .order("created_at", { ascending: true })
            .limit(5000);

        if (error) {
            console.error("CSV export error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در خروجی CSV." });
        }

        const header = ["کد سفارش", "تاریخ", "مشتری", "موبایل", "میز", "نوع سفارش", "اقلام", "جمع کل", "وضعیت"];
        const rows = (data || []).map(order => [
            order.order_code,
            order.created_at,
            order.customer_name,
            order.customer_phone,
            order.table_number,
            order.delivery_method,
            (order.items || []).map(item => `${item.name} x${item.quantity}`).join(" | "),
            order.total,
            order.status
        ]);

        const csv = [header, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");

        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="orders-report.csv"`);
        return res.send(`\uFEFF${csv}`); // BOM so Excel opens Persian text correctly.
    } catch (error) {
        console.error("CSV export error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در خروجی CSV." });
    }
});

router.get("/requests", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("requests")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Admin requests list error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در دریافت درخواست‌ها." });
        }

        return res.json({ success: true, requests: data });
    } catch (error) {
        console.error("Admin requests list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت درخواست‌ها." });
    }
});

router.put("/requests/:trackingCode/status", async (req, res) => {
    try {
        const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
        const allowed = ["جدید", "در حال بررسی", "در حال آماده‌سازی", "آماده شد", "تحویل شد", "لغو شد"];
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, message: "وضعیت نامعتبر است." });
        }

        const trackingCode = String(req.params.trackingCode || "").trim();
        if (!trackingCode || trackingCode.length > 100) {
            return res.status(400).json({ success: false, message: "کد پیگیری نامعتبر است." });
        }

        const { data, error } = await supabase
            .from("requests")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("tracking_code", trackingCode)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "درخواست پیدا نشد." });
        }

        return res.json({ success: true, request: data });
    } catch (error) {
        console.error("Request status update error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در تغییر وضعیت درخواست." });
    }
});

router.delete("/requests/:trackingCode", async (req, res) => {
    try {
        const trackingCode = String(req.params.trackingCode || "").trim();
        if (!trackingCode || trackingCode.length > 100) {
            return res.status(400).json({ success: false, message: "کد پیگیری نامعتبر است." });
        }

        const { data, error } = await supabase
            .from("requests")
            .delete()
            .eq("tracking_code", trackingCode)
            .select();

        if (error) {
            console.error("Request delete error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در حذف درخواست." });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, message: "درخواست پیدا نشد." });
        }

        return res.json({ success: true, message: "درخواست حذف شد." });
    } catch (error) {
        console.error("Request delete error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در حذف درخواست." });
    }
});

module.exports = { router };
