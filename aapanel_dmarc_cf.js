require("dotenv").config();
const axios = require("axios");
const https = require("https");

// ===============================
// 🌍 CONFIG FROM .env
// ===============================
const PANEL_URL = process.env.AAPANEL_GETURL; // https://IP:PORT/plugin?action=a&name=mail_sys
const COOKIE = process.env.AAPANEL_COOKIE;
const X_HTTP_TOKEN = process.env.AAPANEL_TOKEN;
const DOMAIN = process.env.MAIL_DOMAIN;

// 🌩 CLOUDFLARE CONFIG
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CF_TOKEN = process.env.CLOUDFLARE_TOKEN;

// ===============================
// 🔐 ALLOW SELF-SIGNED SSL
// ===============================
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ===============================
// 📥 FETCH DOMAIN INFO FROM AAPANEL
// ===============================
async function getDomainDNS(domain) {
    try {
        const url = `${PANEL_URL}&s=get_domain_dns`;

        const form = new URLSearchParams();
        form.append("domain", domain);

        const res = await axios.post(url, form.toString(), {
            httpsAgent,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-http-token": X_HTTP_TOKEN,
                Cookie: COOKIE,
            },
        });

        console.log("\n📌 RAW Response:", JSON.stringify(res.data, null, 4));

        if (!res.data?.status || !res.data?.msg?.data?.length) return null;

        const row = res.data.msg.data[0];
        console.log("\n📌 Parsed domain info:", JSON.stringify(row, null, 4));

        return {
            dkim: row.dkim_value || null,
            dmarc: row.dmarc_value || null,
            spf: row.spf_value || null,
            spfStatus: row.spf_status,
        };
    } catch (err) {
        console.error("\n❌ aaPanel DNS Error:", err.response?.data || err.message);
        return null;
    }
}

// ===============================
// ☁️ PUSH ONLY DMARC TO CLOUDFLARE
// ===============================
async function pushDMARCToCloudflare(dmarcValue) {
    try {
        // ✨ Ensure DMARC content has double quotes
        let content = dmarcValue.trim();
        if (!content.startsWith(`"`)) content = `"${content}`;
        if (!content.endsWith(`"`)) content = `${content}"`;

        const payload = {
            type: "TXT",
            name: `_dmarc.${DOMAIN}`,
            content,
            ttl: 3600,
        };

        console.log(`➡️ Adding DMARC to Cloudflare: ${payload.name} = ${payload.content}`);

        const res = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${CF_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (res.data.success) {
            console.log(`🎉 DMARC added to Cloudflare successfully!`);
        } else {
            console.log(`⚠️ Could not add DMARC:`, res.data);
        }
    } catch (e) {
        console.error(`❌ Cloudflare DMARC Error:`, e.response?.data || e.message);
    }
}

// ===============================
// ▶ MAIN
// ===============================
(async () => {
    const result = await getDomainDNS(DOMAIN);

    console.log("\n🎯 Extracted Records:");
    if (!result) return console.log("❌ No DNS data found!");

    const { dmarc } = result;

    // ❌ Skip DKIM and SPF completely ✔️
    console.log("🚫 Skipping DKIM and SPF sync");

    // 🟨 DMARC
    if (dmarc) {
        console.log(`🟨 DMARC found. Adding to Cloudflare...`);
        await pushDMARCToCloudflare(dmarc);
    } else {
        console.log(`❌ DMARC: Not found`);
    }

    console.log("\n🌍 DONE syncing DMARC ➝ Cloudflare 🚀");
})();
