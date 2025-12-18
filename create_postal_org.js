import "dotenv/config";
import { Client } from "ssh2";
import axios from "axios";
import XLSX from "xlsx";

/* --------------------------------------------------
   Load Postal server + org from Sheet2
-------------------------------------------------- */
async function loadPostalAndOrgFromSheet() {
    const { DNS_FILE_URL, POSTAL_SHEET_NAME, TARGET_POSTAL_DOMAIN } = process.env;

    if (!DNS_FILE_URL) throw new Error("DNS_FILE_URL missing");
    if (!POSTAL_SHEET_NAME) throw new Error("POSTAL_SHEET_NAME missing");
    if (!TARGET_POSTAL_DOMAIN) throw new Error("TARGET_POSTAL_DOMAIN missing");

    console.log(`📄 Reading from sheet: ${POSTAL_SHEET_NAME}`);
    console.log(`🎯 Target Postal domain: ${TARGET_POSTAL_DOMAIN}`);

    const res = await axios.get(DNS_FILE_URL, { responseType: "arraybuffer" });
    const wb = XLSX.read(res.data, { type: "buffer" });

    const sheet = wb.Sheets[POSTAL_SHEET_NAME];
    if (!sheet) throw new Error(`Sheet not found: ${POSTAL_SHEET_NAME}`);

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const row = rows.find(r => r.POSTAL_DOMAIN?.trim() === TARGET_POSTAL_DOMAIN);

    if (!row) throw new Error(`No row found for ${TARGET_POSTAL_DOMAIN}`);

    const postalDomain = row.POSTAL_DOMAIN.trim();

    // postal.verisence.tech → verisence
    const orgName = postalDomain.replace(/^postal\./i, "").split(".")[0];

    if (!orgName) throw new Error("Failed to derive organization name");

    return {
        host: row.HOST.trim(),
        user: row.SSH_USER.trim(),
        password: row.SSH_PASSWORD.toString().trim(),
        orgName,
    };
}

/* --------------------------------------------------
   SSH connect
-------------------------------------------------- */
function connectSSH(server) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn
            .on("ready", () => {
                console.log("✅ SSH connected");
                resolve(conn);
            })
            .on("error", reject)
            .connect({
                host: server.host,
                username: server.user,
                password: server.password,
                readyTimeout: 30000,
            });
    });
}

/* --------------------------------------------------
   Create organization (NON-INTERACTIVE, REAL)
-------------------------------------------------- */
async function createOrganization(conn, orgName) {
    const cmd = `
export DOCKER_API_VERSION=1.44

docker exec postal-web-1 rails runner "
owner = User.order(:id).first
raise 'No users exist' unless owner

org = Organization.find_or_create_by!(
  name: '${orgName}',
  permalink: '${orgName}',
  owner: owner
)

puts 'ORG_CREATED=' + org.name
puts 'ORG_ID=' + org.id.to_s
puts 'ORG_OWNER=' + owner.email_address
"
`;

    return new Promise((resolve, reject) => {
        conn.exec(cmd, { pty: false }, (err, stream) => {
            if (err) return reject(err);

            let output = "";

            stream.on("data", d => {
                output += d.toString();
                process.stdout.write(d);
            });

            // Log stderr but DO NOT fail on it
            stream.stderr.on("data", d => {
                process.stderr.write(d);
            });

            stream.on("close", code => {
                if (!output.includes("ORG_CREATED=")) {
                    reject(new Error("Organization was NOT created"));
                } else {
                    resolve();
                }
            });
        });
    });
}

/* --------------------------------------------------
   MAIN
-------------------------------------------------- */
async function main() {
    try {
        console.log("📥 Loading Postal + Org info from Sheet2");
        const server = await loadPostalAndOrgFromSheet();

        console.log(`🏢 Organization to ensure: ${server.orgName}`);

        const conn = await connectSSH(server);
        try {
            await createOrganization(conn, server.orgName);
        } finally {
            conn.end();
        }

        console.log("\n🎉 Organization CREATED successfully");
        console.log(`➡️ https://postal.${server.orgName}.tech/org/${server.orgName}`);
    } catch (err) {
        console.error("❌ ERROR:", err.message);
        process.exit(1);
    }
}

main();
