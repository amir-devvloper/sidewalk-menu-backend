const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin } = require("../middleware/auth");

const ABAN_API_BASE = String(process.env.ABAN_API_BASE || "https://api.abangateway.ir/api/v1")
    .trim()
    .replace(/\/+$/, "");
const ABAN_API_TOKEN = String(process.env.ABAN_API_TOKEN || "").trim();
const ABAN_WEBHOOK_SECRET = String(process.env.ABAN_WEBHOOK_SECRET || "").trim();
const BACKEND_PUBLIC_URL = String(process.env.BACKEND_PUBLIC_URL || "https://sidewalk-menu-backend.onrender.com").trim().replace(/\/$/, "");
const ABAN_CALLBACK_URL = String(process.env.ABAN_CALLBACK_URL || `${BACKEND_PUBLIC_URL}/api/orders/payment/webhook`).trim();
const ABAN_REQUEST_TIMEOUT_MS = Math.min(Math.max(Number(process.env.ABAN_REQUEST_TIMEOUT_MS || 12000), 3000), 30000);

function getAbanErrorCode(payload) {
    return cleanString(payload?.error?.code || payload?.code, 100);
}

function getAbanErrorMessage(payload, status) {
    const message = payload?.error?.message || payload?.message || payload?.error;
    return cleanString(message, 500) || `Aban Gateway HTTP ${status}`;
}

