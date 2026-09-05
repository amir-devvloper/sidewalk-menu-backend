const express = require("express");
const router = express.Router();

const supabase = require("../supabase");

function makeOrderCode() {
    const time = Date.now().toString().slice(-6);
    const random = Math.floor(100 + Math.random() * 900);

    return `SW-${time}-${random}`;
}

// ثبت سفارش مشتری
router.post("/", async (req, res) => {
    try {
        const {
            customerName,
            tableNumber,
            customerPhone,
            items
        } = req.body;

if (
    !customerName ||
    !Array.isArray(items) ||
    items.length === 0
) {
            return res.status(400).json({
                success: false,
                message: "اطلاعات سفارش کامل نیست."
            });
        }

        const cleanItems = items.map(item => ({
            productId: String(item.productId),
            name: String(item.name),
            price: Number(item.price),
            quantity: Number(item.quantity)
        }));

        if (
            cleanItems.some(
                item =>
                    !item.productId ||
                    !item.name ||
                    !Number.isFinite(item.price) ||
                    item.price < 0 ||
                    !Number.isInteger(item.quantity) ||
                    item.quantity < 1
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "اطلاعات یکی از محصولات سفارش نامعتبر است."
            });
        }

        const total = cleanItems.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
        );

        const { data, error } = await supabase
            .from("orders")
            .insert([
                {
                    order_code: makeOrderCode(),
                    customer_name: String(customerName).trim(),
                    table_number: tableNumber
    ? String(tableNumber).trim()
    : "",
                    customer_phone: customerPhone
                        ? String(customerPhone).trim()
                        : "",
                    items: cleanItems,
                    total
                }
            ])
            .select()
            .single();

        if (error) {
            console.error(error);

            return res.status(500).json({
                success: false,
                message: "خطا در ثبت سفارش."
            });
        }

res.status(201).json({
    success: true,
    message: "سفارش با موفقیت ثبت شد.",
    order: {
        _id: data.id,
        orderCode: data.order_code,
        customerName: data.customer_name,
        tableNumber: data.table_number,
        customerPhone: data.customer_phone,
        items: data.items,
        total: data.total,
        status: data.status,
        createdAt: data.created_at,
        updatedAt: data.updated_at
    }
});

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "خطا در ثبت سفارش."
        });
    }
});

// لیست سفارش‌ها
router.get("/", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("orders")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }

const orders = data.map(order => ({
    _id: order.id,
    orderCode: order.order_code,
    customerName: order.customer_name,
    tableNumber: order.table_number,
    customerPhone: order.customer_phone,
    items: order.items,
    total: order.total,
    status: order.status,
    createdAt: order.created_at,
    updatedAt: order.updated_at
}));

res.json({
    success: true,
    orders
});

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// تغییر وضعیت سفارش
router.put("/:orderCode/status", async (req, res) => {
    try {
        const allowed = [
            "جدید",
            "در حال آماده‌سازی",
            "آماده شد",
            "تحویل شد",
            "لغو شد"
        ];

        if (!allowed.includes(req.body.status)) {
            return res.status(400).json({
                success: false,
                message: "وضعیت نامعتبر است."
            });
        }

        const { data, error } = await supabase
            .from("orders")
            .update({
                status: req.body.status,
                updated_at: new Date().toISOString()
            })
            .eq("order_code", req.params.orderCode)
            .select()
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                message: "سفارش پیدا نشد."
            });
        }

        res.json({
            success: true,
            order: {
    _id: data.id,
    orderCode: data.order_code,
    customerName: data.customer_name,
    tableNumber: data.table_number,
    customerPhone: data.customer_phone,
    items: data.items,
    total: data.total,
    status: data.status,
    createdAt: data.created_at,
    updatedAt: data.updated_at
}
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// حذف سفارش
router.delete("/:orderCode", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("orders")
            .delete()
            .eq("order_code", req.params.orderCode)
            .select();

        if (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "سفارش پیدا نشد."
            });
        }

        res.json({
            success: true,
            message: "سفارش حذف شد."
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;