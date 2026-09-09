const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const COOKIE_NAME = "sw_admin_session";
const CSRF_COOKIE_NAME = "sw_admin_csrf";

function parseCookies(req) {
    const header = String(req.headers.cookie || "");
    const cookies = {};
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}

function getToken(req) {
    const cookies = parseCookies(req);
    const cookieToken = cookies[COOKIE_NAME];
    if (cookieToken) return cookieToken;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
    return null;
}

function verifyAdmin(req, res, next) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
        return res.status(500).json({ success: false, message: "تنظیمات امنیتی سرور کامل نیست." });
    }
    const token = getToken(req);
    if (!token) return res.status(401).json({ success: false, message: "احراز هویت لازم است." });
    try {
        const decoded = jwt.verify(token, secret, {
            algorithms: ["HS256"],
            issuer: "sidewalk-admin",
            audience: "sidewalk-admin-panel"
        });
        if (decoded.role !== "admin" || decoded.sub !== "admin") throw new Error("Invalid admin claims");
        req.admin = decoded;
        next();
    } catch (_) {
        return res.status(401).json({ success: false, message: "نشست نامعتبر یا منقضی شده است." });
    }
}

function requireCsrf(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const cookies = parseCookies(req);
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    const headerToken = req.get("X-CSRF-Token");
    if (!cookieToken || !headerToken) return res.status(403).json({ success: false, message: "درخواست نامعتبر است." });
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ success: false, message: "درخواست نامعتبر است." });
    }
    next();
}

module.exports = { verifyAdmin, requireCsrf, COOKIE_NAME, CSRF_COOKIE_NAME, parseCookies };