async function abanRequest(path, options = {}) {
    if (!ABAN_API_TOKEN) {
        const error = new Error("ABAN_API_TOKEN در تنظیمات سرور وجود ندارد.");
        error.status = 503;
        error.code = "aban_token_missing";
        throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ABAN_REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(`${ABAN_API_BASE}${path}`, {
            ...options,
            signal: options.signal || controller.signal,
            headers: {
                Authorization: `Bearer ${ABAN_API_TOKEN}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });
    } catch (cause) {
        const error = new Error(cause?.name === "AbortError"
            ? "پاسخ آبان گیت‌وی بیش از حد طول کشید."
            : "ارتباط سرور با آبان گیت‌وی برقرار نشد.");
        error.status = 502;
        error.code = cause?.name === "AbortError" ? "aban_timeout" : "aban_network_error";
        error.cause = cause;
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text.slice(0, 1000) }; }

    if (!response.ok) {
        const error = new Error(getAbanErrorMessage(payload, response.status));
        error.status = response.status;
        error.code = getAbanErrorCode(payload) || "aban_http_error";
        error.payload = payload;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
        throw error;
    }

    return payload;
}

async function createAbanInvoice({ orderCode, totalToman }) {
    const amountRial = Math.round(Number(totalToman) * 10);
    if (!Number.isSafeInteger(amountRial) || amountRial <= 0) {
        throw new Error("مبلغ سفارش برای درگاه معتبر نیست.");
    }

    return abanRequest("/invoices", {
        method: "POST",
        body: JSON.stringify({
            amount_rial: amountRial,
            order_id: orderCode,
            callback_url: ABAN_CALLBACK_URL,
            description: `پرداخت سفارش SideWalk ${orderCode}`,
            metadata: { order_code: orderCode }
        })
    });
}

async function getAbanInvoice(invoiceId) {
    return abanRequest(`/invoices/${encodeURIComponent(invoiceId)}`, { method: "GET" });
}

async function verifyAbanInvoice(invoiceId) {
    return abanRequest(`/invoices/${encodeURIComponent(invoiceId)}/verify`, {
        method: "POST",
        body: JSON.stringify({})
    });
}

function unwrapAbanInvoice(payload) {
    if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
        return payload.data;
    }
    return payload || {};
}

function isAlreadyVerified(error) {
    return error?.status === 409 && (error?.code === "already_verified" || getAbanErrorCode(error?.payload) === "already_verified");
}

function expectedOrderAmountRial(order) {
    const amount = Math.round(Number(order?.total) * 10);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function assertVerifiedInvoiceMatchesOrder(result, order, invoiceId) {
    const payload = unwrapAbanInvoice(result);
    if (payload.invoice_id && String(payload.invoice_id) !== String(invoiceId)) {
        throw new Error("شناسه فاکتور تأییدشده با سفارش مطابقت ندارد.");
    }
    if (payload.order_id && String(payload.order_id) !== String(order.order_code)) {
        throw new Error("شناسه سفارش آبان با سفارش ثبت‌شده مطابقت ندارد.");
    }
    const expected = expectedOrderAmountRial(order);
    if (expected && payload.amount_rial != null && Number(payload.amount_rial) !== expected) {
        throw new Error("مبلغ تأییدشده آبان با مبلغ سفارش مطابقت ندارد.");
    }
    return payload;
}

async function verifyAbanInvoiceForOrder(order, invoiceId) {
    try {
        const result = await verifyAbanInvoice(invoiceId);
        return assertVerifiedInvoiceMatchesOrder(result, order, invoiceId);
    } catch (error) {
        if (!isAlreadyVerified(error)) throw error;
        const status = await getAbanInvoice(invoiceId);
        const payload = assertVerifiedInvoiceMatchesOrder(status, order, invoiceId);
        if (payload.status !== "paid") {
            const mismatch = new Error("فاکتور قبلاً verify شده اما وضعیت آن paid نیست.");
            mismatch.status = 409;
            mismatch.code = "aban_status_mismatch";
            throw mismatch;
        }
        return { ...payload, verified: true, already_verified: true };
    }
}

// More granular pipeline: جدید -> در حال آماده‌سازی -> آماده شد ->
// (در حال ارسال فقط برای پیک) -> تحویل شد, یا لغو شد در هر مرحله.
const ORDER_STATUSES = [
    "جدید",
    "در حال آماده‌سازی",
    "آماده شد",
    "در حال ارسال",
    "تحویل شد",
    "لغو شد"
];
// Statuses the customer is still allowed to self-cancel from, and the
// time window (ms) after order creation during which cancellation is allowed.
const CUSTOMER_CANCELLABLE_STATUSES = new Set(["جدید"]);
const CUSTOMER_CANCEL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
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
        updatedAt: order.updated_at,
        paymentStatus: order.payment_status || "unpaid"
    };

    if (publicView) {
        return {
            orderCode: order.order_code,
            status: order.status,
            deliveryMethod: order.delivery_method,
            createdAt: order.created_at,
            updatedAt: order.updated_at,
            paymentStatus: order.payment_status || "unpaid"
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

// Looks up products for a quantityByProduct map, checks availability, and
// returns priced order items + total. Shared by the public checkout and
// the admin manual-order endpoint so prices always come from the database.
async function resolveOrderItems(quantityByProduct) {
    const productIds = [...quantityByProduct.keys()];

    const { data: products, error: productError } = await supabase
        .from("products")
        .select("id,name,price,available,sold_out_date")
        .in("id", productIds);

    if (productError) {
        console.error("Order product lookup error:", productError.message);
        return { error: "خطا در بررسی محصولات سفارش.", status: 500 };
    }

    if (!products || products.length !== productIds.length) {
        return { error: "یکی از محصولات دیگر وجود ندارد.", status: 400 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const productMap = new Map(products.map(product => [product.id, product]));
    const unavailable = products.find(
        product => product.available === false || product.sold_out_date === today
    );
    if (unavailable) {
        return {
            error: `محصول «${unavailable.name}» در حال حاضر ناموجود است.`,
            status: 409
        };
    }

    const items = productIds.map(productId => {
        const product = productMap.get(productId);
        const quantity = quantityByProduct.get(productId);
        return {
            productId: product.id,
            name: product.name,
            price: Number(product.price),
            quantity
        };
    });

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > 10000000000) {
        return { error: "مبلغ سفارش نامعتبر است.", status: 400 };
    }

    return { items, total };
}

async function insertOrder({ customerName, tableNumber, customerPhone, deliveryMethod, address, pickupEta, items, total }) {
    let data = null;
    let insertError = null;
    for (let attempt = 0; attempt < 3 && !data; attempt += 1) {
        const orderCode = makeOrderCode();
        const result = await supabase
            .from("orders")
            .insert([{
                order_code: orderCode,
                customer_name: customerName,
                table_number: tableNumber,
                customer_phone: customerPhone,
                delivery_method: deliveryMethod,
                address,
                pickup_eta: pickupEta,
                items,
                total
            }])
            .select()
            .single();
        data = result.data;
        insertError = result.error;

        if (insertError && insertError.code !== "23505") break;
    }

    return { data, insertError };
}

// Customer creates an order. Prices/names come from the database, never the browser.
router.post("/", async (req, res) => {
    try {
        const validation = validateOrderBody(req.body);
        if (validation.error) {
            return res.status(400).json({ success: false, message: validation.error });
        }

        if (!ABAN_API_TOKEN) {
            return res.status(503).json({
                success: false,
                message: "درگاه Aban روی سرور تنظیم نشده است. ABAN_API_TOKEN را در Render اضافه کنید."
            });
        }

        const { quantityByProduct, ...customer } = validation.value;
        const resolved = await resolveOrderItems(quantityByProduct);
        if (resolved.error) {
            return res.status(resolved.status).json({ success: false, message: resolved.error });
        }

        const { data, insertError } = await insertOrder({
            ...customer,
            items: resolved.items,
            total: resolved.total
        });

        if (insertError || !data) {
            console.error("Order insert error:", insertError?.message);
            return res.status(500).json({ success: false, message: "خطا در ثبت سفارش." });
        }

        const orderCode = data.order_code;

        try {
            const invoiceResponse = await createAbanInvoice({
                orderCode,
                totalToman: resolved.total
            });
            const invoice = unwrapAbanInvoice(invoiceResponse);

            const invoiceId = invoice?.invoice_id || invoice?.id;
            const paymentUrl = invoice?.payment_url || invoice?.paymentUrl;

            if (!invoiceId || !paymentUrl) {
                console.error("Aban invoice response missing fields:", {
                    hasInvoiceId: Boolean(invoiceId),
                    hasPaymentUrl: Boolean(paymentUrl),
                    keys: Object.keys(invoice || {})
                });
                const error = new Error("آبان گیت‌وی فاکتور ساخت اما لینک پرداخت معتبر برنگرداند.");
                error.code = "aban_payment_url_missing";
                throw error;
            }

            let parsedPaymentUrl;
            try { parsedPaymentUrl = new URL(String(paymentUrl)); } catch (_) { parsedPaymentUrl = null; }
            if (!parsedPaymentUrl || parsedPaymentUrl.protocol !== "https:" || !/(^|\.)abangateway\.ir$/i.test(parsedPaymentUrl.hostname)) {
                const error = new Error("لینک پرداخت برگشتی آبان معتبر نیست.");
                error.code = "aban_payment_url_invalid";
                throw error;
            }

            const { data: updatedOrder, error: updateError } = await supabase
                .from("orders")
                .update({
                    payment_status: "pending",
                    payment_invoice_id: String(invoiceId),
                    payment_url: String(paymentUrl)
                })
                .eq("order_code", orderCode)
                .select()
                .single();

            if (updateError || !updatedOrder) {
                console.error("Payment data save error:", updateError?.message);
                throw new Error("اطلاعات پرداخت سفارش در دیتابیس ذخیره نشد.");
            }

            return res.status(201).json({
                success: true,
                message: "سفارش ثبت شد و آماده پرداخت است.",
                order: mapOrder(updatedOrder),
                payment: {
                    invoiceId: String(invoiceId),
                    paymentUrl: String(paymentUrl),
                    payableToman: invoice?.payable_toman ?? null,
                    payableRial: invoice?.payable_rial ?? null
                }
            });
        } catch (paymentError) {
            console.error("Aban invoice error:", paymentError.message, paymentError.payload || "");
            await supabase.from("orders").delete().eq("order_code", orderCode);
            const status = [401, 402, 403, 409, 410, 422, 429, 503].includes(paymentError.status)
                ? paymentError.status
                : 502;
            return res.status(status).json({
                success: false,
                code: paymentError.code || "aban_invoice_failed",
                message: paymentError.message || "ایجاد فاکتور پرداخت ناموفق بود.",
                retryAfter: paymentError.retryAfter ?? null
            });
        }
    } catch (error) {
        console.error("Order create error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در ثبت سفارش." });
    }
});

// Public order-history endpoint for a returning customer. Scoped strictly
// to their own phone number — this is the same identifier they already
// typed in at checkout, never another customer's data.
router.get("/history/:phone", async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);
        if (!phone) {
            return res.status(400).json({ success: false, message: "شماره موبایل نامعتبر است." });
        }

        const { data, error } = await supabase
            .from("orders")
            .select("id,order_code,items,total,status,delivery_method,table_number,created_at,updated_at")
            .eq("customer_phone", phone)
            .order("created_at", { ascending: false })
            .limit(20);

        if (error) {
            console.error("Order history error:", error.message);
            return res.status(500).json({ success: false, message: "خطا در دریافت تاریخچه سفارش‌ها." });
        }

        return res.json({ success: true, orders: (data || []).map(order => mapOrder(order)) });
    } catch (error) {
        console.error("Order history error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت تاریخچه سفارش‌ها." });
    }
});

// Customer self-cancel, only while the order is still new and inside the
// cancellation window. Requires the same phone number used at checkout so
// a stranger who only knows the order code can't cancel someone's order.
router.post("/:orderCode/cancel", async (req, res) => {
    try {
        const orderCode = cleanString(req.params.orderCode, 40);
        const phone = normalizePhone(req.body?.customerPhone);

        if (!/^SW-[A-Z0-9]+-[A-Z0-9]+$/i.test(orderCode) || !phone) {
            return res.status(400).json({ success: false, message: "درخواست نامعتبر است." });
        }

        const { data: existing, error: fetchError } = await supabase
            .from("orders")
            .select("id,order_code,status,customer_phone,created_at")
            .eq("order_code", orderCode)
            .maybeSingle();

        if (fetchError || !existing) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        if (existing.customer_phone !== phone) {
            return res.status(403).json({ success: false, message: "شماره موبایل با سفارش مطابقت ندارد." });
        }

        if (!CUSTOMER_CANCELLABLE_STATUSES.has(existing.status)) {
            return res.status(409).json({ success: false, message: "این سفارش دیگر قابل لغو نیست، آماده‌سازی آن شروع شده است." });
        }

        const ageMs = Date.now() - new Date(existing.created_at).getTime();
        if (!Number.isFinite(ageMs) || ageMs > CUSTOMER_CANCEL_WINDOW_MS) {
            return res.status(409).json({ success: false, message: "زمان مجاز برای لغو سفارش به پایان رسیده است." });
        }

        const { data, error } = await supabase
            .from("orders")
            .update({ status: "لغو شد", updated_at: new Date().toISOString() })
            .eq("order_code", orderCode)
            .select()
            .single();

        if (error || !data) {
            return res.status(500).json({ success: false, message: "لغو سفارش انجام نشد." });
        }

        return res.json({ success: true, message: "سفارش با موفقیت لغو شد.", order: mapOrder(data, { publicView: true }) });
    } catch (error) {
        console.error("Order cancel error:", error.message);
        return res.status(500).json({ success: false, message: "لغو سفارش انجام نشد." });
    }
});

// Aban sends signed payment events to this server-to-server webhook.
// We verify both the HMAC signature and the invoice via Aban before marking an order paid.
router.post("/payment/webhook", async (req, res) => {
    try {
        if (!ABAN_WEBHOOK_SECRET) {
            console.error("ABAN_WEBHOOK_SECRET is missing; refusing unsigned webhook processing.");
            return res.status(503).json({ success: false, message: "وب‌هوک آبان روی سرور کامل تنظیم نشده است." });
        }

        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
        const givenSignature = cleanString(req.get("X-Signature"), 200).toLowerCase();
        if (!rawBody || !/^[a-f0-9]{64}$/.test(givenSignature)) {
            return res.status(400).json({ success: false, message: "امضای وب‌هوک آبان نامعتبر است." });
        }

        const expectedSignature = crypto
            .createHmac("sha256", ABAN_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");
        const expectedBuffer = Buffer.from(expectedSignature, "hex");
        const givenBuffer = Buffer.from(givenSignature, "hex");
        if (expectedBuffer.length !== givenBuffer.length || !crypto.timingSafeEqual(expectedBuffer, givenBuffer)) {
            return res.status(400).json({ success: false, message: "امضای وب‌هوک آبان نامعتبر است." });
        }

        const event = req.body || {};
        const eventName = cleanString(event.event || req.get("X-Event"), 100);
        const invoiceId = cleanString(event.invoice_id, 200);
        const orderCode = cleanString(event.order_id || event?.metadata?.order_code, 80);

        if (!invoiceId || !orderCode) {
            return res.status(400).json({ success: false, message: "اطلاعات فاکتور وب‌هوک ناقص است." });
        }

        const { data: order, error } = await supabase
            .from("orders")
            .select("*")
            .eq("order_code", orderCode)
            .eq("payment_invoice_id", invoiceId)
            .maybeSingle();
        if (error) throw error;
        if (!order) return res.status(404).json({ success: false, message: "سفارش مرتبط با فاکتور پیدا نشد." });

        if (eventName !== "invoice.paid") {
            if (eventName === "invoice.expired" || eventName === "invoice.cancelled") {
                const nextStatus = eventName === "invoice.expired" ? "expired" : "cancelled";
                await supabase
                    .from("orders")
                    .update({ payment_status: nextStatus })
                    .eq("order_code", orderCode)
                    .neq("payment_status", "paid");
            }
            return res.status(200).json({ success: true, ignored: true });
        }

        if (order.payment_status === "paid") {
            return res.status(200).json({ success: true, duplicate: true });
        }

        await verifyAbanInvoiceForOrder(order, invoiceId);

        const { error: updateError } = await supabase
            .from("orders")
            .update({ payment_status: "paid", paid_at: event.paid_at || new Date().toISOString() })
            .eq("order_code", orderCode)
            .neq("payment_status", "paid");
        if (updateError) throw updateError;

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Aban webhook error:", error.message, error.code || "", error.payload || "");
        return res.status(error.status && error.status < 500 ? error.status : 500).json({
            success: false,
            message: "پردازش وب‌هوک آبان ناموفق بود."
        });
    }
});

// Legacy/manual browser callback kept for backward compatibility and diagnostics.
// The production callback_url sent to Aban points to /payment/webhook.
router.get("/payment/callback", async (req, res) => {
    const orderCode = cleanString(req.query?.order_id || req.query?.orderCode, 80);
    const invoiceIdFromQuery = cleanString(req.query?.invoice_id || req.query?.invoiceId, 200);

    try {
        let query = supabase.from("orders").select("*").limit(1);
        if (orderCode) query = query.eq("order_code", orderCode);
        else if (invoiceIdFromQuery) query = query.eq("payment_invoice_id", invoiceIdFromQuery);
        else return res.status(400).send("شناسه سفارش پرداخت ارسال نشده است.");

        const { data: orders, error } = await query;
        if (error) throw error;
        const order = orders?.[0];
        if (!order) return res.status(404).send("سفارش پیدا نشد.");

        const invoiceId = order.payment_invoice_id || invoiceIdFromQuery;
        if (!invoiceId) return res.status(400).send("فاکتور پرداخت سفارش پیدا نشد.");

        await verifyAbanInvoiceForOrder(order, invoiceId);

        const { data: paidOrder, error: updateError } = await supabase
            .from("orders")
            .update({ payment_status: "paid", paid_at: new Date().toISOString() })
            .eq("order_code", order.order_code)
            .neq("payment_status", "paid")
            .select()
            .maybeSingle();

        if (updateError) throw updateError;

        return res.send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>پرداخت SideWalk</title></head><body style="font-family:Arial;text-align:center;padding:50px"><h2>پرداخت با موفقیت تأیید شد ✅</h2><p>شماره سفارش: <b>${escapeHtml(String(order.order_code))}</b></p><p>می‌توانید به سایت SideWalk برگردید.</p></body></html>`);
    } catch (error) {
        console.error("Aban callback/verify error:", error.message, error.payload || "");
        if (error.status === 402) return res.status(402).send("پرداخت هنوز تأیید نشده است. لطفاً دوباره وضعیت پرداخت را بررسی کنید.");
        return res.status(500).send("خطا در تأیید پرداخت.");
    }
});

router.get("/payment/verify/:invoiceId", async (req, res) => {
    const invoiceId = cleanString(req.params.invoiceId, 200);
    try {
        const { data: order, error } = await supabase
            .from("orders")
            .select("*")
            .eq("payment_invoice_id", invoiceId)
            .maybeSingle();
        if (error) throw error;
        if (!order) return res.status(404).json({ success: false, message: "سفارش پرداخت پیدا نشد." });

        if (order.payment_status === "paid") {
            return res.json({ success: true, verified: true, order: mapOrder(order) });
        }

        const verification = await verifyAbanInvoiceForOrder(order, invoiceId);

        const { data: paidOrder, error: updateError } = await supabase
            .from("orders")
            .update({ payment_status: "paid", paid_at: new Date().toISOString() })
            .eq("order_code", order.order_code)
            .select()
            .single();
        if (updateError) throw updateError;

        return res.json({
            success: true,
            verified: true,
            alreadyVerified: Boolean(verification?.already_verified),
            order: mapOrder(paidOrder)
        });
    } catch (error) {
        console.error("Aban verify endpoint error:", error.message, error.payload || "");
        return res.status(error.status || 500).json({ success: false, message: error.message || "تأیید پرداخت ناموفق بود." });
    }
});

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
}

