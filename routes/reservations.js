const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const supabase = require("../supabase");
const { verifyAdmin } = require("../middleware/auth");

// Reuses the exact same Aban Gateway env vars already configured for
// orders (routes/orders.js) — no new secrets needed on the server.
const ABAN_API_BASE = String(process.env.ABAN_API_BASE || "https://api.abangateway.ir/api/v1")
    .trim()
    .replace(/\/+$/, "");
const ABAN_API_TOKEN = String(process.env.ABAN_API_TOKEN || "").trim();
const ABAN_WEBHOOK_SECRET = String(process.env.ABAN_WEBHOOK_SECRET || "").trim();
const BACKEND_PUBLIC_URL = String(process.env.BACKEND_PUBLIC_URL || "https://sidewalk-menu-backend.onrender.com").trim().replace(/\/$/, "");
const RESERVATION_CALLBACK_URL = String(
    process.env.RESERVATION_CALLBACK_URL || `${BACKEND_PUBLIC_URL}/api/reservations/payment/webhook`
).trim();
const ABAN_REQUEST_TIMEOUT_MS = Math.min(Math.max(Number(process.env.ABAN_REQUEST_TIMEOUT_MS || 12000), 3000), 30000);
const RECONCILE_SECRET = String(process.env.RECONCILE_SECRET || "").trim();

// Reservation-specific business rules.
const MIN_GUESTS = 1;
const MAX_GUESTS = 30;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESERVATION_STATUSES = ["در انتظار پرداخت", "تایید شده", "لغو شده"];

// ---------------------------------------------------------------------
// Aban Gateway helpers (mirrors routes/orders.js so both flows behave
// identically; kept local to this file so order payment logic is never
// touched by reservation changes).
// ---------------------------------------------------------------------
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

