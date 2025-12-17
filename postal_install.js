// import "dotenv/config";
// import { Client } from "ssh2";
// import inquirer from "inquirer";

// /* --------------------------------------------------
//    Prompt admin details (LOCAL)
// -------------------------------------------------- */
// async function promptAdmin() {
//         return inquirer.prompt([
//                 {
//                         type: "input",
//                         name: "email",
//                         message: "Admin email:",
//                         validate: (v) => v.includes("@") || "Invalid email",
//                 },
//                 {
//                         type: "input",
//                         name: "firstName",
//                         message: "First name:",
//                 },
//                 {
//                         type: "input",
//                         name: "lastName",
//                         message: "Last name:",
//                 },
//                 {
//                         type: "password",
//                         name: "password",
//                         message: "Initial admin password (min 8 chars):",
//                         mask: "*",
//                         validate: (v) =>
//                                 v.length >= 8 || "Password must be at least 8 characters",
//                 },
//         ]);
// }

// /* --------------------------------------------------
//    SSH connection (hardened)
// -------------------------------------------------- */
// function connectSSH() {
//         return new Promise((resolve, reject) => {
//                 const conn = new Client();

//                 conn
//                         .on("ready", () => {
//                                 console.log("✅ SSH connected");
//                                 resolve(conn);
//                         })
//                         .on("error", reject)
//                         .connect({
//                                 host: process.env.HOST,
//                                 username: process.env.SSH_USER,
//                                 password: process.env.SSH_PASSWORD,
//                                 keepaliveInterval: 10_000,
//                                 keepaliveCountMax: 5,
//                                 readyTimeout: 60_000,
//                         });
//         });
// }

// /* --------------------------------------------------
//    Exec helper (safe for long commands)
// -------------------------------------------------- */
// function exec(conn, command, label) {
//         return new Promise((resolve, reject) => {
//                 console.log(`\n▶ ${label}`);

//                 conn.exec(
//                         command,
//                         { pty: true, env: { TERM: "xterm" } },
//                         (err, stream) => {
//                                 if (err) return reject(err);

//                                 let finished = false;

//                                 stream
//                                         .on("close", (code, signal) => {
//                                                 finished = true;
//                                                 if (code === 0) resolve();
//                                                 else reject(new Error(`${label} failed (${code || signal})`));
//                                         })
//                                         .on("data", (d) => process.stdout.write(d))
//                                         .stderr.on("data", (d) => process.stderr.write(d));

//                                 setTimeout(() => {
//                                         if (!finished) {
//                                                 reject(new Error(`SSH stalled during: ${label}`));
//                                         }
//                                 }, 30 * 60 * 1000);
//                         }
//                 );
//         });
// }

// /* --------------------------------------------------
//    Create admin (Postal 3.x – OFFICIAL & CORRECT)
// -------------------------------------------------- */
// async function createAdmin(conn, admin) {
//         console.log("\n▶ Create Postal admin");

//         return new Promise((resolve, reject) => {
//                 conn.exec("postal make-user", { pty: true }, (err, stream) => {
//                         if (err) return reject(err);

//                         const steps = [
//                                 admin.email,
//                                 admin.firstName,
//                                 admin.lastName,
//                                 admin.password,
//                                 admin.password,
//                                 "y",
//                         ];

//                         let stepIndex = 0;
//                         let buffer = "";
//                         let success = false;

//                         stream.on("data", (data) => {
//                                 const text = data.toString();
//                                 process.stdout.write(text);
//                                 buffer += text;

//                                 if (buffer.includes("User has been created")) {
//                                         success = true;
//                                 }

//                                 if (
//                                         buffer.includes("Failed to create user") ||
//                                         buffer.includes("E-Mail address is invalid") ||
//                                         buffer.includes("Password is too short")
//                                 ) {
//                                         reject(new Error("Postal rejected admin user input"));
//                                         stream.end();
//                                         return;
//                                 }

//                                 if (buffer.trimEnd().endsWith(":") && stepIndex < steps.length) {
//                                         stream.write(steps[stepIndex] + "\n");
//                                         stepIndex++;
//                                         buffer = "";
//                                 }
//                         });

//                         stream.stderr.on("data", (d) => process.stderr.write(d));

//                         stream.on("close", () => {
//                                 if (success) {
//                                         console.log("✅ Admin user created successfully");
//                                         resolve();
//                                 } else {
//                                         reject(new Error("postal make-user did not confirm success"));
//                                 }
//                         });
//                 });
//         });
// }

// /* --------------------------------------------------
//    MAIN
// -------------------------------------------------- */
// async function main() {
//         const admin = await promptAdmin();
//         const conn = await connectSSH();

//         try {
//                 /* Cleanup */
//                 await exec(
//                         conn,
//                         `
// docker rm -f postal postal-web-1 postal-worker-1 postal-smtp-1 postal-mariadb postal-caddy 2>/dev/null || true
// docker volume rm postal_db postal_storage postal_caddy_data 2>/dev/null || true
// rm -rf /opt/postal /usr/bin/postal
// `,
//                         "Cleanup old Postal"
//                 );

