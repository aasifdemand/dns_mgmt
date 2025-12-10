require("dotenv").config();
const axios = require("axios");
const XLSX = require("xlsx");
const fs = require("fs");
const https = require("https");

// 🌍 Cloudflare Config
const API = `https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}/dns_records`;
const TOKEN = process.env.CLOUDFLARE_TOKEN;

// 📌 Local DNS file (XLSX)
const DNS_FILE = "./dns_test_records.xlsx";

// 🤝 Cloudflare headers
const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
};

// 🌐 HTTPS agent
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// 📥 Load XLSX
function loadRecords() {
    if (!fs.existsSync(DNS_FILE)) {
        throw new Error(`DNS file not found: ${DNS_FILE}`);
    }

    const workbook = XLSX.readFile(DNS_FILE);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    return rows;
}

// 🛰 Create a DNS record in Cloudflare
async function createRecord(row) {
    try {
        const type = String(row.type || row.Type || "").trim();
        const name = String(row.name || row.Name || "").trim();
        const content = String(row.content || row.Content || "").trim();
        const priority = row.priority || row.Priority;

        if (!type || !name || !content) {
            console.log("⚠️ Skipping invalid row (missing required fields):", row);
            return;
        }

        const payload = {
            type,
            name,
            content,
            ttl: 3600,
        };

        if (type === "MX" && priority !== undefined && priority !== null && priority !== "") {
            payload.priority = Number(priority);
        }

        console.log(`➡️ Creating ${type} ${name} → ${content}${payload.priority ? " (prio " + payload.priority + ")" : ""}`);

        const res = await axios.post(API, payload, { headers, httpsAgent });

        if (res.data && res.data.success) {
            console.log(`✔️ Added ${type} ${name}`);
        } else {
            console.log(`❌ Cloudflare error for ${type} ${name}:`, res.data);
        }
    } catch (err) {
        console.log(`❌ Failed ${row.type || row.Type} ${row.name || row.Name}`);
        console.log(err.response?.data || err.message);
    }
}

// 🚀 Main
(async () => {
    try {
        console.log("📥 Loading DNS records from file:", DNS_FILE);
        const rows = loadRecords();
        console.log(`📌 Total rows in sheet: ${rows.length}`);

        for (const row of rows) {
            await createRecord(row);
        }

        console.log("\n🎉 DONE! All DNS entries processed.\n");
    } catch (err) {
        console.error("❌ Fatal:", err.message);
    }
})();
