const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema({

    trackingCode: {
        type: String,
        required: true,
        unique: true
    },

    firstName: String,

    lastName: String,

    mobile: String,

    phone: String,

    province: String,

    city: String,

    experience: String,

    business: String,

    address: String,

    description: String,

    status: {
        type: String,
        default: "در حال بررسی"
    }

}, {
    timestamps: true
});


module.exports = mongoose.model(
    "Request",
    requestSchema
);