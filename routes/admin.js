const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const supabase = require("../supabase");
const verifyAdmin = require("../middleware/auth");

// =====================
// ADMIN LOGIN
// =====================

router.post("/login", (req, res) => {
    const { username, password } = req.body;

    if (
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
    ) {
        const token = jwt.sign(
            { username },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.json({
            success: true,
            token
        });
    }

    res.status(401).json({
        success: false,
        message: "رمز یا نام کاربری اشتباه است"
    });
});

// =====================
// CHECK SESSION (برای checkExistingSession توی فرانت)
// =====================

router.get("/me", verifyAdmin, (req, res) => {
    res.json({
        success: true,
        admin: req.admin
    });
});

// =====================
// GET ALL REQUESTS
// =====================

router.get("/requests", verifyAdmin, async (req, res) => {
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

router.put("/requests/:trackingCode/status", verifyAdmin, async (req, res) => {
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

router.delete("/requests/:trackingCode", verifyAdmin, async (req, res) => {
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
