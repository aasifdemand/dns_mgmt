// const { NodeSSH } = require("node-ssh");
// const ssh = new NodeSSH();

// // 🌍 SERVER CONFIG (change if needed)
// const HOST = "172.245.178.197";
// const USER = "root";
// const PASSWORD = "i769LrA4No83bMxmGV";
// const POSTAL_DOMAIN = "postal.verisence.tech";

// // 🧠 Helper
// async function run(cmd, label) {
//         console.log(`\n▶ ${label}`);
//         const result = await ssh.execCommand(cmd, { cwd: "/root" });

//         if (result.stdout) console.log("STDOUT:\n", result.stdout);
//         if (result.stderr) console.log("STDERR:\n", result.stderr);

//         if (result.code !== 0) {
//                 throw new Error(`Command failed (${label})`);
//         }
// }

// (async () => {
//         try {
//                 console.log("🔐 Connecting to server...");
//                 await ssh.connect({ host: HOST, username: USER, password: PASSWORD });

//                 // 🧹 CLEAN OLD POSTAL + DOCKER
//                 await run(
//                         `
// set -e
// docker rm -f postal postal-mariadb postal-caddy 2>/dev/null || true
// rm -rf /opt/postal || true
// rm -f /usr/bin/postal || true

// # Remove old docker binaries (conflict fixes)
// rm -f /usr/bin/docker || true
// rm -f /usr/bin/docker.io || true
// rm -f /usr/bin/containerd || true
// rm -f /usr/bin/containerd-shim || true
// rm -f /usr/bin/runc || true

// # Remove packages
// apt-get remove -y docker docker.io docker-doc docker-compose podman-docker containerd runc docker-ce docker-ce-cli containerd.io docker-buildx-plugin || true
// apt-get autoremove -y
// rm -rf /var/lib/docker /var/lib/containerd || true

// apt-get clean
// apt update -y
// `,
//                         "🧽 Cleaning old Docker & Postal"
//                 );

//                 // 📦 REQUIRED PACKAGES
//                 await run(
//                         `
// set -e
// apt install -y git curl jq ca-certificates gnupg lsb-release netcat-openbsd
// `,
//                         "📦 Installing required packages"
//                 );

//                 // 🐳 INSTALL DOCKER
//                 await run(
//                         `
// set -e
// curl -fsSL https://get.docker.com | sh
// systemctl restart docker
// docker --version
// docker compose version
// `,
//                         "🐳 Installing Docker 29.x"
//                 );

//                 // 🔧 FIX FOR POSTAL + NEW DOCKER API
//                 await run(
//                         `
// set -e
// echo 'export DOCKER_API_VERSION=1.44' >> /root/.bashrc
// export DOCKER_API_VERSION=1.44
// `,
//                         "🔧 Setting DOCKER_API_VERSION override (permanent)"
//                 );

//                 // 📥 POSTAL INSTALLER
//                 await run(
//                         `
// set -e
// git clone https://github.com/postalserver/install /opt/postal/install || true
// ln -sf /opt/postal/install/bin/postal /usr/bin/postal
// `,
//                         "📥 Cloning Postal installer"
//                 );

//                 // ⚙️ SYSTEM SETTINGS
//                 await run(
//                         `
// set -e
// apt upgrade -y
// hostnamectl set-hostname ${POSTAL_DOMAIN}
// `,
//                         "⚙️ Upgrading OS & setting hostname"
//                 );

//                 // 🛢 START MARIADB
//                 await run(
//                         `
// set -e
// docker run -d --name postal-mariadb \
//   -p 127.0.0.1:3306:3306 \
//   --restart always \
//   -e MARIADB_DATABASE=postal \
//   -e MARIADB_ROOT_PASSWORD=postal \
//   mariadb
// `,
//                         "🛢 Starting MariaDB"
//                 );

//                 // ⏱ WAIT FOR DB
//                 await run(
//                         `
// set -e
// echo "⏳ Waiting for MariaDB..."
// for i in {1..60}; do
//   if nc -z 127.0.0.1 3306 2>/dev/null; then
//     echo "✅ MariaDB ready."
//     exit 0
//   fi
//   echo "… waiting ($i/60)"
//   sleep 1
// done
// echo "❌ MariaDB failed to start."
// exit 1
// `,
//                         "⏱ Waiting for MariaDB"
//                 );

//                 // 🪄 BOOTSTRAP POSTAL
//                 await run(
//                         `
// set -e
// postal bootstrap ${POSTAL_DOMAIN}
// sed -i 's/use_ip_pools:.*/use_ip_pools: true/' /opt/postal/config/postal.yml || echo "use_ip_pools: true" >> /opt/postal/config/postal.yml
// `,
//                         "🪄 Bootstrapping Postal"
//                 );

//                 // ⚙️ INITIALIZE POSTAL (API FIX APPLIED)
//                 await run(
//                         `
// set -e
// DOCKER_API_VERSION=1.44 postal initialize
// `,
//                         "⚙️ Initializing Postal"
//                 );

//                 // WAIT AFTER MIGRATIONS
//                 await run(`sleep 10`, "⌛ Waiting after DB migrations");

