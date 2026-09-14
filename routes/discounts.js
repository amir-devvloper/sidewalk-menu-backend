const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin } = require("../middleware/auth");

const CODE_RE = /^[A-Z0-9_-]{3,30}$/;

function computeStatus(row) {
    if (!row.is_active) return "inactive";

    const now = Date.now();
    const startsAt = new Date(row.starts_at).getTime();
    const expiresAt = new Date(row.expires_at).getTime();

    if (now < startsAt) return "scheduled";
    if (now > expiresAt) return "expired";
    return "active";
}

function mapDiscount(row) {
    return {
        id: row.id,
        code: row.code,
        discountPercent: Number(row.discount_percent),
        minOrderAmount: Number(row.min_order_amount),
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
        isActive: row.is_active,
        status: computeStatus(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

// Validates a discount payload. When `partial` is true (PUT/edit), a field
// that is simply absent from the body is left out of the returned object
// instead of being rejected, so the admin can edit just one field (e.g.
// only push back the expiry date) without resending everything.
function validateDiscountBody(body = {}, { partial = false } = {}) {
    const result = {};

    const hasField = key => Object.prototype.hasOwnProperty.call(body, key);

    if (!partial || hasField("code")) {
        const code = String(body.code || "").trim().toUpperCase();
        if (!CODE_RE.test(code)) {
            return { error: "کد تخفیف باید بین ۳ تا ۳۰ کاراکتر و شامل حروف/عدد انگلیسی، خط تیره یا زیرخط باشد." };
        }
        result.code = code;
    }

    if (!partial || hasField("discountPercent")) {
        const discountPercent = Number(body.discountPercent);
        if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
            return { error: "درصد تخفیف باید عددی بین ۱ تا ۱۰۰ باشد." };
        }
        result.discountPercent = discountPercent;
    }

    if (!partial || hasField("minOrderAmount")) {
        const minOrderAmount = Number(body.minOrderAmount ?? 0);
        if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0 || minOrderAmount > 1000000000) {
            return { error: "حداقل مبلغ سفارش نامعتبر است." };
        }
        result.minOrderAmount = minOrderAmount;
    }

    if (!partial || hasField("startsAt")) {
        const startsAt = new Date(body.startsAt);
        if (Number.isNaN(startsAt.getTime())) {
            return { error: "تاریخ/ساعت شروع نامعتبر است." };
        }
        result.startsAt = startsAt.toISOString();
    }

    if (!partial || hasField("expiresAt")) {
        const expiresAt = new Date(body.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
            return { error: "تاریخ/ساعت پایان نامعتبر است." };
        }
        result.expiresAt = expiresAt.toISOString();
    }

    // Cross-field check only makes sense once both dates are known. On a
    // partial edit where only one of the two was sent, the route handler
    // re-checks this after merging with the existing row.
    if (result.startsAt && result.expiresAt && new Date(result.expiresAt) <= new Date(result.startsAt)) {
        return { error: "تاریخ پایان باید بعد از تاریخ شروع باشد." };
    }

    if (!partial || hasField("isActive")) {
        result.isActive = body.isActive !== false;
    }

    return { value: result };
}

// All discount-code routes are staff-only.
router.use(verifyAdmin);

router.get("/", async (req, res) => {
    const { data, error } = await supabase
        .from("discount_codes")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Discount list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت کدهای تخفیف." });
    }

    return res.json(data.map(mapDiscount));
});

router.post("/", async (req, res) => {
    const validation = validateDiscountBody(req.body, { partial: false });
    if (validation.error) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { code, discountPercent, minOrderAmount, startsAt, expiresAt, isActive } = validation.value;

    const { data, error } = await supabase
        .from("discount_codes")
        .insert([{
            code,
            discount_percent: discountPercent,
            min_order_amount: minOrderAmount,
            starts_at: startsAt,
            expires_at: expiresAt,
            is_active: isActive
        }])
        .select()
        .single();

    if (error) {
        if (error.code === "23505") {
            return res.status(409).json({ success: false, message: "این کد تخفیف از قبل وجود دارد." });
        }
        console.error("Discount create error:", error.message);
        return res.status(500).json({ success: false, message: "ثبت کد تخفیف با خطا مواجه شد." });
    }

    return res.status(201).json(mapDiscount(data));
});

router.put("/:id", async (req, res) => {
    const { id } = req.params;

    const { data: existing, error: fetchError } = await supabase
        .from("discount_codes")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (fetchError) {
        console.error("Discount fetch error:", fetchError.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت کد تخفیف." });
    }
    if (!existing) {
        return res.status(404).json({ success: false, message: "کد تخفیف پیدا نشد." });
    }

    const validation = validateDiscountBody(req.body, { partial: true });
    if (validation.error) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const patch = validation.value;

    // Re-check start/end ordering against whichever of the two dates
    // wasn't part of this particular edit.
    const finalStartsAt = patch.startsAt || existing.starts_at;
    const finalExpiresAt = patch.expiresAt || existing.expires_at;
    if (new Date(finalExpiresAt) <= new Date(finalStartsAt)) {
        return res.status(400).json({ success: false, message: "تاریخ پایان باید بعد از تاریخ شروع باشد." });
    }

    const updatePayload = { updated_at: new Date().toISOString() };
    if ("code" in patch) updatePayload.code = patch.code;
    if ("discountPercent" in patch) updatePayload.discount_percent = patch.discountPercent;
    if ("minOrderAmount" in patch) updatePayload.min_order_amount = patch.minOrderAmount;
    if ("startsAt" in patch) updatePayload.starts_at = patch.startsAt;
    if ("expiresAt" in patch) updatePayload.expires_at = patch.expiresAt;
    if ("isActive" in patch) updatePayload.is_active = patch.isActive;

    const { data, error } = await supabase
        .from("discount_codes")
        .update(updatePayload)
        .eq("id", id)
        .select()
        .single();

    if (error) {
        if (error.code === "23505") {
            return res.status(409).json({ success: false, message: "این کد تخفیف از قبل وجود دارد." });
        }
        console.error("Discount update error:", error.message);
        return res.status(500).json({ success: false, message: "ویرایش کد تخفیف با خطا مواجه شد." });
    }

    return res.json(mapDiscount(data));
});

router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from("discount_codes")
        .delete()
        .eq("id", id)
        .select();

    if (error) {
        console.error("Discount delete error:", error.message);
        return res.status(500).json({ success: false, message: "حذف کد تخفیف با خطا مواجه شد." });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, message: "کد تخفیف پیدا نشد." });
    }

    return res.json({ success: true, message: "کد تخفیف حذف شد." });
});

module.exports = router;
