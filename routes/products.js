const express = require("express");
const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin, requireCsrf } = require("../middleware/auth");

const ALLOWED_CATEGORIES = new Set(["coffee", "drink", "food", "burger", "pizza", "dessert"]);
const MAX_NAME = 120;
const MAX_DESCRIPTION = 1000;
const MAX_IMAGE = 1000;

function sanitizeProductInput(body = {}) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const image = typeof body.image === "string" ? body.image.trim() : "";
    const price = Number(body.price);
    const available = body.available !== false;

    if (!name || name.length > MAX_NAME) throw new Error("نام محصول نامعتبر است.");
    if (!ALLOWED_CATEGORIES.has(category)) throw new Error("دسته‌بندی محصول نامعتبر است.");
    if (description.length > MAX_DESCRIPTION) throw new Error("توضیحات محصول بیش از حد طولانی است.");
    if (image.length > MAX_IMAGE) throw new Error("مسیر تصویر محصول بیش از حد طولانی است.");
    if (image && !(image.startsWith("assest/") || image.startsWith("/assest/") || /^https:\/\//i.test(image))) {
        throw new Error("مسیر تصویر محصول باید یک مسیر محلی یا HTTPS باشد.");
    }
    if (!Number.isSafeInteger(price) || price < 0 || price > 1000000000) {
        throw new Error("قیمت محصول نامعتبر است.");
    }

    return { name, category, description, price, image, available };
}

function mapProduct(product) {
    return {
        _id: product.id,
        name: product.name,
        category: product.category,
        description: product.description,
        price: product.price,
        image: product.image,
        available: product.available,
        createdAt: product.created_at,
        updatedAt: product.updated_at
    };
}

// Public menu endpoint.
router.get("/", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("products")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Products list error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در دریافت منو." });
        }

        return res.json(data.map(mapProduct));
    } catch (error) {
        console.error("Products list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت منو." });
    }
});

// Everything below this point is admin-only.
router.use(verifyAdmin, requireCsrf);

router.post("/", async (req, res) => {
    try {
        const product = sanitizeProductInput(req.body);
        const { data, error } = await supabase
            .from("products")
            .insert([product])
            .select()
            .single();

        if (error) {
            console.error("Product create error:", error.message);
            return res.status(400).json({ success: false, message: "افزودن محصول ناموفق بود." });
        }

        return res.status(201).json(mapProduct(data));
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.put("/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();
        if (!/^[0-9a-f-]{20,}$/i.test(id)) {
            return res.status(400).json({ success: false, message: "شناسه محصول نامعتبر است." });
        }

        const product = sanitizeProductInput(req.body);
        const { data, error } = await supabase
            .from("products")
            .update(product)
            .eq("id", id)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "محصول پیدا نشد." });
        }

        return res.json(mapProduct(data));
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();
        if (!/^[0-9a-f-]{20,}$/i.test(id)) {
            return res.status(400).json({ success: false, message: "شناسه محصول نامعتبر است." });
        }

        const { data, error } = await supabase
            .from("products")
            .delete()
            .eq("id", id)
            .select("id");

        if (error) {
            console.error("Product delete error:", error.message);
            return res.status(500).json({ success: false, message: "حذف محصول ناموفق بود." });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, message: "محصول پیدا نشد." });
        }

        return res.json({ success: true, message: "محصول حذف شد." });
    } catch (error) {
        return res.status(500).json({ success: false, message: "حذف محصول ناموفق بود." });
    }
});

module.exports = router;
