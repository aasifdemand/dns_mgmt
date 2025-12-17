// require("dotenv").config();
// const axios = require("axios");
// const https = require("https");

// // ===============================
// // 🌍 CONFIG FROM .env
// // ===============================
// const PANEL_URL = process.env.AAPANEL_ADDURL;
// const COOKIE = process.env.AAPANEL_COOKIE;
// const X_HTTP_TOKEN = process.env.AAPANEL_TOKEN;

// const DOMAIN = process.env.MAIL_DOMAIN;
// const A_RECORD = process.env.MAIL_A_RECORD;
// const IP = process.env.MAIL_SERVER_IP;

// // ===============================
// // 🔐 ALLOW SELF-SIGNED HTTPS
// // ===============================
// const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// // ===============================
// // 🚀 ADD DOMAIN LIKE CURL
// // ===============================
// async function addDomain() {
//     try {
//         const form = new URLSearchParams();
//         form.append("domain", DOMAIN);
//         form.append("a_record", A_RECORD);
//         form.append("ips", IP);

//         const res = await axios.post(PANEL_URL, form.toString(), {
//             httpsAgent,
//             headers: {
//                 "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
//                 "x-http-token": X_HTTP_TOKEN,
//                 Cookie: COOKIE,
//             },
//         });

//         console.log("🎉 Domain Added Response:", res.data);
//     } catch (err) {
//         console.error("\n❌ ERROR:", err.response?.data || err.message);
//     }
// }

// // ===============================
// // ▶ RUN
// // ===============================
// addDomain();


/**
 * aaPanel Mail Server Domain + SSL (DNS) + Cloudflare
 * FINAL STABLE VERSION
 */




// require("dotenv").config();
// const axios = require("axios");
// const https = require("https");

// // ===============================
// // HTTPS (aaPanel self-signed)
// // ===============================
// const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// // ===============================
// // ENV VARIABLES (EXACT MATCH)
// // ===============================
// const {
//     AAPANEL_BASE_URL,
//     AAPANEL_COOKIE,
//     AAPANEL_TOKEN,

//     MAIL_DOMAIN,
//     MAIL_A_RECORD,
//     MAIL_SERVER_IP,

//     CF_VERISENCE_TECH_TOKEN,
//     CF_VERISENCE_TECH_ZONE_ID,
// } = process.env;

// // ===============================
// // VALIDATION
// // ===============================
// if (!AAPANEL_BASE_URL) throw new Error("❌ AAPANEL_BASE_URL missing");
// if (!AAPANEL_COOKIE || !AAPANEL_TOKEN) throw new Error("❌ aaPanel auth missing");
// if (!MAIL_DOMAIN || !MAIL_A_RECORD || !MAIL_SERVER_IP)
//     throw new Error("❌ Mail config missing");
// if (!CF_VERISENCE_TECH_TOKEN || !CF_VERISENCE_TECH_ZONE_ID)
//     throw new Error("❌ Cloudflare config missing");

// // ===============================
// // AXIOS CLIENTS
// // ===============================
// const panel = axios.create({
//     httpsAgent,
//     timeout: 60000,
//     headers: {
//         "x-http-token": AAPANEL_TOKEN,
//         Cookie: AAPANEL_COOKIE,
//         "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
//     },
// });

// const cloudflare = axios.create({
//     baseURL: "https://api.cloudflare.com/client/v4",
//     headers: {
//         Authorization: `Bearer ${CF_VERISENCE_TECH_TOKEN}`,
//         "Content-Type": "application/json",
//     },
// });

// // ===============================
// // HELPERS
// // ===============================
// const sleep = ms => new Promise(r => setTimeout(r, ms));

// const form = obj => {
//     const f = new URLSearchParams();
//     Object.entries(obj).forEach(([k, v]) => f.append(k, v));
//     return f.toString();
// };

