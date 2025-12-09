require("dotenv").config();
const axios = require("axios");
const https = require("https");

// ===============================
// 🌍 CONFIG FROM .env
// ===============================
const PANEL_URL = process.env.AAPANEL_URL;
const COOKIE = process.env.AAPANEL_COOKIE;
const X_HTTP_TOKEN = process.env.AAPANEL_TOKEN;

const DOMAIN = process.env.MAIL_DOMAIN;
const A_RECORD = process.env.MAIL_A_RECORD;
const IP = process.env.MAIL_SERVER_IP;

// ===============================
// 🔐 ALLOW SELF-SIGNED HTTPS
// ===============================
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ===============================
// 🚀 ADD DOMAIN LIKE CURL
// ===============================
async function addDomain() {
    try {
        const form = new URLSearchParams();
        form.append("domain", DOMAIN);
        form.append("a_record", A_RECORD);
        form.append("ips", IP);

        const res = await axios.post(PANEL_URL, form.toString(), {
            httpsAgent,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-http-token": X_HTTP_TOKEN,
                Cookie: COOKIE,
            },
        });

        console.log("🎉 Domain Added Response:", res.data);
    } catch (err) {
        console.error("\n❌ ERROR:", err.response?.data || err.message);
    }
}

// ===============================
// ▶ RUN
// ===============================
addDomain();
