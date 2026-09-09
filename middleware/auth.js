const jwt = require("jsonwebtoken");

function getToken(req) {
    const authHeader = String(req.headers.authorization || "");
    if (!authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7).trim();
    return token || null;
}

function verifyAdmin(req, res, next) {
    const secret = process.env.JWT_SECRET;

    if (!secret || secret.length < 32) {
        return res.status(500).json({
            success: false,
            message: "تنظیمات امنیتی سرور کامل نیست."
        });
    }

    const token = getToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "احراز هویت لازم است."
        });
    }

    try {
        const decoded = jwt.verify(token, secret, {
            algorithms: ["HS256"],
            issuer: "sidewalk-admin",
            audience: "sidewalk-admin-panel"
        });

        if (decoded.role !== "admin" || decoded.sub !== "admin") {
            throw new Error("Invalid admin claims");
        }

        req.admin = decoded;
        next();
    } catch (_) {
        return res.status(401).json({
            success: false,
            message: "نشست نامعتبر یا منقضی شده است."
        });
    }
}

module.exports = { verifyAdmin };