// // ===============================
// // 1️⃣ ADD MAIL DOMAIN
// // ===============================
// async function addMailDomain() {
//     const res = await panel.post(
//         `${AAPANEL_BASE_URL}/plugin?action=a&name=mail_sys&s=add_domain`,
//         form({
//             domain: MAIL_DOMAIN,
//             a_record: MAIL_A_RECORD,
//             ips: MAIL_SERVER_IP,
//         })
//     );

//     console.log("✅ Mail domain added:", res.data);
//     if (!res.data?.status) throw new Error("Mail domain add failed");
// }

// // ===============================
// // 2️⃣ REQUEST SSL (DNS)
// // ===============================
// async function requestSSL() {
//     const res = await panel.post(
//         `${AAPANEL_BASE_URL}/plugin?action=a&name=mail_sys&s=apply_cert`,
//         form({
//             type: "mail",
//             auth_type: "dns",
//             auth_to: "dns", // aaPanel bug workaround
//             dnsapi: "0",
//             force: "1",
//             auto_wildcard: "0",
//             domains: JSON.stringify([MAIL_DOMAIN]),
//         })
//     );

//     console.log("🔐 SSL request:", res.data);

//     if (!res.data?.auths || !res.data?.index) {
//         throw new Error("SSL request failed");
//     }

//     return res.data;
// }

// // ===============================
// // 3️⃣ ADD TXT TO CLOUDFLARE
// // ===============================
// async function addTxtToCloudflare(value) {
//     await cloudflare.post(
//         `/zones/${CF_VERISENCE_TECH_ZONE_ID}/dns_records`,
//         {
//             type: "TXT",
//             name: `_acme-challenge.${MAIL_DOMAIN}`,
//             content: value,
//             ttl: 120,
//         }
//     );

//     console.log(`🌐 TXT added: _acme-challenge.${MAIL_DOMAIN}`);
// }

// // ===============================
// // 4️⃣ VERIFY SSL (CORRECT METHOD)
// // ===============================
// async function verifySSL(index) {
//     const res = await panel.post(
//         `${AAPANEL_BASE_URL}/plugin?action=a&name=mail_sys&s=apply_cert`,
//         form({
//             type: "mail",
//             auth_type: "dns",
//             auth_to: "dns",
//             verify: "1",
//             index,
//             domains: JSON.stringify([MAIL_DOMAIN]),
//         })
//     );

//     console.log("🎉 SSL verify:", res.data);
//     if (!res.data?.status) throw new Error("SSL verification failed");
// }

// // ===============================
// // ▶ MAIN FLOW
// // ===============================
// (async () => {
//     try {
//         console.log("\n🚀 aaPanel Mail + SSL Automation\n");

//         await addMailDomain();

//         const ssl = await requestSSL();

//         for (const a of ssl.auths) {
//             console.log(`📌 Adding TXT: _acme-challenge.${a.domain}`);
//             await addTxtToCloudflare(a.auth_value);
//         }

//         console.log("\n⏳ Waiting 90 seconds for DNS propagation...");
//         await sleep(90000);

//         await verifySSL(ssl.index);

//         console.log("\n🔒 SSL SUCCESSFULLY INSTALLED FOR MAIL SERVER\n");

//     } catch (err) {
//         console.error("\n❌ ERROR:", err.response?.data || err.message);
//     }
// })();






require("dotenv").config();
const axios = require("axios");
const https = require("https");

// ===============================
// HTTPS AGENT (aaPanel self-signed)
// ===============================
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ===============================
// ENV VARIABLES
// ===============================
const {
    AAPANEL_BASE_URL,
    AAPANEL_COOKIE,
    AAPANEL_TOKEN,

    MAIL_DOMAIN,
    MAIL_A_RECORD,
    MAIL_SERVER_IP,

    CF_VERISENCE_TECH_TOKEN,
    CF_VERISENCE_TECH_ZONE_ID,
} = process.env;

