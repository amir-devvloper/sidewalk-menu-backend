const crypto = require("crypto");

const password = process.argv[2];
if (!password || password.length < 12) {
    console.error("Usage: node scripts/hash-password.js <password>  (minimum 12 characters)");
    process.exit(1);
}

const salt = crypto.randomBytes(16).toString("hex");
crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
    if (err) {
        console.error("Could not hash password.");
        process.exit(1);
    }
    console.log(`scrypt$${salt}$${derivedKey.toString("hex")}`);
});
