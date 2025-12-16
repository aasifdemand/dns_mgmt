require("dotenv").config();
const { NodeSSH } = require("node-ssh");

const ssh = new NodeSSH();

const {
        HOST,
        SSH_USER,
        SSH_PASSWORD,
        POSTAL_DOMAIN,
        ADMIN_EMAIL,
        ADMIN_FIRST,
        ADMIN_LAST,
        ADMIN_PASSWORD,
} = process.env;

if (
        !HOST ||
        !SSH_USER ||
        !SSH_PASSWORD ||
        !POSTAL_DOMAIN ||
        !ADMIN_EMAIL ||
        !ADMIN_FIRST ||
        !ADMIN_LAST ||
        !ADMIN_PASSWORD
) {
        console.error("Missing required environment variables");
        process.exit(1);
}

/* --------------------------------------------------
   Strict command execution (stop on error)
-------------------------------------------------- */
async function runStrict(cmd, label) {
        console.log(`\n▶ ${label}`);
        const res = await ssh.execCommand(cmd, { cwd: "/root" });

        if (res.stdout) console.log(res.stdout);
        if (res.stderr) console.error(res.stderr);

        if (res.code !== 0) {
                throw new Error(`Step failed: ${label}`);
        }
}

/* --------------------------------------------------
   Wait for MariaDB
-------------------------------------------------- */
async function waitForMariaDB(timeout = 60) {
        console.log("Waiting for MariaDB...");
        const start = Date.now();

        while (true) {
                const res = await ssh.execCommand(
                        "nc -z 127.0.0.1 3306"
                );

                if (res.code === 0) return;

                if ((Date.now() - start) / 1000 > timeout) {
                        throw new Error("MariaDB did not become ready");
                }

                await new Promise((r) => setTimeout(r, 1000));
        }
}

/* --------------------------------------------------
   Find Postal web container dynamically
-------------------------------------------------- */
async function getPostalWebContainer() {
        const res = await ssh.execCommand(`
docker ps --format '{{.Names}}' | grep -E 'postal.*web|postal-web|postal_web' | head -n 1
`);
        const name = res.stdout.trim();
        if (!name) {
                throw new Error("Postal web container not found");
        }
        return name;
}

/* --------------------------------------------------
   Wait until Postal web container is running
-------------------------------------------------- */
async function waitForPostalReady(timeout = 180) {
        console.log("Waiting for Postal services...");
        const start = Date.now();

        while (true) {
                const res = await ssh.execCommand(`
docker ps --format '{{.Names}}' | grep -E 'postal.*web|postal-web|postal_web' >/dev/null 2>&1
`);

                if (res.code === 0) return;

                if ((Date.now() - start) / 1000 > timeout) {
                        throw new Error("Postal did not become ready");
                }

                await new Promise((r) => setTimeout(r, 3000));
        }
}

/* --------------------------------------------------
   Create / update admin user (correct config + password)
-------------------------------------------------- */
async function createPostalAdmin() {
        console.log("\nCreating Postal admin user");

        const container = await getPostalWebContainer();

        const cmd = `
docker exec \
  -e POSTAL_CONFIG_FILE=/config/postal.yml \
  ${container} \
  postal console <<'RUBY'
user = User.find_by(email: "${ADMIN_EMAIL}")

if user
  puts "Admin exists, resetting password"
else
  puts "Creating admin user"
  user = User.new(
    email: "${ADMIN_EMAIL}",
    first_name: "${ADMIN_FIRST}",
    last_name: "${ADMIN_LAST}",
    admin: true
  )
end

user.password = "${ADMIN_PASSWORD}"
user.password_confirmation = "${ADMIN_PASSWORD}"

if user.save
  puts "Admin ready"
else
  puts user.errors.full_messages
  exit 1
end
RUBY
`;

        const res = await ssh.execCommand(cmd);

        if (res.stdout) console.log(res.stdout);
        if (res.stderr) console.error(res.stderr);

        if (res.code !== 0) {
                throw new Error("Admin creation/update failed");
        }
}

/* --------------------------------------------------
   Main
-------------------------------------------------- */
(async () => {
        try {
                console.log("Connecting to server...");
                await ssh.connect({
                        host: HOST,
                        username: SSH_USER,
                        password: SSH_PASSWORD,
                });

                /* Cleanup */
                await runStrict(`
docker rm -f postal postal-mariadb postal-caddy 2>/dev/null || true
docker volume rm postal_db postal_storage postal_caddy_data 2>/dev/null || true
docker system prune -f || true
rm -rf /opt/postal || true
rm -f /usr/bin/postal || true
`, "Cleanup existing Postal");

                /* Base packages */
                await runStrict(`
apt update -y
DEBIAN_FRONTEND=noninteractive apt install -y \
git curl jq ca-certificates gnupg lsb-release netcat-openbsd
`, "Install base packages");

                /* Docker */
                await runStrict(`
if command -v docker >/dev/null 2>&1; then
  docker --version
else
  curl -fsSL https://get.docker.com | sh
  systemctl start docker
fi
`, "Ensure Docker");

                /* Postal CLI */
                await runStrict(`
git clone https://github.com/postalserver/install /opt/postal/install
ln -sf /opt/postal/install/bin/postal /usr/bin/postal
`, "Install Postal CLI");

                /* Hostname */
                await runStrict(
                        `hostnamectl set-hostname ${POSTAL_DOMAIN}`,
                        "Set hostname"
                );

                /* MariaDB */
                await runStrict(`
docker run -d --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  --restart always \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  mariadb:10.11
`, "Start MariaDB");

                await waitForMariaDB();

                /* Bootstrap */
                await runStrict(
                        `postal bootstrap ${POSTAL_DOMAIN}`,
                        "Postal bootstrap"
                );

                /* Enable IP pools */
                await runStrict(
                        `echo "use_ip_pools: true" >> /opt/postal/config/postal.yml`,
                        "Enable IP pools"
                );

                /* Initialize */
                await runStrict(
                        `DOCKER_API_VERSION=1.44 postal initialize`,
                        "Postal initialize"
                );

                /* Start Postal */
                await runStrict(
                        `DOCKER_API_VERSION=1.44 postal start`,
                        "Start Postal"
                );

                await waitForPostalReady();

                /* Admin user */
                await createPostalAdmin();

                /* HTTPS */
                await runStrict(`
docker run -d --name postal-caddy \
  --restart always --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy
`, "Start Caddy");

                console.log("\nPostal setup finished");
                console.log(`URL: https://${POSTAL_DOMAIN}`);
                console.log(`Admin: ${ADMIN_EMAIL}`);

                ssh.dispose();
        } catch (err) {
                console.error("ERROR:", err.message);
                ssh.dispose();
                process.exit(1);
        }
})();