//                 /* Base packages */
//                 await exec(
//                         conn,
//                         `
// apt update -y
// apt install -y git curl jq netcat-openbsd ca-certificates
// `,
//                         "Install base packages"
//                 );

//                 /* Docker */
//                 await exec(
//                         conn,
//                         `
// command -v docker || curl -fsSL https://get.docker.com | sh
// `,
//                         "Ensure Docker"
//                 );

//                 /* Postal CLI */
//                 await exec(
//                         conn,
//                         `
// git clone https://github.com/postalserver/install /opt/postal/install
// ln -sf /opt/postal/install/bin/postal /usr/bin/postal
// `,
//                         "Install Postal CLI"
//                 );

//                 /* MariaDB */
//                 await exec(
//                         conn,
//                         `
// docker run -d --name postal-mariadb \
//   -p 127.0.0.1:3306:3306 \
//   --restart always \
//   -e MARIADB_DATABASE=postal \
//   -e MARIADB_ROOT_PASSWORD=postal \
//   mariadb:10.11
// `,
//                         "Start MariaDB"
//                 );

//                 /* Bootstrap */
//                 await exec(
//                         conn,
//                         `postal bootstrap ${process.env.POSTAL_DOMAIN}`,
//                         "Postal bootstrap"
//                 );

//                 /* 🔥 ENABLE IP POOLS (POSTAL 3.x – CORRECT KEY) */
//                 await exec(
//                         conn,
//                         `
// # Remove existing smtp block if present
// sed -i '/^smtp:/,/^[^ ]/d' /opt/postal/config/postal.yml || true

// # Add correct smtp.use_ip_pools config
// printf "\\nsmtp:\\n  use_ip_pools: true\\n" >> /opt/postal/config/postal.yml
// `,
//                         "Enable IP pools (smtp.use_ip_pools)"
//                 );

//                 /* Initialize + Start */
//                 await exec(conn, `postal initialize`, "Postal initialize");
//                 await exec(conn, `postal start`, "Postal start");

//                 /* Admin */
//                 await createAdmin(conn, admin);

//                 /* Start Caddy */
//                 await exec(
//                         conn,
//                         `
// cat > /opt/postal/config/Caddyfile <<EOF
// ${process.env.POSTAL_DOMAIN} {
//   reverse_proxy 127.0.0.1:5000
// }
// EOF

// docker run -d \
//   --name postal-caddy \
//   --restart always \
//   --network host \
//   -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
//   -v /opt/postal/caddy-data:/data \
//   caddy
// `,
//                         "Start Caddy"
//                 );

//                 console.log("\n✅ POSTAL INSTALLED SUCCESSFULLY");
//                 console.log(`🌐 https://${process.env.POSTAL_DOMAIN}`);
//                 console.log(`👤 Admin: ${admin.email}`);
//         } catch (err) {
//                 console.error("\n❌ ERROR:", err.message);
//         } finally {
//                 conn.end();
//         }
// }

// main();



import "dotenv/config";
import { Client } from "ssh2";
import axios from "axios";
import XLSX from "xlsx";
import inquirer from "inquirer";

/* ===================== CONSTANTS ===================== */
const DOCKER_ENV = "export DOCKER_API_VERSION=1.44";

/* ===================== LOAD CONFIG FROM SHEET2 ===================== */
async function loadPostalConfig() {
        const { DNS_FILE_URL, POSTAL_SHEET_NAME, TARGET_POSTAL_DOMAIN } = process.env;

        if (!DNS_FILE_URL || !POSTAL_SHEET_NAME || !TARGET_POSTAL_DOMAIN) {
                throw new Error("DNS_FILE_URL, POSTAL_SHEET_NAME, TARGET_POSTAL_DOMAIN required");
        }

        const res = await axios.get(DNS_FILE_URL, { responseType: "arraybuffer" });
        const wb = XLSX.read(res.data, { type: "buffer" });
        const sheet = wb.Sheets[POSTAL_SHEET_NAME];

        if (!sheet) throw new Error(`Sheet ${POSTAL_SHEET_NAME} not found`);

        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const row = rows.find(r => r.POSTAL_DOMAIN === TARGET_POSTAL_DOMAIN);

        if (!row) throw new Error(`POSTAL_DOMAIN ${TARGET_POSTAL_DOMAIN} not found`);

        return {
                domain: row.POSTAL_DOMAIN.trim(),
                host: row.HOST.trim(),
                user: row.SSH_USER.trim(),
                pass: row.SSH_PASSWORD.toString().trim(),
        };
}

/* ===================== SSH HELPERS ===================== */
function sshConnect(cfg) {
        return new Promise((resolve, reject) => {
                const c = new Client();
                c.on("ready", () => resolve(c))
                        .on("error", reject)
                        .connect({
                                host: cfg.host,
                                username: cfg.user,
                                password: cfg.pass,
                                readyTimeout: 20000,
                        });
        });
}