// Public tracking endpoint. Do not expose customer PII.
router.get("/:orderCode", async (req, res) => {
    try {
        const orderCode = cleanString(req.params.orderCode, 40);
        if (!/^SW-[A-Z0-9]+-[A-Z0-9]+$/i.test(orderCode)) {
            return res.status(404).json({ success: false, message: "سفارش پیدا نشد." });
        }

        const { data, error } = await supabase
            .from("orders")
            .select("id,order_code,items,total,status,delivery_method,created_at,updated_at")
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
router.use(verifyAdmin);

// Manual order entry from the admin panel (e.g. a walk-in customer taken
// by staff, without going through the customer-facing site). Phone number
// is optional here; everything else still goes through the same
// availability/price checks as a normal order.
function validateManualOrderBody(body = {}) {
    const customerName = cleanString(body.customerName, 100) || "مشتری حضوری";
    const customerPhone = normalizePhone(body.customerPhone);
    const tableNumber = cleanString(body.tableNumber, 20);
    const deliveryMethod = cleanString(body.deliveryMethod, 20) || "restaurant";
    const address = cleanString(body.address, 1000);
    const pickupEta = cleanString(body.pickupEta, 50);
    const items = Array.isArray(body.items) ? body.items : [];

    if (!DELIVERY_METHODS.has(deliveryMethod)) {
        return { error: "روش تحویل نامعتبر است." };
    }

    if (items.length < 1 || items.length > 50) {
        return { error: "تعداد محصولات سفارش نامعتبر است." };
    }

    const quantityByProduct = new Map();
    for (const item of items) {
        const productId = String(item?.productId || "").trim();
        const quantity = Number(item?.quantity);
        if (!UUID_RE.test(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
            return { error: "اطلاعات یکی از محصولات نامعتبر است." };
        }
        quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + quantity);
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

router.post("/manual", async (req, res) => {
    try {
        const validation = validateManualOrderBody(req.body);
        if (validation.error) {
            return res.status(400).json({ success: false, message: validation.error });
        }

        const { quantityByProduct, ...customer } = validation.value;
        const resolved = await resolveOrderItems(quantityByProduct);
        if (resolved.error) {
            return res.status(resolved.status).json({ success: false, message: resolved.error });
        }

        const { data, insertError } = await insertOrder({
            ...customer,
            items: resolved.items,
            total: resolved.total
        });

        if (insertError || !data) {
            console.error("Manual order insert error:", insertError?.message);
            return res.status(500).json({ success: false, message: "خطا در ثبت سفارش دستی." });
        }

        return res.status(201).json({
            success: true,
            message: "سفارش دستی با موفقیت ثبت شد.",
            order: mapOrder(data)
        });
    } catch (error) {
        console.error("Manual order create error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در ثبت سفارش دستی." });
    }
});

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
