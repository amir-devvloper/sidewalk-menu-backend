const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());


// اتصال دیتابیس
mongoose.connect(process.env.MONGO_URL)
.then(() => {
    console.log("Database connected");
})
.catch((err) => {
    console.log("Database error:", err);
});


// تست سرور
app.get("/", (req, res) => {
    res.send("SIDE WALK API Running");
});


// مسیر محصولات
const productRoutes = require("./routes/products");
app.use("/api/products", productRoutes);


// مسیر سفارش‌ها
const orderRoutes = require("./routes/orders");
app.use("/api/orders", orderRoutes);


// مسیر ادمین
const adminRoutes = require("./routes/admin");
app.use("/api/admin", adminRoutes.router);


const PORT = 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});