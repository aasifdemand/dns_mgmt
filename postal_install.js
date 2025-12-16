

const { NodeSSH } = require("node-ssh");
require("dotenv").config();

const ssh = new NodeSSH();

// ================= CONFIG =================
const {
    HOST,
    SSH_USER,
    SSH_PASSWORD,
    POSTAL_DOMAIN,
    MAIL_DOMAIN,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ADMIN_FIRST,
    ADMIN_LAST,
    CLOUDFLARE_ZONE_ID,
    CLOUDFLARE_TOKEN
} = process.env;

// ================= HELPERS =================
async function run(cmd, label, tty = false) {
    console.log(`\n▶ ${label}`);
    const result = await ssh.execCommand(cmd, {
        cwd: "/root",
        pty: tty   // 🔑 THIS FIXES IT
    });

    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);

    if (result.code !== 0) {
        throw new Error(`Command failed: ${label}`);
    }
}


async function runPostal(cmd, label) {
    return run(`DOCKER_API_VERSION=1.44 ${cmd}`, label);
}

// ================= MAIN =================
(async () => {
    try {
        console.log("🔐 Connecting to server...");
        await ssh.connect({
            host: HOST,
            username: SSH_USER,
            password: SSH_PASSWORD
        });

        // ---------- CLEANUP ----------
        await run(`
set -e
docker rm -f postal postal-mariadb postal-caddy 2>/dev/null || true
rm -rf /opt/postal || true
rm -f /usr/bin/postal || true
apt update -y
`, "Cleanup old Postal & Docker artifacts");

        // ---------- INSTALL DOCKER ----------
        await run(`
set -e
curl -fsSL https://get.docker.com | sh
systemctl restart docker
docker --version
`, "Install Docker");

        // ---------- POSTAL INSTALL ----------
        await run(`
set -e
git clone https://github.com/postalserver/install /opt/postal/install
ln -sf /opt/postal/install/bin/postal /usr/bin/postal
hostnamectl set-hostname ${POSTAL_DOMAIN}
`, "Install Postal");

        // ---------- MARIADB ----------
        await run(`
docker run -d --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  --restart always mariadb:10.11
`, "Start MariaDB");

        // ---------- WAIT FOR DB ----------
        await run(`
for i in {1..60}; do
  nc -z 127.0.0.1 3306 && exit 0
  sleep 1
done
exit 1
`, "Wait for MariaDB");

        // ---------- BOOTSTRAP ----------
        await runPostal(
            ` DOCKER_API_VERSION=1.44 postal bootstrap ${POSTAL_DOMAIN}`,
            "Postal bootstrap"
        );

        await runPostal(
            `DOCKER_API_VERSION=1.44 postal initialize`,
            "Postal initialize"
        );
        await run(`
set -e

docker run --rm \
  --network host \
  -v /opt/postal/config:/config \
  -v /opt/postal/app:/app \
  ghcr.io/postalserver/postal:latest \
  bundle exec rails runner "
u = User.find_or_initialize_by(email: '${ADMIN_EMAIL}')
u.first_name = '${ADMIN_FIRST}'
u.last_name  = '${ADMIN_LAST}'
u.password   = '${ADMIN_PASSWORD}'
u.password_confirmation = '${ADMIN_PASSWORD}'
u.admin = true
u.save!
puts 'Postal admin user created successfully'
"
`, "Create Postal admin user (Rails – non-interactive)");

        // ---------- START POSTAL (EXACT SEQUENCE YOU REQUESTED) ----------
        await run(`
DOCKER_API_VERSION=1.44 postal start
sleep 5
DOCKER_API_VERSION=1.44 postal status
`, "Start Postal services");

        // ---------- HTTPS (CADDY) ----------
        await run(`
docker run -d --name postal-caddy \
  --restart always \
  --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy
`, "Start HTTPS via Caddy");

        // ---------- DKIM PROMPT ----------
        console.log(`
====================================================
NEXT STEP (SAFE & REQUIRED)
----------------------------------------------------
1. Login: https://${POSTAL_DOMAIN}
2. Create Organization
3. Create Mail Server
4. Add Domain: ${MAIL_DOMAIN}
5. COPY DKIM PUBLIC KEY (TXT VALUE ONLY)
====================================================
`);

        const dkimValue = await new Promise(resolve => {
            process.stdin.once("data", d => resolve(d.toString().trim()));
        });

        if (!dkimValue.startsWith("v=DKIM1")) {
            throw new Error("Invalid DKIM value");
        }

        // ---------- ADD DKIM TO CLOUDFLARE ----------
        await run(`
curl -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "TXT",
    "name": "postal._domainkey",
    "content": "${dkimValue}",
    "ttl": 120
  }'
`, "Add DKIM to Cloudflare");

        console.log("\n✅ POSTAL INSTALLATION COMPLETED SUCCESSFULLY");
        console.log(`🌍 https://${POSTAL_DOMAIN}`);

        ssh.dispose();
    } catch (err) {
        console.error("\n❌ ERROR:", err.message);
        ssh.dispose();
        process.exit(1);
    }
})();
