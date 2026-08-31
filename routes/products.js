const express = require("express");
const router = express.Router();

const Product = require("../models/Product");


// گرفتن همه محصولات
router.get("/", async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);

    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
});


// اضافه کردن محصول
router.post("/", async (req, res) => {
    try {
        const product = new Product(req.body);
        const savedProduct = await product.save();

        res.status(201).json(savedProduct);

    } catch (error) {
        res.status(400).json({
            message: error.message
        });
    }
});


// ویرایش محصول
router.put("/:id", async (req, res) => {
    try {
        const updated = await Product.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );

        res.json(updated);

    } catch (error) {
        res.status(400).json({
            message: error.message
        });
    }
});


// حذف محصول
router.delete("/:id", async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);

        res.json({
            message: "Product deleted"
        });

    } catch (error) {
        res.status(400).json({
            message: error.message
        });
    }
});


module.exports = router;

// ویرایش محصول
router.put("/:id", async (req, res) => {

    try {

        const updatedProduct = await Product.findByIdAndUpdate(
            req.params.id,
            req.body,
            {
                new: true
            }
        );


        res.json(updatedProduct);


    } catch (error) {

        res.status(400).json({
            message: error.message
        });

    }

});