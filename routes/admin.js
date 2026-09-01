const express = require("express");
const router = express.Router();

const Request = require("../models/Request");


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

        const requests = await Request.find()
            .sort({ createdAt: -1 });


        res.json({
            success: true,
            requests
        });


    } catch(error) {

        res.status(500).json({
            success:false,
            message:error.message
        });

    }

});



// =====================
// CHANGE STATUS
// =====================

router.put("/requests/:trackingCode/status", async (req,res)=>{

    try {

        const updated = await Request.findOneAndUpdate(
            {
                trackingCode:req.params.trackingCode
            },
            {
                status:req.body.status
            },
            {
                new:true
            }
        );


        res.json({
            success:true,
            request:updated
        });


    } catch(error){

        res.status(500).json({
            success:false,
            message:error.message
        });

    }

});



// =====================
// DELETE REQUEST
// =====================

router.delete("/requests/:trackingCode", async(req,res)=>{

    try{

        await Request.findOneAndDelete({
            trackingCode:req.params.trackingCode
        });


        res.json({
            success:true,
            message:"Deleted"
        });


    }catch(error){

        res.status(500).json({
            success:false,
            message:error.message
        });

    }

});


module.exports = {
    router
};