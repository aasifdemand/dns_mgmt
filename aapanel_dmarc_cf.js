import axios from "axios";
import XLSX from "xlsx";
import https from "https";
import dotenv from "dotenv"


dotenv.config()

/* ================= HTTPS ================= */
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/* ================= CONFIG ================= */
const SHEET_URL = process.env.DNS_FILE_URL
const SHEET_PANEL = process.env.AAPANEL_SHEET_NAME

/* ================= FETCH DOMAIN INFO ================= */
async function getDomainFromAaPanel({ getUrl, cookie, token, domain }) {
    try {
        const res = await axios.post(
            getUrl,
            null,
            {
                httpsAgent,
                headers: {
                    "x-http-token": token,
                    Cookie: cookie,
                },
            }
        );

        console.log("\n📌 aaPanel RAW response:");
        console.dir(res.data, { depth: null });

        if (
            !res.data?.status ||
            !res.data?.msg ||
            !Array.isArray(res.data.msg.data)
        ) {
            return null;
        }

        return res.data.msg.data.find(
            d => d.domain === domain
        ) || null;

    } catch (err) {
        console.error("\n❌ aaPanel Error:");
        console.error(err.response?.data || err.message);
        return null;
    }
}

/* ================= PUSH DMARC TO CLOUDFLARE ================= */
async function pushDMARCToCloudflare({ domain, dmarc, zoneId, apiToken }) {
    try {
        let content = dmarc.trim();
        if (!content.startsWith('"')) content = `"${content}`;
        if (!content.endsWith('"')) content = `${content}"`;

        const payload = {
            type: "TXT",
            name: `_dmarc.${domain}`,
            content,
            ttl: 3600,
        };

        console.log(`➡️ Adding DMARC to Cloudflare`);
        console.log(`${payload.name} = ${payload.content}`);

        const res = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${apiToken}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (res.data?.success) {
            console.log("🎉 DMARC added to Cloudflare successfully!");
        } else {
            console.log("⚠️ Cloudflare response:");
            console.dir(res.data, { depth: null });
        }
    } catch (err) {
        console.error("\n❌ Cloudflare Error:");
        console.error(err.response?.data || err.message);
    }
}

/* ================= MAIN ================= */
(async () => {
    console.log("📥 Reading Sheet3 config...");

    const sheetRes = await axios.get(SHEET_URL, {
        responseType: "arraybuffer",
        httpsAgent,
    });

    const wb = XLSX.read(sheetRes.data);
    const rows = XLSX.utils.sheet_to_json(
        wb.Sheets[SHEET_PANEL],
        { header: 1 }
    );

    const row = rows[1];
    if (!row) throw new Error("Sheet3 is empty");

    const GET_URL = row[1];   // s=get_domains
    const COOKIE = row[2];
    const TOKEN = row[3];
    const DOMAIN = row[4];
    const CF_ZONE_ID = row[7];
    const CF_API_TOKEN = row[8];

    console.log(`📧 Domain: ${DOMAIN}`);

    const domainInfo = await getDomainFromAaPanel({
        getUrl: GET_URL,
        cookie: COOKIE,
        token: TOKEN,
        domain: DOMAIN,
    });

    if (!domainInfo) {
        console.log("❌ Domain not found in aaPanel");
        return;
    }

    console.log("\n🎯 Domain Info:");
    console.log(domainInfo);

    console.log("🚫 Skipping SPF & DKIM");

    if (domainInfo.dmarc_value) {
        console.log("🟨 DMARC found → syncing to Cloudflare...");
        await pushDMARCToCloudflare({
            domain: DOMAIN,
            dmarc: domainInfo.dmarc_value,
            zoneId: CF_ZONE_ID,
            apiToken: CF_API_TOKEN,
        });
    } else {
        console.log("❌ DMARC not found");
    }

    console.log("\n✅ DONE — DMARC synced successfully");
})();
