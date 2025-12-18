import dotenv from 'dotenv';
import axios from 'axios';
import XLSX from 'xlsx';
import https from 'https';


dotenv.config()

/* ===================== CONFIG ===================== */

const DNS_FILE_URL = process.env.DNS_FILE_URL;
const DNS_SHEET_NAME = process.env.DNS_SHEET_NAME || "Sheet1";

if (!DNS_FILE_URL) {
    console.error("❌ DNS_FILE_URL is required");
    process.exit(1);
}

const TARGET_DOMAINS = process.env.TARGET_DOMAINS
    ? process.env.TARGET_DOMAINS.split(",").map(d => d.trim())
    : null;

/* ===================== HTTP ===================== */

const httpsAgent = new https.Agent({ keepAlive: true });

const cfHeaders = token => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
});

/* ===================== CONFIRM PROMPT ===================== */

function askConfirmation() {
    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question(
            "\n⚠️  Proceed with Cloudflare DNS updates? (yes/no): ",
            answer => {
                rl.close();
                resolve(answer.trim().toLowerCase() === "yes");
            }
        );
    });
}

/* ===================== LOAD SHEET ===================== */

async function loadSheet(url) {
    console.log(`🌐 Fetching DNS sheet → ${DNS_SHEET_NAME}`);

    const res = await axios.get(url, {
        responseType: "arraybuffer",
        httpsAgent,
    });

    const workbook = XLSX.read(res.data, { type: "buffer" });

    if (!workbook.SheetNames.includes(DNS_SHEET_NAME)) {
        throw new Error(
            `Sheet "${DNS_SHEET_NAME}" not found. Available: ${workbook.SheetNames.join(", ")}`
        );
    }

    const sheet = workbook.Sheets[DNS_SHEET_NAME];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

/* ===================== HELPERS ===================== */

function normalizeName(rawName, domain) {
    return rawName.includes(".") ? rawName : `${rawName}.${domain}`;
}

/* ===================== CHECK EXISTING ===================== */

async function recordExists(zoneId, token, payload) {
    const res = await axios.get(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
            headers: cfHeaders(token),
            httpsAgent,
            params: {
                type: payload.type,
                name: payload.name,
            },
        }
    );

    if (!res.data?.success) return false;

    return res.data.result.some(r => {
        if (r.type !== payload.type) return false;
        if (r.name !== payload.name) return false;
        if (r.content !== payload.content) return false;
        if (payload.type === "MX") {
            return Number(r.priority) === Number(payload.priority);
        }
        return true;
    });
}

/* ===================== MAIN ===================== */

(async () => {
    try {
        console.log("📥 Loading DNS records from Google Sheet");
        if (TARGET_DOMAINS) {
            console.log(`🎯 Target domains: ${TARGET_DOMAINS.join(", ")}`);
        }

        const rows = await loadSheet(DNS_FILE_URL);

        const context = {
            domain: "",
            zoneId: "",
            token: "",
        };

        const planned = [];

        /* ===================== PARSE & PLAN ===================== */

        for (const row of rows) {
            if (row.Domain && row.Domain.trim() !== "") {
                context.domain = row.Domain.trim();
            }
            if (row.zone_id && row.zone_id.trim() !== "") {
                context.zoneId = row.zone_id.trim();
            }
            if (row.token && row.token.trim() !== "") {
                context.token = row.token.trim();
            }

            if (!context.domain || !context.zoneId || !context.token) continue;
            if (TARGET_DOMAINS && !TARGET_DOMAINS.includes(context.domain)) continue;

            const type = String(row.type || "").toUpperCase().trim();
            const rawName = String(row.Name || "").trim();
            const content = String(row.content || row.Content || "").trim();

            if (!type || !rawName || !content) continue;

            const payload = {
                type,
                name: normalizeName(rawName, context.domain),
                content,
                ttl: 3600,
            };

            if (type === "MX") {
                payload.priority = Number(row.priority || row.Priority || 10);
            }

            planned.push({
                domain: context.domain,
                zoneId: context.zoneId,
                token: context.token,
                payload,
            });
        }

        /* ===================== PREVIEW ===================== */

        console.log("\n🔎 PREVIEW – DNS OPERATIONS TO APPLY\n");

        if (planned.length === 0) {
            console.log("❌ No DNS records parsed from the sheet. Exiting safely.");
            process.exit(0);
        }

        const grouped = {};
        for (const r of planned) {
            if (!grouped[r.domain]) grouped[r.domain] = [];
            grouped[r.domain].push(r);
        }

        for (const [domain, records] of Object.entries(grouped)) {
            console.log(`Domain: ${domain}`);
            console.log(`Zone ID: ${records[0].zoneId}`);
            console.log("Records:");

            for (const r of records) {
                const p = r.payload;
                const extra = p.type === "MX" ? ` (priority ${p.priority})` : "";
                console.log(
                    `  ${p.type.padEnd(6)} ${p.name.padEnd(35)} → ${p.content}${extra}`
                );
            }
            console.log("");
        }

        console.log(`Total records planned: ${planned.length}`);
        console.log("⚠️  No changes have been made yet.");

        /* ===================== CONFIRM ===================== */

        const confirmed = await askConfirmation();

        if (!confirmed) {
            console.log("❌ Aborted by user. No DNS changes applied.");
            process.exit(0);
        }

        /* ===================== APPLY ===================== */

        console.log("\n🚀 Applying DNS changes to Cloudflare\n");

        for (const r of planned) {
            try {
                if (await recordExists(r.zoneId, r.token, r.payload)) {
                    console.log(`⏭️  ${r.payload.type} ${r.payload.name} already exists`);
                    continue;
                }

                await axios.post(
                    `https://api.cloudflare.com/client/v4/zones/${r.zoneId}/dns_records`,
                    r.payload,
                    {
                        headers: cfHeaders(r.token),
                        httpsAgent,
                    }
                );

                console.log(`✔️  Created ${r.payload.type} ${r.payload.name}`);
            } catch (err) {
                console.error(`❌ Failed ${r.payload.type} ${r.payload.name}`);
                const errors = err.response?.data?.errors;
                if (Array.isArray(errors)) {
                    errors.forEach(e =>
                        console.error(`   → Cloudflare error: ${e.message}`)
                    );
                } else {
                    console.error(`   → ${err.message}`);
                }
            }
        }

        console.log("\n🎉 DNS provisioning completed");
    } catch (err) {
        console.error("❌ Fatal:", err.message);
        process.exit(1);
    }
})();