function exec(conn, cmd, label) {
        return new Promise((resolve, reject) => {
                console.log(`\n▶ ${label}`);
                conn.exec(cmd, { pty: true }, (err, stream) => {
                        if (err) return reject(err);
                        stream.on("close", code => (code === 0 ? resolve() : reject(new Error(label))));
                        stream.on("data", d => process.stdout.write(d));
                        stream.stderr.on("data", d => process.stderr.write(d));
                });
        });
}

/* ===================== ADMIN PROMPT ===================== */
async function promptAdmin() {
        return inquirer.prompt([
                {
                        type: "input",
                        name: "email",
                        message: "Admin email:",
                        validate: v => v.includes("@") || "Invalid email",
                },
                { type: "input", name: "firstName", message: "First name:" },
                { type: "input", name: "lastName", message: "Last name:" },
                {
                        type: "password",
                        name: "password",
                        message: "Initial admin password:",
                        mask: "*",
                        validate: v => v.length >= 8 || "Minimum 8 characters",
                },
        ]);
}

/* ===================== CREATE POSTAL ADMIN ===================== */
async function createPostalAdmin(conn, admin) {
        const steps = [
                admin.email,
                admin.firstName,
                admin.lastName,
                admin.password,
                admin.password,
                "y",
        ];

        let i = 0;
        let success = false;

        return new Promise((resolve, reject) => {
                conn.exec(`${DOCKER_ENV}\npostal make-user`, { pty: true }, (err, stream) => {
                        if (err) return reject(err);

                        stream.on("data", d => {
                                const t = d.toString();
                                process.stdout.write(t);
                                if (t.includes("User has been created")) success = true;
                                if (t.trimEnd().endsWith(":") && i < steps.length) {
                                        stream.write(steps[i++] + "\n");
                                }
                        });

                        stream.on("close", () =>
                                success ? resolve() : reject(new Error("postal make-user failed"))
                        );
                });
        });
}

/* ===================== MAIN ===================== */
(async () => {
        const cfg = await loadPostalConfig();
        console.log("🔐 Connecting via SSH...");
        const conn = await sshConnect(cfg);

        try {
                /* CLEAN OLD INSTALL */
                await exec(conn, `
docker rm -f postal postal-web-1 postal-worker-1 postal-smtp-1 postal-mariadb postal-caddy 2>/dev/null || true
docker volume rm postal_db postal_storage postal_caddy_data 2>/dev/null || true
rm -rf /opt/postal /usr/bin/postal
`, "Cleanup old Postal");

                /* STEP 1 */
                await exec(conn, `
apt update -y
apt install -y git curl jq
`, "Install base packages");

                /* STEP 2 */
                await exec(conn, `
git clone https://github.com/postalserver/install /opt/postal/install
ln -s /opt/postal/install/bin/postal /usr/bin/postal
`, "Install Postal CLI");

                /* STEP 3 */
                await exec(conn, `
apt update -y
apt upgrade -y
hostnamectl set-hostname ${cfg.domain}
`, "System update & hostname");

                /* STEP 4 – DOCKER (IDEMPOTENT, NON-INTERACTIVE) */
                await exec(conn, `
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings

if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
fi

apt update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
`, "Install Docker");

                /* STEP 5 – MARIADB */
                await exec(conn, `
docker run -d \
  --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  --restart always \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  mariadb
`, "Start MariaDB");

                /* STEP 6 */
                await exec(conn, `postal bootstrap ${cfg.domain}`, "Postal bootstrap");

                /* STEP 7 */
                await exec(conn, `
POSTAL_YML=/opt/postal/config/postal.yml
grep -q '^postal:' $POSTAL_YML || echo 'postal:' >> $POSTAL_YML
grep -q 'use_ip_pools:' $POSTAL_YML && \
  sed -i 's/use_ip_pools:.*/use_ip_pools: true/' $POSTAL_YML || \
  sed -i '/^postal:/a\\  use_ip_pools: true' $POSTAL_YML
`, "Enable IP Pools");

                /* STEP 8 */
                await exec(conn, `
${DOCKER_ENV}
postal initialize
`, "Postal initialize");

                const admin = await promptAdmin();
                await createPostalAdmin(conn, admin);

                /* STEP 9 */
                await exec(conn, `
${DOCKER_ENV}
postal start
postal status
`, "Start Postal");

                /* STEP 10 */
                await exec(conn, `
docker run -d \
  --name postal-caddy \
  --restart always \
  --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy
`, "Start Caddy");

                /* STEP 11 */
                await exec(conn, `
iptables -t nat -A PREROUTING -p tcp --dport 587 -j REDIRECT --to-port 25
`, "Enable SMTP redirect");

                console.log("\n✅ POSTAL INSTALLATION COMPLETE");
                console.log(`🌐 https://${cfg.domain}`);
                console.log("📦 IP Pools enabled");

        } finally {
                conn.end();
        }
})().catch(err => {
        console.error("❌ FAILED:", err.message);
        process.exit(1);
});
