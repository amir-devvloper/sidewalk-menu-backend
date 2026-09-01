const express = require("express");
const router = express.Router();
const Order = require("../models/Order");

function makeOrderCode() {
    const time = Date.now().toString().slice(-6);
    const random = Math.floor(100 + Math.random() * 900);
    return `SW-${time}-${random}`;
}

// ثبت سفارش مشتری
router.post("/", async (req, res) => {
    try {
        const { customerName, tableNumber, customerPhone, items } = req.body;

        if (!customerName || !tableNumber || !Array.isArray(items) || items.length === 0) {
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

        if (cleanItems.some(item => !item.productId || !item.name || !Number.isFinite(item.price) || item.price < 0 || !Number.isInteger(item.quantity) || item.quantity < 1)) {
            return res.status(400).json({
                success: false,
                message: "اطلاعات یکی از محصولات سفارش نامعتبر است."
            });
        }

        const total = cleanItems.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
        );

        const order = await Order.create({
            orderCode: makeOrderCode(),
            customerName: String(customerName).trim(),
            tableNumber: String(tableNumber).trim(),
            customerPhone: customerPhone ? String(customerPhone).trim() : "",
            items: cleanItems,
            total
        });

        res.status(201).json({
            success: true,
            message: "سفارش با موفقیت ثبت شد.",
            order
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "خطا در ثبت سفارش."
        });
    }
});

// لیست سفارش‌ها برای پنل کافه
router.get("/", async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// تغییر وضعیت سفارش
router.put("/:orderCode/status", async (req, res) => {
    try {
        const allowed = ["جدید", "در حال آماده‌سازی", "آماده شد", "تحویل شد", "لغو شد"];

        if (!allowed.includes(req.body.status)) {
            return res.status(400).json({ success: false, message: "وضعیت نامعتبر است." });
        }

        const order = await Order.findOneAndUpdate(
            { orderCode: req.params.orderCode },
            { status: req.body.status },
            { new: true }
        );

        if (!order) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        res.json({ success: true, order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// حذف سفارش
router.delete("/:orderCode", async (req, res) => {
    try {
        const deleted = await Order.findOneAndDelete({ orderCode: req.params.orderCode });

        if (!deleted) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        res.json({ success: true, message: "سفارش حذف شد." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