//                 // 👤 MANUAL USER CREATION IS SAFEST
//                 await run(
//                         `
// set -e
// echo "⚠️ Enter admin details below:"
// DOCKER_API_VERSION=1.44 postal make-user || true
// `,
//                         "👤 Creating Postal admin user"
//                 );

//                 // 🚀 START POSTAL
//                 await run(
//                         `
// set -e
// DOCKER_API_VERSION=1.44 postal start
// sleep 5
// postal status
// `,
//                         "🚀 Starting Postal"
//                 );

//                 // 🌐 CADDY HTTPS
//                 await run(
//                         `
// set -e
// docker run -d --name postal-caddy \
//   --restart always --network host \
//   -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
//   -v /opt/postal/caddy-data:/data \
//   caddy
// `,
//                         "🌐 Starting Caddy HTTPS"
//                 );

//                 // 🔁 SAFE FIREWALL RULE
//                 await run(
//                         `
// set -e
// iptables -t nat -A PREROUTING -p tcp --dport 587 -j REDIRECT --to-port 25
// `,
//                         "🔁 Enabling SMTP redirect (587 → 25)"
//                 );

//                 console.log("\n🎉 DONE! Postal installed successfully.");
//                 console.log(`🌍 Visit: https://${POSTAL_DOMAIN}`);
//                 console.log("🔐 Use the admin account you created.\n");

//                 ssh.dispose();
//         } catch (err) {
//                 console.error("\n❌ Fatal error:", err.message);
//                 try { ssh.dispose(); } catch { }
//                 process.exit(1);
//         }
// })();


require("dotenv").config();
const { NodeSSH } = require("node-ssh");

const ssh = new NodeSSH();

// ================= ENV CONFIG =================
const {
        HOST,
        SSH_USER,
        SSH_PASSWORD,
        POSTAL_DOMAIN
} = process.env;

// ================= HELPERS =================
async function run(cmd, label) {
        console.log(`\n▶ ${label}`);
        const result = await ssh.execCommand(cmd, { cwd: "/root" });

        if (result.stdout) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);

        if (result.code !== 0) {
                throw new Error(`Command failed: ${label}`);
        }
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
`, "Cleanup old Postal");

                // ---------- REQUIRED PACKAGES ----------
                await run(`
set -e
apt install -y git curl jq ca-certificates gnupg lsb-release netcat-openbsd
`, "Install required packages");

                // ---------- DOCKER ----------
                await run(`
set -e
curl -fsSL https://get.docker.com | sh
systemctl restart docker
docker --version
`, "Install Docker");

                // ---------- POSTAL INSTALL ----------
                await run(`
set -e
git clone https://github.com/postalserver/install /opt/postal/install || true
ln -sf /opt/postal/install/bin/postal /usr/bin/postal
hostnamectl set-hostname ${POSTAL_DOMAIN}
`, "Install Postal");

                // ---------- MARIADB ----------
                await run(`
set -e
docker run -d --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  --restart always \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  mariadb:10.11
`, "Start MariaDB");

                // ---------- WAIT FOR DB ----------
                await run(`
set -e
for i in {1..60}; do
  nc -z 127.0.0.1 3306 && exit 0
  sleep 1
done
exit 1
`, "Wait for MariaDB");

                // ---------- BOOTSTRAP ----------
                await run(`
set -e
postal bootstrap ${POSTAL_DOMAIN}
`, "Postal bootstrap");

                // ---------- 🔥 CRITICAL FIX: ENABLE IP POOLS ----------
                await run(`
set -e
echo "🔧 Enabling IP Pools"
if grep -q "^use_ip_pools:" /opt/postal/config/postal.yml; then
  sed -i 's/^use_ip_pools:.*/use_ip_pools: true/' /opt/postal/config/postal.yml
else
  echo "use_ip_pools: true" >> /opt/postal/config/postal.yml
fi
`, "Enable use_ip_pools");

                // ---------- INITIALIZE ----------
                await run(`
set -e
DOCKER_API_VERSION=1.44 postal initialize
`, "Postal initialize");

                await run(`sleep 10`, "Wait after migrations");

                // ---------- MANUAL USER CREATION ----------
                await run(`
set -e
echo "⚠️ Run this manually:"
echo "DOCKER_API_VERSION=1.44 postal make-user"
`, "Admin user step");

                // ---------- START POSTAL ----------
                await run(`
set -e
DOCKER_API_VERSION=1.44 postal start
sleep 5
DOCKER_API_VERSION=1.44 postal status
`, "Start Postal");

                // ---------- HTTPS (CADDY) ----------
                await run(`
set -e
docker run -d --name postal-caddy \
  --restart always \
  --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy
`, "Start Caddy HTTPS");

                console.log("\n🎉 POSTAL INSTALLED CORRECTLY");
                console.log("✅ IP POOLS ENABLED");
                console.log(`🌍 https://${POSTAL_DOMAIN}`);

                ssh.dispose();
        } catch (err) {
                console.error("\n❌ Fatal error:", err.message);
                ssh.dispose();
                process.exit(1);
        }
})();
