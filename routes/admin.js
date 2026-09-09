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
