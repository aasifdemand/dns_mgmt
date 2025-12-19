import { chromium } from "playwright";
import axios from "axios";
import XLSX from "xlsx";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

/* ---------------- CONFIG ---------------- */

const SHEET_URL = process.env.DNS_SHEET_URL
const SHEET_NAME = process.env.INSTANTLY_SHEET_NAME || "Sheet6";

/* ---------------- CLI ---------------- */

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));

/* ---------------- HELPERS ---------------- */

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function parseName(email) {
    const local = email.split("@")[0];
    const parts = local.split(/[._-]/);
    return {
        first: cap(parts[0] || "User"),
        last: cap(parts[1] || "Account")
    };
}

async function forceFill(page, selector, value) {
    await page.waitForSelector(selector, { timeout: 60000 });
    await page.evaluate(
        ({ selector, value }) => {
            const el = document.querySelector(selector);
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
        },
        { selector, value }
    );
}

/* ---------------- LOAD INSTANTLY CREDS ---------------- */

async function loadInstantlyCreds() {
    const res = await axios.get(SHEET_URL, { responseType: "arraybuffer" });
    const wb = XLSX.read(res.data, { type: "buffer" });
    const sheet = wb.Sheets[SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const row = rows[0];
    const email = row.INSTANTLY_EMAIL;
    const password = row.INSTANTLY_PASSWORD;

    if (!email || !password) {
        throw new Error("INSTANTLY_EMAIL / INSTANTLY_PASSWORD missing in Sheet6");
    }

    return { email, password };
}

/* ---------------- LOGIN ---------------- */

async function login(page, creds) {
    await page.goto("https://app.instantly.ai/auth/login", {
        waitUntil: "domcontentloaded"
    });

    await forceFill(page, "input[type=email]", creds.email);
    await forceFill(page, "input[type=password]", creds.password);
    await page.click("button[type=submit]");

    await Promise.race([
        page.waitForSelector("input[type=email]", { state: "detached" }),
        page.waitForSelector("text=/accounts|campaigns/i")
    ]);
}

/* ---------------- FLOW ---------------- */

async function navigateToConnect(page) {
    await page.goto("https://app.instantly.ai/app/accounts", {
        waitUntil: "domcontentloaded"
    });

    await page.locator("text=Add New").click();
    await page.waitForURL("**/app/account/connect");

    await page.locator("text=/imap\\s*\\/\\s*smtp/i").click();
    await page.locator("text=/single account/i").click();

    await page.waitForURL("**/account/connect?provider=custom");
}

/* ---------------- EMAIL SCREEN ---------------- */

async function fillEmailScreen(page, email) {
    const { first, last } = parseName(email);

    await forceFill(page, "input[placeholder='First Name']", first);
    await forceFill(page, "input[placeholder='Last Name']", last);
    await forceFill(
        page,
        "input[placeholder='Email address to connect']",
        email
    );

    await page.locator("button:has-text('Next')").click();
}

/* ---------------- IMAP ---------------- */

async function fillImap(page, email, imapPass) {
    const domain = email.split("@")[1];

    await forceFill(page, "input[placeholder='IMAP Username']", email);
    await forceFill(page, "input[placeholder='IMAP Password']", imapPass);
    await forceFill(
        page,
        "input[placeholder='imap.website.com']",
        `mail.${domain}`
    );

    await page.locator("button:has-text('Next')").click();
}

/* ---------------- SMTP ---------------- */

async function fillSmtp(page, email, smtpPass) {
    const domain = email.split("@")[1];

    await forceFill(page, "input[placeholder='SMTP Username']", email);
    await forceFill(page, "input[placeholder='SMTP Password']", smtpPass);
    await forceFill(
        page,
        "input[placeholder='smtp.website.com']",
        `postal.${domain}`
    );

    await page.locator("button:has-text('Connect Account')").click();
}

/* ---------------- MAIN ---------------- */

(async () => {
    try {
        const email = await ask("Enter email to connect: ");
        const imapPass = await ask("Enter IMAP password: ");
        const smtpPass = await ask("Enter SMTP password: ");
        rl.close();

        const instantlyCreds = await loadInstantlyCreds();

        const browser = await chromium.launch({
            headless: false,
            slowMo: 200
        });

        const page = await browser.newPage();

        await login(page, instantlyCreds);
        await navigateToConnect(page);
        await fillEmailScreen(page, email);
        await fillImap(page, email, imapPass);
        await fillSmtp(page, email, smtpPass);

        console.log("🎉 Account connected successfully");

        // ✅ CLOSE BROWSER AFTER SUCCESS
        await page.waitForTimeout(3000);
        await browser.close();

    } catch (err) {
        console.error("❌ Automation failed:", err.message);
    }
})();
