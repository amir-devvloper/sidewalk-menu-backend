const express = require("express");
const router = express.Router();

const supabase = require("../supabase");

// =====================
// ADMIN LOGIN
// =====================

router.post("/login", (req, res) => {
    const { username, password } = req.body;

    if (
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
    ) {
        return res.json({
            success: true,
            token: "test-token-123"
        });
    }

    res.status(401).json({
        success: false,
        message: "رمز یا نام کاربری اشتباه است"
    });
});

// =====================
// GET ALL REQUESTS
// =====================

router.get("/requests", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("requests")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({
                success: false,
                message: error.message
            });
        }

        res.json({
            success: true,
            requests: data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// =====================
// CHANGE STATUS
// =====================

router.put("/requests/:trackingCode/status", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("requests")
            .update({
                status: req.body.status,
                updated_at: new Date().toISOString()
            })
            .eq("tracking_code", req.params.trackingCode)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                message: "درخواست پیدا نشد."
            });
        }

        res.json({
            success: true,
            request: data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// =====================
// DELETE REQUEST
// =====================

router.delete("/requests/:trackingCode", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("requests")
            .delete()
            .eq("tracking_code", req.params.trackingCode)
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
                message: "درخواست پیدا نشد."
            });
        }

        res.json({
            success: true,
            message: "Deleted"
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = {
    router
};