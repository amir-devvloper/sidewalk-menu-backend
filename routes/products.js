const express = require("express");
const router = express.Router();
const supabase = require("../supabase");

// گرفتن همه محصولات
router.get("/", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("products")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ message: error.message });
        }

        const products = data.map(product => ({
    _id: product.id,
    name: product.name,
    category: product.category,
    description: product.description,
    price: product.price,
    image: product.image,
    available: product.available,
    createdAt: product.created_at,
    updatedAt: product.updated_at
}));

res.json(products);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// اضافه کردن محصول
router.post("/", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("products")
            .insert([req.body])
            .select()
            .single();

        if (error) {
            return res.status(400).json({ message: error.message });
        }

        res.status(201).json(data);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// ویرایش محصول
router.put("/:id", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("products")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) {
            return res.status(400).json({ message: error.message });
        }

        res.json(data);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// حذف محصول
router.delete("/:id", async (req, res) => {
    try {
        const { error } = await supabase
            .from("products")
            .delete()
            .eq("id", req.params.id);

        if (error) {
            return res.status(400).json({ message: error.message });
        }

        res.json({ message: "Product deleted" });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

module.exports = router;