// import axios from "axios";
// import dotenv from "dotenv";
// import XLSX from "xlsx";
// import https from "https";
// import { GoogleGenAI } from "@google/genai";

// dotenv.config();

// /* ================= HTTPS AGENT (SELF-SIGNED FIX) ================= */
// const httpsAgent = new https.Agent({
//     rejectUnauthorized: false,
// });

// /* ================= CONFIG ================= */
// const SHEET_MAIL = "Sheet5";
// const SHEET_PANEL = "Sheet3";

// /* ================= FALLBACK NAMES ================= */
// const FALLBACK_NAMES = [
//     "John Miller",
//     "Sarah Adams",
//     "Michael Brown",
//     "Emily Clark",
//     "David Wilson",
// ];

// /* ================= GEMINI (FREE, SAFE) ================= */
// const ai = new GoogleGenAI({
//     apiKey: process.env.GEMINI_API_KEY,
// });

// async function getNames(count) {
//     try {
//         const res = await ai.models.generateContent({
//             model: "gemini-2.0-flash",
//             contents: [
//                 {
//                     role: "user",
//                     parts: [
//                         {
//                             text: `Give ${count} realistic American full names.
// Exactly two words.
// One name per line.
// No punctuation.`,
//                         },
//                     ],
//                 },
//             ],
//         });

//         console.log("✅ Names fetched from Gemini");
//         return res.text.trim().split("\n").slice(0, count);
//     } catch {
//         console.warn("⚠️ Gemini unavailable → using fallback names");
//         return FALLBACK_NAMES.slice(0, count);
//     }
// }

// /* ================= MAIN ================= */
// async function main() {
//     const sheetRes = await axios.get(process.env.DNS_FILE_URL, {
//         responseType: "arraybuffer",
//         httpsAgent,
//     });

//     const wb = XLSX.read(sheetRes.data);

//     /* ---------- SHEET3 (AAPANEL AUTH) ---------- */
//     const panelRows = XLSX.utils.sheet_to_json(
//         wb.Sheets[SHEET_PANEL],
//         { header: 1 }
//     );

//     const panel = panelRows[1];
//     const ADD_URL = panel[0];
//     const COOKIE = panel[2];
//     const TOKEN = panel[3];

//     /* ---------- SHEET5 (MAIL REQUEST) ---------- */
//     const mailRows = XLSX.utils.sheet_to_json(
//         wb.Sheets[SHEET_MAIL],
//         { header: 1 }
//     );

//     const header = mailRows[0];
//     const row = mailRows[1];

//     const domain = row[0];
//     const userCount = Number(row[1]);
//     const password = row[4];

//     console.log(`📧 Domain: ${domain}`);
//     console.log(`👤 Users: ${userCount}`);

//     const names = await getNames(userCount);
//     const output = [header];

//     for (const name of names) {
//         const username = name.toLowerCase().replace(/\s+/g, ".");
//         const email = `${username}@${domain}`;

//         console.log("Creating:", email);

//         await axios.post(
//             ADD_URL,
//             {
//                 email,
//                 password,
//                 quota: 5,
//             },
//             {
//                 headers: {
//                     Cookie: COOKIE,
//                     "X-HTTP-Token": TOKEN,
//                 },
//                 httpsAgent,
//             }
//         );

//         output.push([
//             domain,
//             userCount,
//             name,
//             email,
//             password,
//         ]);
//     }

//     wb.Sheets[SHEET_MAIL] = XLSX.utils.aoa_to_sheet(output);
//     XLSX.writeFile(wb, "sheet5_updated.xlsx");

//     console.log("✅ Users created & visible in aaPanel");
// }

// main().catch(err =>
//     console.error("❌ Error:", err.response?.data || err.message)
// );









// import axios from "axios";
// import dotenv from "dotenv";
// import XLSX from "xlsx";
// import https from "https";
// import { GoogleGenAI } from "@google/genai";

// dotenv.config();

// /* ================= HTTPS AGENT ================= */
// const httpsAgent = new https.Agent({
//     rejectUnauthorized: false,
// });

// /* ================= CONFIG ================= */
// const SHEET_MAIL = "Sheet5";
// const SHEET_PANEL = "Sheet3";

// /* ================= FALLBACK NAMES ================= */
// const FALLBACK_NAMES = [
//     "John Miller",
//     "Sarah Adams",
//     "Michael Brown",
// ];

// /* ================= GEMINI ================= */
// const ai = new GoogleGenAI({
//     apiKey: process.env.GEMINI_API_KEY,
// });

// async function getNames(count) {
//     try {
//         const res = await ai.models.generateContent({
//             model: "gemini-2.0-flash",
//             contents: [{
//                 role: "user",
//                 parts: [{
//                     text: `Give ${count} American full names. Two words only.`
//                 }]
//             }]
//         });

//         return res.text.trim().split("\n").slice(0, count);
//     } catch {
//         console.warn("⚠️ Gemini unavailable → using fallback names");
//         return FALLBACK_NAMES.slice(0, count);
//     }
// }

// /* ================= MAIN ================= */
// async function main() {
//     const res = await axios.get(process.env.DNS_FILE_URL, {
//         responseType: "arraybuffer",
//         httpsAgent,
//     });

//     const wb = XLSX.read(res.data);

//     /* ---------- SHEET3 (AAPANEL AUTH) ---------- */
//     const panel = XLSX.utils.sheet_to_json(
//         wb.Sheets[SHEET_PANEL],
//         { header: 1 }
//     )[1];

