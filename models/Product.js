const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({

    name: {
        type: String,
        required: true
    },

    category: {
        type: String,
        required: true
    },

    description: {
        type: String,
        default: ""
    },

    price: {
        type: Number,
        required: true
    },

    image: {
        type: String,
        default: ""
    },

    available: {
        type: Boolean,
        default: true
    }

}, {
    timestamps: true
});


module.exports = mongoose.model(
    "Product",
    productSchema
);