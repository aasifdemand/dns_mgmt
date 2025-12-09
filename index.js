require("dotenv").config();
const { NodeSSH } = require("node-ssh");
const ssh = new NodeSSH();

// 🌍 SERVER CONFIG (loaded from .env)
const HOST = process.env.HOST;
const USER = process.env.SSH_USER;
const PASSWORD = process.env.SSH_PASSWORD;
const POSTAL_DOMAIN = process.env.POSTAL_DOMAIN;

// 👤 ADMIN CONFIG
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_FIRST = process.env.ADMIN_FIRST;
const ADMIN_LAST = process.env.ADMIN_LAST;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// 🧠 Helper executor
async function run(cmd, label) {
    console.log(`\n▶ ${label}`);
    const result = await ssh.execCommand(cmd, { cwd: "/root" });

    if (result.stdout) console.log("STDOUT:\n", result.stdout);
    if (result.stderr) console.log("STDERR:\n", result.stderr);

    if (result.code !== 0) {
        throw new Error(`Command failed (${label})`);
    }
}

(async () => {
    try {
        console.log("🔐 Connecting to server...");
        await ssh.connect({ host: HOST, username: USER, password: PASSWORD });

        // 🧹 CLEAN OLD POSTAL + DOCKER
        await run(
            `set -e
docker rm -f postal postal-mariadb postal-caddy 2>/dev/null || true
rm -rf /opt/postal || true
rm -f /usr/bin/postal || true

rm -f /usr/bin/docker || true
rm -f /usr/bin/docker.io || true
rm -f /usr/bin/containerd || true
rm -f /usr/bin/containerd-shim || true
rm -f /usr/bin/runc || true

apt-get remove -y docker docker.io docker-doc docker-compose podman-docker containerd runc docker-ce docker-ce-cli containerd.io docker-buildx-plugin || true
apt-get autoremove -y
rm -rf /var/lib/docker /var/lib/containerd || true

apt-get clean
apt update -y
`,
            "🧽 Cleaning old Docker & Postal"
        );

        // 📦 REQUIRED PACKAGES
        await run(
            `set -e
apt install -y git curl jq ca-certificates gnupg lsb-release netcat-openbsd`,
            "📦 Installing required packages"
        );

        // 🐳 INSTALL DOCKER
        await run(
            `set -e
curl -fsSL https://get.docker.com | sh
systemctl restart docker
docker --version
docker compose version`,
            "🐳 Installing Docker"
        );

        // 🔧 POSTAL API FIX
        await run(
            `set -e
echo 'export DOCKER_API_VERSION=1.44' >> /root/.bashrc
export DOCKER_API_VERSION=1.44`,
            "🔧 Fix Docker API for Postal"
        );

        // 📥 INSTALL POSTAL
        await run(
            `set -e
git clone https://github.com/postalserver/install /opt/postal/install || true
ln -sf /opt/postal/install/bin/postal /usr/bin/postal`,
            "📥 Cloning Postal installer"
        );

        // ⚙️ SYSTEM SETTINGS
        await run(
            `set -e
apt upgrade -y
hostnamectl set-hostname ${POSTAL_DOMAIN}`,
            "⚙️ Upgrading OS & setting hostname"
        );

        // 🛢 START MARIADB
        await run(
            `set -e
docker run -d --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  --restart always \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  mariadb`,
            "🛢 Starting MariaDB"
        );

        // ⏱ WAIT FOR DB
        await run(
            `set -e
echo "⏳ Waiting for MariaDB..."
for i in {1..60}; do
  if nc -z 127.0.0.1 3306 2>/dev/null; then
    echo "✅ MariaDB ready."
    exit 0
  fi
  echo "… waiting ($i/60)"
  sleep 1
done
echo "❌ MariaDB failed to start."
exit 1`,
            "⏱ Waiting for MariaDB"
        );

        // 🪄 BOOTSTRAP POSTAL
        await run(
            `set -e
postal bootstrap ${POSTAL_DOMAIN}
sed -i 's/use_ip_pools:.*/use_ip_pools: true/' /opt/postal/config/postal.yml || echo "use_ip_pools: true" >> /opt/postal/config/postal.yml`,
            "🪄 Bootstrapping Postal"
        );

        // ⚙️ INITIALIZE DB
        await run(
            `set -e
DOCKER_API_VERSION=1.44 postal initialize`,
            "⚙️ Initializing Postal DB"
        );

        // WAIT
        await run(`sleep 10`, "⌛ Waiting after DB migrations");

        // 👤 AUTO-CREATE ADMIN USER
        await run(
            `set -e
DOCKER_API_VERSION=1.44 postal make-user \
  --email="${ADMIN_EMAIL}" \
  --name="${ADMIN_FIRST} ${ADMIN_LAST}" \
  --password="${ADMIN_PASSWORD}" \
  --admin`,
            "👤 Creating Postal admin user automatically"
        );

        // 🚀 START POSTAL
        await run(
            `set -e
DOCKER_API_VERSION=1.44 postal start
sleep 5
postal status`,
            "🚀 Starting Postal"
        );

        // 🌐 CADDY HTTPS
        await run(
            `set -e
docker run -d --name postal-caddy \
  --restart always --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy`,
            "🌐 Starting Caddy HTTPS"
        );

        // 🔁 REDIRECT 587 → 25
        await run(
            `set -e
iptables -t nat -A PREROUTING -p tcp --dport 587 -j REDIRECT --to-port 25`,
            "🔁 Enabling SMTP redirect"
        );

        console.log("\n🎉 DONE! Postal installed successfully.");
        console.log(`🌍 Visit: https://${POSTAL_DOMAIN}`);
        console.log(`🔐 Login: ${ADMIN_EMAIL}`);
        console.log(`🔑 Password: ${ADMIN_PASSWORD}\n`);

        ssh.dispose();
    } catch (err) {
        console.error("\n❌ Fatal error:", err.message);
        try { ssh.dispose(); } catch { }
        process.exit(1);
    }
})();
