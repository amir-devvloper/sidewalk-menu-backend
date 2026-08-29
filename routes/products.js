const express = require("express");
const router = express.Router();

const Product = require("../models/Product");


// دریافت همه محصولات
router.get("/", async (req, res) => {

    const products = await Product.find();

    res.json(products);

});


// اضافه کردن محصول
router.post("/", async (req, res) => {

    const product = await Product.create(req.body);

    res.json(product);

});


// حذف محصول
router.delete("/:id", async (req, res) => {

    await Product.findByIdAndDelete(req.params.id);

    res.json({
        message: "Product deleted"
    });

});


module.exports = router;