// ===============================
// VALIDATION
// ===============================
if (!AAPANEL_BASE_URL) throw new Error("❌ AAPANEL_BASE_URL missing");
if (!AAPANEL_COOKIE || !AAPANEL_TOKEN) throw new Error("❌ aaPanel auth missing");
if (!MAIL_DOMAIN || !MAIL_A_RECORD || !MAIL_SERVER_IP)
    throw new Error("❌ Mail config missing");
if (!CF_VERISENCE_TECH_TOKEN || !CF_VERISENCE_TECH_ZONE_ID)
    throw new Error("❌ Cloudflare config missing");

// ===============================
// AXIOS CLIENTS
// ===============================
const panel = axios.create({
    httpsAgent,
    timeout: 60000,
    headers: {
        "x-http-token": AAPANEL_TOKEN,
        Cookie: AAPANEL_COOKIE,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
});

const cloudflare = axios.create({
    baseURL: "https://api.cloudflare.com/client/v4",
    headers: {
        Authorization: `Bearer ${CF_VERISENCE_TECH_TOKEN}`,
        "Content-Type": "application/json",
    },
});

// ===============================
// HELPERS
// ===============================
const form = obj => {
    const f = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => f.append(k, v));
    return f.toString();
};

// ===============================
// 1️⃣ ADD MAIL DOMAIN
// ===============================
async function addMailDomain() {
    const res = await panel.post(
        `${AAPANEL_BASE_URL}/plugin?action=a&name=mail_sys&s=add_domain`,
        form({
            domain: MAIL_DOMAIN,
            a_record: MAIL_A_RECORD,
            ips: MAIL_SERVER_IP,
        })
    );

    console.log("✅ Mail domain added:", res.data);
    if (!res.data?.status) throw new Error("Mail domain add failed");
}

// ===============================
// 2️⃣ REQUEST SSL (DNS)
// ===============================
async function requestSSL() {
    const res = await panel.post(
        `${AAPANEL_BASE_URL}/plugin?action=a&name=mail_sys&s=apply_cert`,
        form({
            type: "mail",
            auth_type: "dns",
            auth_to: "dns",       // REQUIRED (aaPanel bug)
            dnsapi: "0",
            force: "1",
            auto_wildcard: "0",
            domains: JSON.stringify([MAIL_DOMAIN]),
        })
    );

    console.log("🔐 SSL order created:", res.data);

    if (!res.data?.auths || !res.data?.index) {
        throw new Error("SSL order creation failed");
    }

    return res.data;
}

// ===============================
// 3️⃣ ADD TXT TO CLOUDFLARE
// ===============================
async function addTxtToCloudflare(value) {
    await cloudflare.post(
        `/zones/${CF_VERISENCE_TECH_ZONE_ID}/dns_records`,
        {
            type: "TXT",
            name: `_acme-challenge.${MAIL_DOMAIN}`,
            content: value,
            ttl: 120,
        }
    );

    console.log(`🌐 TXT added: _acme-challenge.${MAIL_DOMAIN}`);
}

// ===============================
// ▶ MAIN FLOW
// ===============================
(async () => {
    try {
        console.log("\n🚀 aaPanel Mail + SSL Automation\n");

        // Step 1
        await addMailDomain();

        // Step 2
        const ssl = await requestSSL();

        // Step 3
        for (const auth of ssl.auths) {
            console.log(`📌 TXT required: _acme-challenge.${auth.domain}`);
            await addTxtToCloudflare(auth.auth_value);
        }

        console.log("\n⏳ IMPORTANT NEXT STEP");
        console.log("────────────────────────────");
        console.log("✔ TXT added to Cloudflare");
        console.log("✔ SSL order created");
        console.log("");
        console.log("⏱ WAIT 5–15 minutes");
        console.log("🔁 Then click: Mail Server → Refresh domain record");
        console.log("🔒 SSL will turn GREEN automatically");
        console.log("────────────────────────────\n");

    } catch (err) {
        console.error("\n❌ ERROR:", err.response?.data || err.message);
    }
})();















