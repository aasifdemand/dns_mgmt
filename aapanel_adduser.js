import axios from "axios";
import XLSX from "xlsx";
import https from "https";
import readline from "readline";
import dotenv from "dotenv";

dotenv.config();



const DNS_FILE_URL = process.env.DNS_FILE_URL;
const SHEET_NAME = process.env.AAPANEL_SHEET_NAME;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/* ================= LOAD CREDENTIALS FROM SHEET3 ================= */

async function loadCredentials() {
    console.log("📥 Loading aaPanel credentials from Sheet3...");
    
    const res = await axios.get(DNS_FILE_URL, {
        responseType: "arraybuffer",
        httpsAgent,
    });

    const wb = XLSX.read(res.data, { type: "buffer" });

    if (!wb.SheetNames.includes(SHEET_NAME)) {
        throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(", ")}`);
    }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_NAME], { defval: "" });
    
    if (rows.length === 0) {
        throw new Error("No data found in Sheet3");
    }

    // Get first row
    const credentials = rows[0];
    
    // Extract needed fields
    const {
        AAPANEL_ADDURL,
        AAPANEL_COOKIE,
        AAPANEL_TOKEN,
        MAIL_DOMAIN
    } = credentials;

    if (!AAPANEL_ADDURL || !AAPANEL_COOKIE || !AAPANEL_TOKEN || !MAIL_DOMAIN) {
        throw new Error("Missing required credentials in Sheet3");
    }

    // Extract base URL
    const baseUrl = AAPANEL_ADDURL.split('/plugin')[0];
    
    return {
        baseUrl,
        cookie: AAPANEL_COOKIE,
        token: AAPANEL_TOKEN,
        defaultDomain: MAIL_DOMAIN
    };
}

/* ================= INTERACTIVE USER INPUT ================= */

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim());
        });
    });
}

/* ================= AAPANEL USER ADD ================= */

function createPanelClient(baseUrl, cookie, token) {
    return axios.create({
        baseURL: baseUrl,
        httpsAgent,
        timeout: 60000,
        headers: {
            "x-http-token": token,
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
    });
}

async function addUser(panel, userData) {
    try {
        const {
            domain,
            username,
            password,
            quota_gb = 5,
            full_name = "",
            is_admin = 0
        } = userData;

        const endpoint = `/plugin?action=a&name=mail_sys&s=add_mailbox`;
        
        const formData = {
            domain: domain,
            quota: `${quota_gb} GB`,
            username: username,
            password: password,
            full_name: full_name,
            is_admin: is_admin.toString()
        };

        console.log(`\n📤 Sending to aaPanel...`);
        
        const res = await panel.post(endpoint, form(formData));

        console.log(`📨 Response:`);
        console.log(JSON.stringify(res.data, null, 2));

        if (res.data?.status === true) {
            console.log(`\n✅ SUCCESS: ${res.data.msg}`);
            return true;
        } else {
            console.log(`\n❌ FAILED`);
            return false;
        }
    } catch (err) {
        console.error(`\n❌ ERROR:`, err.response?.data || err.message);
        return false;
    }
}

function form(obj) {
    const f = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => f.append(k, v));
    return f.toString();
}

/* ================= MAIN INTERACTIVE SCRIPT ================= */

(async () => {
    try {
        console.log("=".repeat(60));
        console.log("🚀 AA-PANEL MAIL USER CREATION");
        console.log("(Credentials from Sheet3 + Interactive User Input)");
        console.log("=".repeat(60));
        
        // 1. Load credentials from Sheet3
        const credentials = await loadCredentials();
        
        console.log("\n✅ Credentials loaded from Sheet3:");
        console.log(`   Domain: ${credentials.defaultDomain}`);
        console.log(`   aaPanel: ${credentials.baseUrl}`);
        
        // 2. Create panel client
        const panel = createPanelClient(credentials.baseUrl, credentials.cookie, credentials.token);
        
        let continueAdding = true;
        
        while (continueAdding) {
            console.log("\n" + "=".repeat(40));
            console.log("👤 ENTER USER DETAILS");
            console.log("=".repeat(40));
            
            // Get user details interactively
            const email = await askQuestion(`📧 Email Address [@${credentials.defaultDomain}]: `);
            
            // Use default domain if not specified
            let username, domain;
            if (email.includes('@')) {
                username = email;
                [domain] = email.split('@').slice(-1);
            } else {
                username = `${email}@${credentials.defaultDomain}`;
                domain = credentials.defaultDomain;
            }
            
            const password = await askQuestion("🔑 Password: ");
            const fullName = await askQuestion("👤 Full Name (optional): ");
            const quotaStr = await askQuestion("💾 Quota in GB [5]: ") || "5";
            const isAdminStr = await askQuestion("👑 Is Admin? (0=No, 1=Yes) [0]: ") || "0";
            
            const quota = parseInt(quotaStr) || 5;
            const isAdmin = (isAdminStr === "1" || isAdminStr.toLowerCase() === "yes") ? 1 : 0;
            
            // Show summary
            console.log("\n📋 USER SUMMARY:");
            console.log("-".repeat(30));
            console.log(`Email: ${username}`);
            console.log(`Domain: ${domain}`);
            console.log(`Full Name: ${fullName || "(not specified)"}`);
            console.log(`Quota: ${quota} GB`);
            console.log(`Admin: ${isAdmin ? "Yes" : "No"}`);
            
            const confirm = await askQuestion("\n✅ Add this user? (y/n): ");
            
            if (confirm.toLowerCase() === 'y') {
                const userData = {
                    domain: domain,
                    username: username,
                    password: password,
                    quota_gb: quota,
                    full_name: fullName || username.split('@')[0].replace(/[._]/g, ' '),
                    is_admin: isAdmin
                };
                
                const success = await addUser(panel, userData);
                
                if (success) {
                    console.log("\n🎉 User added successfully!");
                } else {
                    console.log("\n⚠️ Failed to add user.");
                }
            } else {
                console.log("\n⏭️ User creation cancelled.");
            }
            
            const another = await askQuestion("\n➕ Add another user? (y/n): ");
            continueAdding = (another.toLowerCase() === 'y');
        }
        
        console.log("\n" + "=".repeat(50));
        console.log("🎉 Script completed!");
        console.log("=".repeat(50));
        
        rl.close();
        
    } catch (err) {
        console.error("\n❌ ERROR:", err.message);
        if (err.response) {
            console.error("Response:", err.response.data);
        }
        process.exit(1);
    }
})();