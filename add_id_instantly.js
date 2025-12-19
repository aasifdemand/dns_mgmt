import dotenv from "dotenv";
import { chromium } from "playwright";
import readline from "readline";
import fs from "fs";

dotenv.config();

/* ---------------- CLI ---------------- */
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
    let browser;

    try {
        console.log("🚀 Instantly Inbox Automation");
        console.log("=".repeat(50));

        const email = await ask("Warmup email: ");
        const domain = email.split("@")[1];
        const imapPassword = await ask("IMAP password: ");
        const smtpPassword = await ask("SMTP password: ");

        /* ---------- Launch Browser ---------- */
        browser = await chromium.launch({
            headless: process.env.HEADLESS === "true",
        });

        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        });

        const page = await context.newPage();

        /* ---------- LOGIN ---------- */
        console.log("🔐 Logging into Instantly...");
        await page.goto("https://app.instantly.ai/auth/login", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });

        await page.waitForSelector('input[type="email"]', { timeout: 60000 });
        await page.fill('input[type="email"]', process.env.INSTANTLY_EMAIL);
        await page.fill('input[type="password"]', process.env.INSTANTLY_PASSWORD);
        await page.click('button[type="submit"]');

        await page.waitForURL("**/app/**", { timeout: 60000 });
        console.log("✅ Login successful");

        /* ---------- ACTIVATE WORKSPACE (REAL UI HYDRATION) ---------- */
        console.log("📂 Opening Accounts page to activate workspace...");
        await page.goto("https://app.instantly.ai/app/accounts", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });

        // Wait for React to hydrate (generic but reliable)
        await page.waitForFunction(() => {
            // page is on /app/accounts and DOM has populated
            return (
                location.pathname.includes("/app/accounts") &&
                document.querySelectorAll("div").length > 50
            );
        }, { timeout: 60000 });

        // Extra buffer for hooks/state
        await page.waitForTimeout(5000);

        /* ---------- ADD INBOX (PAGE CONTEXT FETCH) ---------- */
        console.log("📨 Adding inbox via page context…");

        const result = await page.evaluate(async (payload) => {
            const res = await fetch("/api-alt/account/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                credentials: "include", // 🔑 critical
            });
            return res.json();
        }, {
            firstName: email.split("@")[0],
            lastName: "Inbox",
            provider: "custom_imap_smtp",
            email,

            imap_username: email,
            imap_password: imapPassword,
            imap_host: `mail.${domain}`,
            imap_port: 993,

            smtp_username: email,
            smtp_password: smtpPassword,
            smtp_host: `postal.${domain}`,
            smtp_port: 587,
        });

        const file = `instantly_${email.replace(/[@.]/g, "_")}.json`;
        fs.writeFileSync(file, JSON.stringify(result, null, 2));

        if (result?.error) {
            throw new Error(JSON.stringify(result));
        }

        console.log("🎉 Inbox added successfully");
        console.log(`📄 Saved: ${file}`);

    } catch (err) {
        console.error("❌ Failed:", err.message);
    } finally {
        rl.close();
        if (browser) await browser.close();
    }
})();