async function createAbanInvoice({ reservationCode, totalToman }) {
    const amountRial = Math.round(Number(totalToman) * 10);
    if (!Number.isSafeInteger(amountRial) || amountRial <= 0) {
        throw new Error("مبلغ رزرو برای درگاه معتبر نیست.");
    }

    return abanRequest("/invoices", {
        method: "POST",
        body: JSON.stringify({
            amount_rial: amountRial,
            order_id: reservationCode,
            callback_url: RESERVATION_CALLBACK_URL,
            description: `پرداخت رزرو میز SideWalk ${reservationCode}`,
            metadata: { reservation_code: reservationCode, type: "reservation" }
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

function expectedReservationAmountRial(reservation) {
    const amount = Math.round(Number(reservation?.amount) * 10);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function assertVerifiedInvoiceMatchesReservation(result, reservation, invoiceId) {
    const payload = unwrapAbanInvoice(result);
    if (payload.invoice_id && String(payload.invoice_id) !== String(invoiceId)) {
        throw new Error("شناسه فاکتور تأییدشده با رزرو مطابقت ندارد.");
    }
    if (payload.order_id && String(payload.order_id) !== String(reservation.reservation_code)) {
        throw new Error("شناسه رزرو آبان با رزرو ثبت‌شده مطابقت ندارد.");
    }
    const expected = expectedReservationAmountRial(reservation);
    if (expected && payload.amount_rial != null && Number(payload.amount_rial) !== expected) {
        throw new Error("مبلغ تأییدشده آبان با مبلغ رزرو مطابقت ندارد.");
    }
    return payload;
}

async function verifyAbanInvoiceForReservation(reservation, invoiceId) {
    try {
        const result = await verifyAbanInvoice(invoiceId);
        return assertVerifiedInvoiceMatchesReservation(result, reservation, invoiceId);
    } catch (error) {
        if (!isAlreadyVerified(error)) throw error;
        const status = await getAbanInvoice(invoiceId);
        const payload = assertVerifiedInvoiceMatchesReservation(status, reservation, invoiceId);
        if (payload.status !== "paid") {
            const mismatch = new Error("فاکتور قبلاً verify شده اما وضعیت آن paid نیست.");
            mismatch.status = 409;
            mismatch.code = "aban_status_mismatch";
            throw mismatch;
        }
        return { ...payload, verified: true, already_verified: true };
    }
}

// ---------------------------------------------------------------------
// Small utilities (mirrors the style already used in routes/orders.js)
// ---------------------------------------------------------------------
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

function makeReservationCode() {
    return `RSV-${crypto.randomInt(10000000, 100000000)}-${crypto.randomInt(1000, 10000)}`;
}

function todayDateString() {
    // Good enough for a same-day cutoff check; not timezone-critical for
    // a table booking made hours/days in advance.
    return new Date().toISOString().slice(0, 10);
}

function mapReservation(row) {
    return {
        id: row.id,
        reservationCode: row.reservation_code,
        name: row.name,
        phone: row.phone,
        guests: row.guests,
        reservationDate: row.reservation_date,
        reservationTime: row.reservation_time,
        note: row.note || "",
        amount: Number(row.amount) || 0,
        paymentStatus: row.payment_status,
        status: row.status,
        paymentUrl: row.payment_url || null,
        createdAt: row.created_at,
        paidAt: row.paid_at || null
    };
}

async function calculatePrice(date) {
    const { data: settings } = await supabase
        .from("reservation_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

    let price = settings?.base_price ?? 100000;

    const day = new Date(date).getDay();
    if ((settings?.special_day_enabled ?? true) && (day === 4 || day === 5)) {
        price += Math.round(price * ((settings?.special_day_percent ?? 0) / 100));
    }

    if (settings?.event_enabled ?? true) {
        const { data: events } = await supabase
            .from("reservation_events")
            .select("*")
            .eq("event_date", date)
            .eq("active", true);

        if (events?.length) {
            const percent = Math.max(...events.map(e => e.price_percent || 0));
            price += Math.round(price * (percent / 100));
        }
    }

    return Math.round(price);
}

function validateReservationBody(body = {}) {
    const name = cleanString(body.name, 100);
    if (name.length < 2) return { error: "نام باید حداقل ۲ کاراکتر باشد." };

    const phone = normalizePhone(body.phone);
    if (!phone) return { error: "شماره موبایل معتبر نیست." };

    const guests = Number(body.guests);
    if (!Number.isInteger(guests) || guests < MIN_GUESTS || guests > MAX_GUESTS) {
        return { error: `تعداد نفرات باید بین ${MIN_GUESTS} تا ${MAX_GUESTS} باشد.` };
    }

    const reservationDate = cleanString(body.reservationDate || body.reservation_date, 10);
    if (!DATE_RE.test(reservationDate) || Number.isNaN(new Date(reservationDate).getTime())) {
        return { error: "تاریخ رزرو معتبر نیست." };
    }
    if (reservationDate < todayDateString()) {
        return { error: "تاریخ رزرو نمی‌تواند در گذشته باشد." };
    }

    const reservationTime = cleanString(body.reservationTime || body.reservation_time, 5);
    if (!TIME_RE.test(reservationTime)) {
        return { error: "ساعت رزرو معتبر نیست." };
    }

    const note = cleanString(body.note, 500);

    return { value: { name, phone, guests, reservationDate, reservationTime, note } };
}

// ---------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------

// Live price preview while the customer fills the form, before submitting.
router.get("/price", async (req, res) => {
    const date = cleanString(req.query.date, 10);
    if (!DATE_RE.test(date)) {
        return res.status(400).json({ success: false, message: "تاریخ نامعتبر است." });
    }
    try {
        const amount = await calculatePrice(date);
        res.json({ success: true, amount });
    } catch (error) {
        console.error("Reservation price error:", error.message);
        res.status(500).json({ success: false, message: "خطا در محاسبه قیمت." });
    }
});

router.post("/", async (req, res) => {
    let reservationCode = null;
    try {
        const validation = validateReservationBody(req.body);
        if (validation.error) {
            return res.status(400).json({ success: false, message: validation.error });
        }

        if (!ABAN_API_TOKEN) {
            return res.status(503).json({
                success: false,
                message: "درگاه Aban روی سرور تنظیم نشده است. ABAN_API_TOKEN را در Render اضافه کنید."
            });
        }

        const { name, phone, guests, reservationDate, reservationTime, note } = validation.value;
        const amount = await calculatePrice(reservationDate);
        reservationCode = makeReservationCode();

        const { data: inserted, error: insertError } = await supabase
            .from("reservations")
            .insert({
                reservation_code: reservationCode,
                name,
                phone,
                guests,
                reservation_date: reservationDate,
                reservation_time: reservationTime,
                note,
                amount,
                payment_status: "pending",
                status: "در انتظار پرداخت"
            })
            .select()
            .single();

        if (insertError || !inserted) {
            console.error("Reservation insert error:", insertError?.message);
            return res.status(500).json({ success: false, message: "خطا در ثبت رزرو." });
        }

        try {
            const invoiceResponse = await createAbanInvoice({ reservationCode, totalToman: amount });
            const invoice = unwrapAbanInvoice(invoiceResponse);
            const invoiceId = invoice?.invoice_id || invoice?.id;
            const paymentUrl = invoice?.payment_url || invoice?.paymentUrl;

            if (!invoiceId || !paymentUrl) {
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

            const { data: updated, error: updateError } = await supabase
                .from("reservations")
                .update({ payment_invoice_id: String(invoiceId), payment_url: String(paymentUrl) })
                .eq("reservation_code", reservationCode)
                .select()
                .single();

            if (updateError || !updated) {
                throw new Error("اطلاعات پرداخت رزرو در دیتابیس ذخیره نشد.");
            }

            return res.status(201).json({
                success: true,
                message: "رزرو ثبت شد و آماده پرداخت است.",
                reservation: mapReservation(updated),
                payment: {
                    invoiceId: String(invoiceId),
                    paymentUrl: String(paymentUrl),
                    payableToman: invoice?.payable_toman ?? amount
                }
            });
        } catch (paymentError) {
            console.error("Reservation Aban invoice error:", paymentError.message, paymentError.payload || "");
            await supabase.from("reservations").delete().eq("reservation_code", reservationCode);
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
        console.error("Reservation create error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در ثبت رزرو." });
    }
});

// Customer-facing status lookup (requires the code AND the phone it was
// booked with, so a guessed/shared code alone can't expose someone else's
// reservation details).
router.get("/code/:code", async (req, res) => {
    const code = cleanString(req.params.code, 40);
    const phone = normalizePhone(req.query.phone);
    if (!code || !phone) {
        return res.status(400).json({ success: false, message: "کد رزرو و شماره موبایل الزامی است." });
    }

    const { data, error } = await supabase
        .from("reservations")
        .select("*")
        .eq("reservation_code", code)
        .eq("phone", phone)
        .maybeSingle();

    if (error) {
        console.error("Reservation lookup error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت اطلاعات رزرو." });
    }
    if (!data) return res.status(404).json({ success: false, message: "رزرو پیدا نشد." });

    res.json({ success: true, reservation: mapReservation(data) });
});

router.get("/payment/verify/:invoiceId", async (req, res) => {
    const invoiceId = cleanString(req.params.invoiceId, 200);
    try {
        const { data: reservation, error } = await supabase
            .from("reservations")
            .select("*")
            .eq("payment_invoice_id", invoiceId)
            .maybeSingle();
        if (error) throw error;
        if (!reservation) return res.status(404).json({ success: false, message: "رزرو پرداخت پیدا نشد." });

        if (reservation.payment_status === "paid") {
            return res.json({ success: true, verified: true, reservation: mapReservation(reservation) });
        }

        const verification = await verifyAbanInvoiceForReservation(reservation, invoiceId);

        const { data: paid, error: updateError } = await supabase
            .from("reservations")
            .update({ payment_status: "paid", status: "تایید شده", paid_at: new Date().toISOString() })
            .eq("reservation_code", reservation.reservation_code)
            .select()
            .single();
        if (updateError) throw updateError;

        return res.json({
            success: true,
            verified: true,
            alreadyVerified: Boolean(verification?.already_verified),
            reservation: mapReservation(paid)
        });
    } catch (error) {
        console.error("Reservation verify endpoint error:", error.message, error.payload || "");
        return res.status(error.status || 500).json({ success: false, message: error.message || "تأیید پرداخت ناموفق بود." });
    }
});

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Legacy/manual browser callback, kept for diagnostics — the production
// callback_url sent to Aban points at /payment/webhook, same as orders.
router.get("/payment/callback", async (req, res) => {
    const code = cleanString(req.query?.order_id || req.query?.code, 80);
    const invoiceIdFromQuery = cleanString(req.query?.invoice_id || req.query?.invoiceId, 200);

    try {
        let query = supabase.from("reservations").select("*").limit(1);
        if (code) query = query.eq("reservation_code", code);
        else if (invoiceIdFromQuery) query = query.eq("payment_invoice_id", invoiceIdFromQuery);
        else return res.status(400).send("شناسه رزرو ارسال نشده است.");

        const { data: rows, error } = await query;
        if (error) throw error;
        const reservation = rows?.[0];
        if (!reservation) return res.status(404).send("رزرو پیدا نشد.");

        const invoiceId = reservation.payment_invoice_id || invoiceIdFromQuery;
        if (!invoiceId) return res.status(400).send("فاکتور پرداخت رزرو پیدا نشد.");

        await verifyAbanInvoiceForReservation(reservation, invoiceId);

        await supabase
            .from("reservations")
            .update({ payment_status: "paid", status: "تایید شده", paid_at: new Date().toISOString() })
            .eq("reservation_code", reservation.reservation_code)
            .neq("payment_status", "paid");

        return res.send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>پرداخت رزرو SideWalk</title></head><body style="font-family:Arial;text-align:center;padding:50px"><h2>پرداخت با موفقیت تأیید شد ✅</h2><p>کد رزرو: <b>${escapeHtml(String(reservation.reservation_code))}</b></p><p>می‌توانید به سایت SideWalk برگردید.</p></body></html>`);
    } catch (error) {
        console.error("Reservation callback/verify error:", error.message, error.payload || "");
        if (error.status === 402) return res.status(402).send("پرداخت هنوز تأیید نشده است. لطفاً دوباره وضعیت پرداخت را بررسی کنید.");
        return res.status(500).send("خطا در تأیید پرداخت.");
    }
});

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
        const code = cleanString(event.order_id || event?.metadata?.reservation_code, 80);

        if (!invoiceId || !code) {
            return res.status(400).json({ success: false, message: "اطلاعات فاکتور وب‌هوک ناقص است." });
        }

        const { data: reservation, error } = await supabase
            .from("reservations")
            .select("*")
            .eq("reservation_code", code)
            .eq("payment_invoice_id", invoiceId)
            .maybeSingle();
        if (error) throw error;
        if (!reservation) return res.status(404).json({ success: false, message: "رزرو مرتبط با فاکتور پیدا نشد." });

        if (eventName !== "invoice.paid") {
            if (eventName === "invoice.expired" || eventName === "invoice.cancelled") {
                await supabase
                    .from("reservations")
                    .update({ payment_status: eventName === "invoice.expired" ? "expired" : "cancelled" })
                    .eq("reservation_code", code)
                    .neq("payment_status", "paid");
            }
            return res.status(200).json({ success: true, ignored: true });
        }

        if (reservation.payment_status === "paid") {
            return res.status(200).json({ success: true, duplicate: true });
        }

        await verifyAbanInvoiceForReservation(reservation, invoiceId);

        const { error: updateError } = await supabase
            .from("reservations")
            .update({ payment_status: "paid", status: "تایید شده", paid_at: event.paid_at || new Date().toISOString() })
            .eq("reservation_code", code)
            .neq("payment_status", "paid");
        if (updateError) throw updateError;

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Reservation webhook error:", error.message, error.code || "", error.payload || "");
        return res.status(error.status && error.status < 500 ? error.status : 500).json({
            success: false,
            message: "پردازش وب‌هوک آبان ناموفق بود."
        });
    }
});

// Fallback for invoices Aban doesn't send a webhook for (e.g. cancelled
// manually from inside the Aban dashboard). Call this on a schedule (an
// external cron every 10-15 minutes) with the shared secret. Mirrors
// /api/orders/payment/reconcile exactly.
router.post("/payment/reconcile", async (req, res) => {
    try {
        const providedSecret = cleanString(req.get("X-Reconcile-Secret") || req.query?.secret, 200);
        if (!RECONCILE_SECRET) {
            return res.status(503).json({ success: false, message: "RECONCILE_SECRET روی سرور تنظیم نشده است." });
        }
        if (!providedSecret || providedSecret !== RECONCILE_SECRET) {
            return res.status(403).json({ success: false, message: "دسترسی غیرمجاز." });
        }

        const { data: pending, error } = await supabase
            .from("reservations")
            .select("reservation_code,amount,payment_invoice_id,payment_status")
            .eq("payment_status", "pending")
            .not("payment_invoice_id", "is", null)
            .limit(200);
        if (error) throw error;

        const updated = [];
        for (const reservation of pending || []) {
            try {
                const statusResponse = await getAbanInvoice(reservation.payment_invoice_id);
                const payload = unwrapAbanInvoice(statusResponse);
                const abanStatus = cleanString(payload?.status, 50);

                if (abanStatus === "cancelled" || abanStatus === "expired") {
                    await supabase
                        .from("reservations")
                        .update({ payment_status: abanStatus })
                        .eq("reservation_code", reservation.reservation_code)
                        .neq("payment_status", "paid");
                    updated.push({ reservationCode: reservation.reservation_code, paymentStatus: abanStatus });
                } else if (abanStatus === "paid") {
                    await verifyAbanInvoiceForReservation(reservation, reservation.payment_invoice_id);
                    await supabase
                        .from("reservations")
                        .update({ payment_status: "paid", status: "تایید شده", paid_at: new Date().toISOString() })
                        .eq("reservation_code", reservation.reservation_code)
                        .neq("payment_status", "paid");
                    updated.push({ reservationCode: reservation.reservation_code, paymentStatus: "paid" });
                }
            } catch (innerError) {
                console.error("Reconcile reservation error:", reservation.reservation_code, innerError.message);
            }
        }

        return res.json({ success: true, checked: (pending || []).length, updated });
    } catch (error) {
        console.error("Reservation reconcile endpoint error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در همگام‌سازی وضعیت پرداخت‌های رزرو." });
    }
});

// ---------------------------------------------------------------------
// Admin routes — every route below requires a valid admin JWT.
// ---------------------------------------------------------------------
const adminRouter = express.Router();
adminRouter.use(verifyAdmin);

adminRouter.get("/", async (req, res) => {
    let query = supabase.from("reservations").select("*").order("created_at", { ascending: false });

    const status = cleanString(req.query.status, 30);
    if (status && RESERVATION_STATUSES.includes(status)) query = query.eq("status", status);

    const date = cleanString(req.query.date, 10);
    if (DATE_RE.test(date)) query = query.eq("reservation_date", date);

    const { data, error } = await query;
    if (error) {
        console.error("Reservation admin list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت رزروها." });
    }
    res.json({ success: true, reservations: (data || []).map(mapReservation) });
});

adminRouter.patch("/:id/status", async (req, res) => {
    const status = cleanString(req.body?.status, 30);
    if (!RESERVATION_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: "وضعیت نامعتبر است." });
    }

    const { data, error } = await supabase
        .from("reservations")
        .update({ status })
        .eq("id", req.params.id)
        .select()
        .single();

    if (error || !data) {
        console.error("Reservation status update error:", error?.message);
        return res.status(error ? 500 : 404).json({ success: false, message: error ? "خطا در تغییر وضعیت." : "رزرو پیدا نشد." });
    }
    res.json({ success: true, reservation: mapReservation(data) });
});

adminRouter.delete("/:id", async (req, res) => {
    const { data, error } = await supabase.from("reservations").delete().eq("id", req.params.id).select();
    if (error) {
        console.error("Reservation delete error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در حذف رزرو." });
    }
    if (!data || data.length === 0) return res.status(404).json({ success: false, message: "رزرو پیدا نشد." });
    res.json({ success: true, message: "رزرو حذف شد." });
});

// --- Settings (single-row config: base price + special-day/event toggles) ---
function mapSettings(row) {
    return {
        basePrice: row?.base_price ?? 100000,
        specialDayEnabled: row?.special_day_enabled ?? true,
        specialDayPercent: row?.special_day_percent ?? 60,
        eventEnabled: row?.event_enabled ?? true
    };
}

adminRouter.get("/settings", async (req, res) => {
    const { data, error } = await supabase.from("reservation_settings").select("*").limit(1).maybeSingle();
    if (error) {
        console.error("Reservation settings fetch error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت تنظیمات." });
    }
    res.json({ success: true, settings: mapSettings(data) });
});

adminRouter.put("/settings", async (req, res) => {
    const basePrice = Number(req.body?.basePrice);
    const specialDayPercent = Number(req.body?.specialDayPercent);
    if (!Number.isFinite(basePrice) || basePrice < 0 || basePrice > 1000000000) {
        return res.status(400).json({ success: false, message: "مبلغ پایه نامعتبر است." });
    }
    if (!Number.isFinite(specialDayPercent) || specialDayPercent < 0 || specialDayPercent > 500) {
        return res.status(400).json({ success: false, message: "درصد روزهای خاص نامعتبر است." });
    }

    const payload = {
        base_price: Math.round(basePrice),
        special_day_enabled: req.body?.specialDayEnabled !== false,
        special_day_percent: Math.round(specialDayPercent),
        event_enabled: req.body?.eventEnabled !== false,
        updated_at: new Date().toISOString()
    };

    const { data: existing } = await supabase.from("reservation_settings").select("id").limit(1).maybeSingle();

    const query = existing
        ? supabase.from("reservation_settings").update(payload).eq("id", existing.id)
        : supabase.from("reservation_settings").insert(payload);

    const { data, error } = await query.select().single();
    if (error) {
        console.error("Reservation settings save error:", error.message);
        return res.status(500).json({ success: false, message: "ذخیره تنظیمات ناموفق بود." });
    }
    res.json({ success: true, settings: mapSettings(data) });
});

// --- Events (special-occasion price bumps for specific dates) ---
function mapEvent(row) {
    return {
        id: row.id,
        title: row.title,
        eventDate: row.event_date,
        startTime: row.start_time,
        endTime: row.end_time,
        pricePercent: row.price_percent,
        active: row.active
    };
}

function validateEventBody(body = {}, { partial = false } = {}) {
    const result = {};
    const hasField = key => Object.prototype.hasOwnProperty.call(body, key);

    if (!partial || hasField("title")) {
        const title = cleanString(body.title, 100);
        if (title.length < 2) return { error: "عنوان ایونت باید حداقل ۲ کاراکتر باشد." };
        result.title = title;
    }
    if (!partial || hasField("eventDate")) {
        const eventDate = cleanString(body.eventDate, 10);
        if (!DATE_RE.test(eventDate)) return { error: "تاریخ ایونت نامعتبر است." };
        result.eventDate = eventDate;
    }
    if (hasField("startTime")) {
        const startTime = cleanString(body.startTime, 5);
        if (startTime && !TIME_RE.test(startTime)) return { error: "ساعت شروع نامعتبر است." };
        result.startTime = startTime || null;
    }
    if (hasField("endTime")) {
        const endTime = cleanString(body.endTime, 5);
        if (endTime && !TIME_RE.test(endTime)) return { error: "ساعت پایان نامعتبر است." };
        result.endTime = endTime || null;
    }
    if (!partial || hasField("pricePercent")) {
        const pricePercent = Number(body.pricePercent);
        if (!Number.isFinite(pricePercent) || pricePercent < 0 || pricePercent > 500) {
            return { error: "درصد افزایش قیمت ایونت نامعتبر است." };
        }
        result.pricePercent = Math.round(pricePercent);
    }
    if (!partial || hasField("active")) {
        result.active = body.active !== false;
    }

    return { value: result };
}

adminRouter.get("/events", async (req, res) => {
    const { data, error } = await supabase.from("reservation_events").select("*").order("event_date", { ascending: true });
    if (error) {
        console.error("Reservation events list error:", error.message);
        return res.status(500).json({ success: false, message: "خطا در دریافت ایونت‌ها." });
    }
    res.json({ success: true, events: (data || []).map(mapEvent) });
});

adminRouter.post("/events", async (req, res) => {
    const validation = validateEventBody(req.body, { partial: false });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });

    const v = validation.value;
    const { data, error } = await supabase
        .from("reservation_events")
        .insert({
            title: v.title,
            event_date: v.eventDate,
            start_time: v.startTime,
            end_time: v.endTime,
            price_percent: v.pricePercent,
            active: v.active
        })
        .select()
        .single();

    if (error) {
        console.error("Reservation event create error:", error.message);
        return res.status(500).json({ success: false, message: "ثبت ایونت ناموفق بود." });
    }
    res.status(201).json({ success: true, event: mapEvent(data) });
});

adminRouter.put("/events/:id", async (req, res) => {
    const validation = validateEventBody(req.body, { partial: true });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });

    const v = validation.value;
    const patch = { };
    if ("title" in v) patch.title = v.title;
    if ("eventDate" in v) patch.event_date = v.eventDate;
    if ("startTime" in v) patch.start_time = v.startTime;
    if ("endTime" in v) patch.end_time = v.endTime;
    if ("pricePercent" in v) patch.price_percent = v.pricePercent;
    if ("active" in v) patch.active = v.active;

    const { data, error } = await supabase
        .from("reservation_events")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .single();

    if (error || !data) {
        console.error("Reservation event update error:", error?.message);
        return res.status(error ? 500 : 404).json({ success: false, message: error ? "ویرایش ایونت ناموفق بود." : "ایونت پیدا نشد." });
    }
    res.json({ success: true, event: mapEvent(data) });
});

adminRouter.delete("/events/:id", async (req, res) => {
    const { data, error } = await supabase.from("reservation_events").delete().eq("id", req.params.id).select();
    if (error) {
        console.error("Reservation event delete error:", error.message);
        return res.status(500).json({ success: false, message: "حذف ایونت ناموفق بود." });
    }
    if (!data || data.length === 0) return res.status(404).json({ success: false, message: "ایونت پیدا نشد." });
    res.json({ success: true, message: "ایونت حذف شد." });
});

router.use("/admin", adminRouter);

module.exports = router;
