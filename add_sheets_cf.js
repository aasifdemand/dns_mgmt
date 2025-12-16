require("dotenv").config();
const axios = require("axios");
const XLSX = require("xlsx");
const https = require("https");

/* ===================== CONFIG ===================== */

const DNS_FILE_URL = process.env.DNS_FILE_URL;
if (!DNS_FILE_URL) {
    console.error("❌ DNS_FILE_URL is required");
    process.exit(1);
}

const TARGET_DOMAINS = process.env.TARGET_DOMAINS
    ? process.env.TARGET_DOMAINS.split(",").map(d => d.trim())
    : null;

/* ===================== HTTP ===================== */

const httpsAgent = new https.Agent({ keepAlive: true });

function cfHeaders(token) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
    };
}

/* ===================== BUILD ACCOUNTS FROM ENV ===================== */
/*
Expected env format:

CF_VERISENCE_TECH_DOMAIN=verisence.tech
CF_VERISENCE_TECH_ZONE_ID=xxxx
CF_VERISENCE_TECH_TOKEN=yyyy
*/

function buildAccountsFromEnv() {
    const accounts = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith("CF_") || !key.endsWith("_DOMAIN")) continue;

        const prefix = key.replace("_DOMAIN", "");
        const domain = value.trim();

        const zoneId = process.env[`${prefix}_ZONE_ID`];
        const token = process.env[`${prefix}_TOKEN`];

        if (!zoneId || !token) {
            throw new Error(`Missing ZONE_ID or TOKEN for ${domain}`);
        }

        accounts[domain] = { zoneId, token };
    }

    if (Object.keys(accounts).length === 0) {
        throw new Error("No Cloudflare domain configs found in env");
    }

    return accounts;
}

const ACCOUNTS = buildAccountsFromEnv();

/* ===================== LOAD SHEET FROM URL ===================== */

async function loadRecordsFromUrl(url) {
    console.log("🌐 Fetching DNS sheet from URL");

    const res = await axios.get(url, {
        responseType: "arraybuffer",
        httpsAgent,
    });

    const workbook = XLSX.read(res.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

/* ===================== CHECK EXISTING RECORD ===================== */

async function recordExists(domain, record) {
    const { zoneId, token } = ACCOUNTS[domain];

    const res = await axios.get(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
            headers: cfHeaders(token),
            httpsAgent,
            params: {
                type: record.type,
                name: record.name,
            },
        }
    );

    if (!res.data?.success) return false;

    return res.data.result.some(r => {
        if (r.type !== record.type) return false;
        if (r.name !== record.name) return false;
        if (r.content !== record.content) return false;

        if (record.type === "MX") {
            return Number(r.priority) === Number(record.priority);
        }

        return true;
    });
}

/* ===================== CREATE RECORD ===================== */

async function createRecord(domain, row) {
    const type = String(row.Type || row.type).toUpperCase().trim();
    const name = String(row.Name || "").trim();
    const content = String(row.Content || row.content).trim();
    const priority = row.Priority || row.priority || 10;

    if (!type || !name || !content) {
        console.warn("⚠️ Skipping invalid row:", row);
        return;
    }

    if (TARGET_DOMAINS && !TARGET_DOMAINS.includes(domain)) {
        return;
    }

    const account = ACCOUNTS[domain];
    if (!account) {
        console.warn(`⚠️ No Cloudflare account configured for ${domain}`);
        return;
    }

    const payload = {
        type,
        name,
        content,
        ttl: 3600,
    };

    if (type === "MX") payload.priority = Number(priority);

    if (await recordExists(domain, payload)) {
        console.log(`⏭️  [${domain}] ${type} ${name} already exists`);
        return;
    }

    console.log(`➡️  [${domain}] ${type} ${name}`);

    await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${account.zoneId}/dns_records`,
        payload,
        {
            headers: cfHeaders(account.token),
            httpsAgent,
        }
    );

    console.log(`✔️  Created ${type} ${name}`);
}

/* ===================== MAIN ===================== */

(async () => {
    try {
        console.log(`📥 Loading DNS records from URL`);
        if (TARGET_DOMAINS) {
            console.log(`🎯 Target domains: ${TARGET_DOMAINS.join(", ")}`);
        }

        const rows = await loadRecordsFromUrl(DNS_FILE_URL);

        let currentDomain = "";

        for (const row of rows) {
            // IMPORTANT: inherit domain when cell is blank
            if (row.Domain) {
                currentDomain = row.Domain.trim();
            }

            if (!currentDomain) continue;

            await createRecord(currentDomain, row);
        }

        console.log("\n🎉 DNS provisioning completed successfully");
    } catch (err) {
        console.error("❌ Fatal:", err.message);
        process.exit(1);
    }
})();
