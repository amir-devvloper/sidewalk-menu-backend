const assert = require("assert");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const secret = "a".repeat(64);
const token = jwt.sign({ role: "admin" }, secret, {
    algorithm: "HS256", expiresIn: "30m", issuer: "sidewalk-admin", audience: "sidewalk-admin-panel", subject: "admin"
});
const decoded = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "sidewalk-admin", audience: "sidewalk-admin-panel" });
assert.equal(decoded.role, "admin");
assert.equal(decoded.sub, "admin");
assert.throws(() => jwt.verify(token, "b".repeat(64), { algorithms: ["HS256"] }));

const password = "CorrectHorseBatteryStaple!123";
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
const check = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
assert(crypto.timingSafeEqual(hash, check));
const wrong = crypto.scryptSync("wrong", salt, 64, { N: 16384, r: 8, p: 1 });
assert(!crypto.timingSafeEqual(hash, wrong));

console.log("Security self-test passed.");