//     const BASE_URL = "https://154.38.161.176:13275";
//     const ADD_USER_URL = `${BASE_URL}/plugin?action=a&name=mail_sys&fun=add_user`;
//     const COOKIE = panel[2];
//     const TOKEN = panel[3];

//     /* ---------- SHEET5 ---------- */
//     const mailRows = XLSX.utils.sheet_to_json(
//         wb.Sheets[SHEET_MAIL],
//         { header: 1 }
//     );

//     const header = mailRows[0];
//     const row = mailRows[1];

//     const domain = row[0];
//     const userCount = Number(row[1]);
//     const password = row[4];

//     console.log(`📧 Domain: ${domain}`);
//     console.log(`👤 Users: ${userCount}`);

//     const names = await getNames(userCount);
//     const output = [header];

//     for (const name of names) {
//         const username = name.toLowerCase().replace(/\s+/g, ".");
//         const email = `${username}@${domain}`;

//         console.log("Creating:", email);

//         const response = await axios.post(
//             ADD_USER_URL,
//             {
//                 username,
//                 domain,
//                 password,
//                 quota: 5,
//             },
//             {
//                 headers: {
//                     Cookie: COOKIE,
//                     "X-HTTP-Token": TOKEN,
//                 },
//                 httpsAgent,
//             }
//         );

//         if (!response.data?.status) {
//             throw new Error(`Failed to create ${email}`);
//         }

//         output.push([domain, userCount, name, email, password]);
//     }

//     wb.Sheets[SHEET_MAIL] = XLSX.utils.aoa_to_sheet(output);
//     XLSX.writeFile(wb, "sheet5_updated.xlsx");

//     console.log("✅ Mail users CREATED successfully");
// }

// main().catch(err =>
//     console.error("❌ Error:", err.response?.data || err.message)
// );


import axios from "axios";
import dotenv from "dotenv";
import XLSX from "xlsx";
import https from "https";

dotenv.config();

/* ================= HTTPS ================= */
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

/* ================= CONFIG ================= */
const BASE_URL = "https://154.38.161.176:13275";
const SHEET_PANEL = "Sheet3";
const SHEET_MAIL = "Sheet5";
const MAX_USERS = 3;

/* ================= AAPANEL CLIENT ================= */
const api = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    timeout: 15000, // ⏱️ 15 seconds max — prevents hanging
});

/* ================= ADD MAILBOX ================= */
async function addMailbox({ email, password, cookie, token }) {
    const form = new URLSearchParams();
    form.append("username", email);   // FULL EMAIL
    form.append("password", password);
    form.append("quota", "5 GB");

    console.log("➡️ Sending request to aaPanel...");

    const res = await api.post(
        `/plugin?action=a&name=mail_sys&s=add_mailbox`,
        form,
        {
            headers: {
                Cookie: cookie,
                "X-HTTP-Token": token,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );

    console.log("⬅️ aaPanel replied");

    return res.data;
}

/* ================= MAIN ================= */
async function main() {
    const sheetRes = await axios.get(process.env.DNS_FILE_URL, {
        responseType: "arraybuffer",
        httpsAgent,
    });

    const wb = XLSX.read(sheetRes.data);

    /* ---------- Sheet3 : aaPanel auth ---------- */
    const panelRow = XLSX.utils.sheet_to_json(
        wb.Sheets[SHEET_PANEL],
        { header: 1 }
    )[1];

    if (!panelRow) throw new Error("Sheet3 is empty");

    const COOKIE = panelRow[2];
    const TOKEN = panelRow[3];

    /* ---------- Sheet5 : users ---------- */
    const rows = XLSX.utils.sheet_to_json(
        wb.Sheets[SHEET_MAIL],
        { header: 1 }
    );

    const header = rows[0];
    const domain = rows[1][0];
    const password = rows[1][3];

    console.log(`📧 Domain: ${domain}`);
    console.log(`👤 Users to create: ${MAX_USERS}`);

    const output = [header];
    let created = 0;

    for (let i = 1; i < rows.length && created < MAX_USERS; i++) {
        const name = rows[i][1];
        if (!name) continue;

        const email =
            name.toLowerCase().replace(/\s+/g, ".") + "@" + domain;

        console.log("\nCreating:", email);

        try {
            const result = await addMailbox({
                email,
                password,
                cookie: COOKIE,
                token: TOKEN,
            });

            console.log("📨 aaPanel response:", result);

            if (result.status === true) {
                console.log("✅ Created:", email);
                created++;
            } else if (result.msg?.toLowerCase().includes("exist")) {
                console.log("⚠️ Already exists:", email);
                created++;
            } else {
                console.log("❌ aaPanel error:", result.msg || result);
                continue;
            }

            output.push([domain, name, email, password]);

        } catch (err) {
            if (err.code === "ECONNABORTED") {
                console.log("⏱️ Timeout — aaPanel did not respond");
            } else {
                console.log(
                    "❌ Request failed:",
                    err.response?.data || err.message
                );
            }
            break; // stop safely
        }
    }

    wb.Sheets[SHEET_MAIL] = XLSX.utils.aoa_to_sheet(output);
    XLSX.writeFile(wb, "sheet5_updated.xlsx");

    console.log(`\n✅ Finished. ${created} users processed.`);
}

main();
