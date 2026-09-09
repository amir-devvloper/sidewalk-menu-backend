const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin, requireCsrf } = require("../middleware/auth");

const ORDER_STATUSES = [
    "جدید",
    "در حال آماده‌سازی",
    "آماده شد",
    "تحویل شد",
    "لغو شد"
];
const DELIVERY_METHODS = new Set(["restaurant", "delivery", "pickup"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeOrderCode() {
    return `SW-${crypto.randomInt(10000000, 100000000)}-${crypto.randomInt(1000, 10000)}`;
}

function cleanString(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeDigits(value) {
    return String(value || "")
        .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 1776))
        .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632));
}

function normalizePhone(value) {
    const raw = normalizeDigits(cleanString(value, 30)).replace(/[\s-]/g, "");
    if (/^09\d{9}$/.test(raw)) return raw;
    return "";
}

function mapOrder(order, { publicView = false } = {}) {
    const base = {
        _id: order.id,
        orderCode: order.order_code,
        items: order.items,
        total: order.total,
        status: order.status,
        createdAt: order.created_at,
        updatedAt: order.updated_at
    };

    if (publicView) {
        return {
            orderCode: order.order_code,
            status: order.status,
            createdAt: order.created_at,
            updatedAt: order.updated_at
        };
    }

    return {
        ...base,
        customerName: order.customer_name,
        tableNumber: order.table_number,
        customerPhone: order.customer_phone,
        deliveryMethod: order.delivery_method,
        address: order.address,
        pickupEta: order.pickup_eta
    };
}

function validateOrderBody(body = {}) {
    const customerName = cleanString(body.customerName, 100);
    const customerPhone = normalizePhone(body.customerPhone);
    const tableNumber = cleanString(body.tableNumber, 20);
    const deliveryMethod = cleanString(body.deliveryMethod, 20);
    const address = cleanString(body.address, 1000);
    const pickupEta = cleanString(body.pickupEta, 50);
    const location = body.location && typeof body.location === "object"
        ? { lat: Number(body.location.lat), lng: Number(body.location.lng) }
        : null;
    const items = Array.isArray(body.items) ? body.items : [];

    if (!customerName || !customerPhone || !DELIVERY_METHODS.has(deliveryMethod)) {
        return { error: "اطلاعات سفارش نامعتبر است." };
    }

    if (items.length < 1 || items.length > 50) {
        return { error: "تعداد محصولات سفارش نامعتبر است." };
    }

    if (deliveryMethod === "restaurant" && !tableNumber) {
        return { error: "شماره میز وارد نشده است." };
    }

    if (deliveryMethod === "delivery") {
        if (!address) return { error: "آدرس ارسال وارد نشده است." };

        if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng) ||
            location.lat < -90 || location.lat > 90 || location.lng < -180 || location.lng > 180) {
            return { error: "موقعیت ارسال نامعتبر است." };
        }

        const kermanCenter = { lat: 30.2839, lng: 57.0834 };
        const toRad = value => value * Math.PI / 180;
        const R = 6371;
        const dLat = toRad(location.lat - kermanCenter.lat);
        const dLng = toRad(location.lng - kermanCenter.lng);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(kermanCenter.lat)) * Math.cos(toRad(location.lat)) *
            Math.sin(dLng / 2) ** 2;
        const distanceKm = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (distanceKm > 35) return { error: "این محدوده خارج از منطقه ارسال SIDE WALK است." };
    }

    if (deliveryMethod === "pickup") {
        const eta = Number(pickupEta);
        if (!Number.isFinite(eta) || eta <= 0 || eta > 24 * 60) {
            return { error: "زمان دریافت حضوری نامعتبر است." };
        }
    }

    const quantityByProduct = new Map();
    for (const item of items) {
        const productId = String(item?.productId || "").trim();
        const quantity = Number(item?.quantity);
        if (!UUID_RE.test(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
            return { error: "اطلاعات یکی از محصولات نامعتبر است." };
        }
        quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + quantity);
    }

    const totalQuantity = [...quantityByProduct.values()].reduce((sum, quantity) => sum + quantity, 0);
    if (totalQuantity > 100) {
        return { error: "تعداد کل محصولات سفارش بیش از حد مجاز است." };
    }

    return {
        value: {
            customerName,
            customerPhone,
            tableNumber: deliveryMethod === "restaurant" ? tableNumber : "",
            deliveryMethod,
            address: deliveryMethod === "delivery" ? address : "",
            pickupEta: deliveryMethod === "pickup" ? pickupEta : "",
            quantityByProduct
        }
    };
}

