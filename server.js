const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("SIDE WALK API Running");
});

const productRoutes = require("./routes/products");
app.use("/api/products", productRoutes);

const orderRoutes = require("./routes/orders");
app.use("/api/orders", orderRoutes);

const adminRoutes = require("./routes/admin");
app.use("/api/admin", adminRoutes.router);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});