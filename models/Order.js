const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
    orderCode: { type: String, required: true, unique: true },
    customerName: { type: String, required: true, trim: true },
    tableNumber: { type: String, required: true, trim: true },
    customerPhone: { type: String, default: "", trim: true },
    items: [{
        productId: { type: String, required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 }
    }],
    total: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        enum: ["جدید", "در حال آماده‌سازی", "آماده شد", "تحویل شد", "لغو شد"],
        default: "جدید"
    }
}, { timestamps: true });

module.exports = mongoose.model("Order", orderSchema);
