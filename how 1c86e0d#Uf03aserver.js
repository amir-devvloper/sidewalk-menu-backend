[33mcommit d1da4111839461c690bf202037273afe3b4fd9c7[m
Author: amir--devvloper <amirggh950@gmail.com>
Date:   Mon Aug 31 15:02:41 2026 +0330

    Keep env file local

[1mdiff --git a/models/Product.js b/models/Product.js[m
[1mindex c10a130..a4cbe2f 100644[m
[1m--- a/models/Product.js[m
[1m+++ b/models/Product.js[m
[36m@@ -1,6 +1,5 @@[m
 const mongoose = require("mongoose");[m
 [m
[31m-[m
 const productSchema = new mongoose.Schema({[m
 [m
     name: {[m
[36m@@ -13,19 +12,28 @@[m [mconst productSchema = new mongoose.Schema({[m
         required: true[m
     },[m
 [m
[32m+[m[32m    description: {[m
[32m+[m[32m        type: String,[m
[32m+[m[32m        default: ""[m
[32m+[m[32m    },[m
[32m+[m
     price: {[m
         type: Number,[m
         required: true[m
     },[m
 [m
     image: {[m
[31m-        type: String[m
[32m+[m[32m        type: String,[m
[32m+[m[32m        default: ""[m
     },[m
 [m
[31m-    description: {[m
[31m-        type: String[m
[32m+[m[32m    available: {[m
[32m+[m[32m        type: Boolean,[m
[32m+[m[32m        default: true[m
     }[m
 [m
[32m+[m[32m}, {[m
[32m+[m[32m    timestamps: true[m
 });[m
 [m
 [m
[1mdiff --git a/package-lock.json b/package-lock.json[m
[1mindex 331d45b..f15743c 100644[m
[1m--- a/package-lock.json[m
[1m+++ b/package-lock.json[m
[36m@@ -30,7 +30,6 @@[m
       "integrity": "sha512-l2aFy5jALhniG5HgqrD6jXLi/rUWrKvqN/qJx6yoJsgKhblVd+iqqU4RCXavm/jPityDo5TCvKMnpjKnOriy0w==",[m
       "license": "MIT"[m
     },[m
[31m-    "node_modules/@types/webidl-conversions": {},[m
     "node_modules/@types/whatwg-url": {[m
       "version": "13.0.0",[m
       "resolved": "https://registry.npmjs.org/@types/whatwg-url/-/whatwg-url-13.0.0.tgz",[m
[1mdiff --git a/routes/products.js b/routes/products.js[m
[1mindex 02cc5b8..d4a3b30 100644[m
[1m--- a/routes/products.js[m
[1m+++ b/routes/products.js[m
[36m@@ -4,36 +4,97 @@[m [mconst router = express.Router();[m
 const Product = require("../models/Product");[m
 [m
 [m
[31m-// دریافت همه محصولات[m
[32m+[m[32m// گرفتن همه محصولات[m
 router.get("/", async (req, res) => {[m
[31m-[m
[31m-    const products = await Product.find();[m
[31m-[m
[31m-    res.json(products);[m
[31m-[m
[32m+[m[32m    try {[m
[32m+[m[32m        const products = await Product.find();[m
[32m+[m[32m        res.json(products);[m
[32m+[m
[32m+[m[32m    } catch (error) {[m
[32m+[m[32m        res.status(500).json({[m
[32m+[m[32m            message: error.message[m
[32m+[m[32m        });[m
[32m+[m[32m    }[m
 });[m
 [m
 [m
 // اضافه کردن محصول[m
 router.post("/", async (req, res) => {[m
[32m+[m[32m    try {[m
[32m+[m[32m        const product = new Product(req.body);[m
[32m+[m[32m        const savedProduct = await product.save();[m
[32m+[m
[32m+[m[32m        res.status(201).json(savedProduct);[m
[32m+[m
[32m+[m[32m    } catch (error) {[m
[32m+[m[32m        res.status(400).json({[m
[32m+[m[32m            message: error.message[m
[32m+[m[32m        });[m
[32m+[m[32m    }[m
[32m+[m[32m});[m
 [m
[31m-    const product = await Product.create(req.body);[m
 [m
[31m-    res.json(product);[m
[32m+[m[32m// ویرایش محصول[m
[32m+[m[32mrouter.put("/:id", async (req, res) => {[m
[32m+[m[32m    try {[m
[32m+[m[32m        const updated = await Product.findByIdAndUpdate([m
[32m+[m[32m            req.params.id,[m
[32m+[m[32m            req.body,[m
[32m+[m[32m            { new: true }[m
[32m+[m[32m        );[m
 [m
[32m+[m[32m        res.json(updated);[m
[32m+[m
[32m+[m[32m    } catch (error) {[m
[32m+[m[32m        res.status(400).json({[m
[32m+[m[32m            message: error.message[m
[32m+[m[32m        });[m
[32m+[m[32m    }[m
 });[m
 [m
 [m
 // حذف محصول[m
 router.delete("/:id", async (req, res) => {[m
[32m+[m[32m    try {[m
[32m+[m[32m        await Product.findByIdAndDelete(req.params.id);[m
[32m+[m
[32m+[m[32m        res.json({[m
[32m+[m[32m            message: "Product deleted"[m
[32m+[m[32m        });[m
[32m+[m
[32m+[m[32m    } catch (error) {[m
[32m+[m[32m        res.status(400).json({[m
[32m+[m[32m            message: error.message[m
[32m+[m[32m        });[m
[32m+[m[32m    }[m
[32m+[m[32m});[m
 [m
[31m-    await Product.findByIdAndDelete(req.params.id);[m
 [m
[31m-    res.json({[m
[31m-        message: "Product deleted"[m
[31m-    });[m
[32m+[m[32mmodule.exports = router;[m
 [m
[31m-});[m
[32m+[m[32m// ویرایش محصول[m
[32m+[m[32mrouter.put("/:id", async (req, res) => {[m
[32m+[m
[32m+[m[32m    try {[m
[32m+[m
[32m+[m[32m        const updatedProduct = await Product.findByIdAndUpdate([m
[32m+[m[32m            req.params.id,[m
[32m+[m[32m            req.body,[m
[32m+[m[32m            {[m
[32m+[m[32m                new: true[m
[32m+[m[32m            }[m
[32m+[m[32m        );[m
[32m+[m
[32m+[m
[32m+[m[32m        res.json(updatedProduct);[m
[32m+[m
[32m+[m
[32m+[m[32m    } catch (error) {[m
[32m+[m
[32m+[m[32m        res.status(400).json({[m
[32m+[m[32m            message: error.message[m
[32m+[m[32m        });[m
 [m
[32m+[m[32m    }[m
 [m
[31m-module.exports = router;[m
\ No newline at end of file[m
[32m+[m[32m});[m
\ No newline at end of file[m
[1mdiff --git a/server.js b/server.js[m
[1mindex 5aa7f0f..9e49f99 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -27,10 +27,14 @@[m [mapp.get("/", (req, res) => {[m
 [m
 // مسیر محصولات[m
 const productRoutes = require("./routes/products");[m
[31m-[m
 app.use("/api/products", productRoutes);[m
 [m
 [m
[32m+[m[32m// مسیر ادمین[m
[32m+[m[32mconst adminRoutes = require("./routes/admin");[m
[32m+[m[32mapp.use("/api/admin", adminRoutes.router);[m
[32m+[m
[32m+[m
 const PORT = 5000;[m
 [m
 app.listen(PORT, () => {[m