// Customer creates an order. Prices/names come from the database, never the browser.
router.post("/", async (req, res) => {
    try {
        const validation = validateOrderBody(req.body);
        if (validation.error) {
            return res.status(400).json({ success: false, message: validation.error });
        }

        const { quantityByProduct, ...customer } = validation.value;
        const productIds = [...quantityByProduct.keys()];

        const { data: products, error: productError } = await supabase
            .from("products")
            .select("id,name,price,available")
            .in("id", productIds);

        if (productError) {
            console.error("Order product lookup error:", productError.message);
            return res.status(500).json({ success: false, message: "خطا در بررسی محصولات سفارش." });
        }

        if (!products || products.length !== productIds.length) {
            return res.status(400).json({ success: false, message: "یکی از محصولات دیگر وجود ندارد." });
        }

        const productMap = new Map(products.map(product => [product.id, product]));
        const unavailable = products.find(product => product.available === false);
        if (unavailable) {
            return res.status(409).json({
                success: false,
                message: `محصول «${unavailable.name}" در حال حاضر ناموجود است.`
            });
        }

        const cleanItems = productIds.map(productId => {
            const product = productMap.get(productId);
            const quantity = quantityByProduct.get(productId);
            return {
                productId: product.id,
                name: product.name,
                price: Number(product.price),
                quantity
            };
        });

        const total = cleanItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
        if (!Number.isSafeInteger(total) || total < 0 || total > 10000000000) {
            return res.status(400).json({ success: false, message: "مبلغ سفارش نامعتبر است." });
        }

        let data = null;
        let insertError = null;
        for (let attempt = 0; attempt < 3 && !data; attempt += 1) {
            const orderCode = makeOrderCode();
            const result = await supabase
                .from("orders")
                .insert([{
                    order_code: orderCode,
                    customer_name: customer.customerName,
                    table_number: customer.tableNumber,
                    customer_phone: customer.customerPhone,
                    delivery_method: customer.deliveryMethod,
                    address: customer.address,
                    pickup_eta: customer.pickupEta,
                    items: cleanItems,
                    total
                }])
                .select()
                .single();
            data = result.data;
            insertError = result.error;

            if (insertError && insertError.code !== "23505") break;
        }

        if (insertError || !data) {
            console.error("Order insert error:", insertError?.message);
            return res.status(500).json({ success: false, message: "خطا در ثبت سفارش." });
        }

        return res.status(201).json({
            success: true,
            message: "سفارش با موفقیت ثبت شد.",
            order: mapOrder(data)
        });
    } catch (error) {
        console.error("Order create error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در ثبت سفارش." });
    }
});

// Public tracking endpoint. Do not expose customer PII.
router.get("/:orderCode", async (req, res) => {
    try {
        const orderCode = cleanString(req.params.orderCode, 40);
        if (!/^SW-[A-Z0-9]+-[A-Z0-9]+$/i.test(orderCode)) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        const { data, error } = await supabase
            .from("orders")
            .select("id,order_code,items,total,status,created_at,updated_at")
            .eq("order_code", orderCode)
            .maybeSingle();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        return res.json({ success: true, order: mapOrder(data, { publicView: true }) });
    } catch (error) {
        console.error("Order tracking error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت وضعیت سفارش." });
    }
});

// Admin-only routes from this point onward.
router.use(verifyAdmin, requireCsrf);

router.get("/", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("orders")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(500);

        if (error) {
            console.error("Orders list error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در دریافت سفارش‌ها." });
        }

        return res.json({ success: true, orders: data.map(order => mapOrder(order)) });
    } catch (error) {
        console.error("Orders list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت سفارش‌ها." });
    }
});

router.put("/:orderCode/status", async (req, res) => {
    try {
        const orderCode = cleanString(req.params.orderCode, 40);
        const status = cleanString(req.body?.status, 50);
        if (!ORDER_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "وضعیت نامعتبر است." });
        }

        const { data, error } = await supabase
            .from("orders")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("order_code", orderCode)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        return res.json({ success: true, order: mapOrder(data) });
    } catch (error) {
        console.error("Order status update error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در تغییر وضعیت سفارش." });
    }
});

router.delete("/:orderCode", async (req, res) => {
    try {
        const orderCode = cleanString(req.params.orderCode, 40);
        const { data, error } = await supabase
            .from("orders")
            .delete()
            .eq("order_code", orderCode)
            .select("id");

        if (error) {
            console.error("Order delete error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در حذف سفارش." });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        return res.json({ success: true, message: "سفارش حذف شد." });
    } catch (error) {
        console.error("Order delete error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در حذف سفارش." });
    }
});

module.exports = router;
