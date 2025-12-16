import "dotenv/config";
import { Client } from "ssh2";
import inquirer from "inquirer";

/* --------------------------------------------------
   Prompt admin details (LOCAL)
-------------------------------------------------- */
async function promptAdmin() {
        return inquirer.prompt([
                {
                        type: "input",
                        name: "email",
                        message: "Admin email:",
                        validate: (v) => v.includes("@") || "Invalid email",
                },
                {
                        type: "input",
                        name: "firstName",
                        message: "First name:",
                },
                {
                        type: "input",
                        name: "lastName",
                        message: "Last name:",
                },
                {
                        type: "password",
                        name: "password",
                        message: "Initial admin password (min 8 chars):",
                        mask: "*",
                        validate: (v) =>
                                v.length >= 8 || "Password must be at least 8 characters",
                },
        ]);
}

/* --------------------------------------------------
   SSH connection (hardened)
-------------------------------------------------- */
function connectSSH() {
        return new Promise((resolve, reject) => {
                const conn = new Client();

                conn
                        .on("ready", () => {
                                console.log("✅ SSH connected");
                                resolve(conn);
                        })
                        .on("error", reject)
                        .connect({
                                host: process.env.HOST,
                                username: process.env.SSH_USER,
                                password: process.env.SSH_PASSWORD,
                                keepaliveInterval: 10_000,
                                keepaliveCountMax: 5,
                                readyTimeout: 60_000,
                        });
        });
}

/* --------------------------------------------------
   Exec helper (safe for long commands)
-------------------------------------------------- */
function exec(conn, command, label) {
        return new Promise((resolve, reject) => {
                console.log(`\n▶ ${label}`);

                conn.exec(
                        command,
                        { pty: true, env: { TERM: "xterm" } },
                        (err, stream) => {
                                if (err) return reject(err);

                                let finished = false;

                                stream
                                        .on("close", (code, signal) => {
                                                finished = true;
                                                if (code === 0) resolve();
                                                else reject(new Error(`${label} failed (${code || signal})`));
                                        })
                                        .on("data", (d) => process.stdout.write(d))
                                        .stderr.on("data", (d) => process.stderr.write(d));

                                setTimeout(() => {
                                        if (!finished) {
                                                reject(new Error(`SSH stalled during: ${label}`));
                                        }
                                }, 30 * 60 * 1000);
                        }
                );
        });
}

/* --------------------------------------------------
   Create admin (Postal 3.x – OFFICIAL & CORRECT)
-------------------------------------------------- */
async function createAdmin(conn, admin) {
        console.log("\n▶ Create Postal admin");

        return new Promise((resolve, reject) => {
                conn.exec("postal make-user", { pty: true }, (err, stream) => {
                        if (err) return reject(err);

                        const steps = [
                                admin.email,
                                admin.firstName,
                                admin.lastName,
                                admin.password,
                                admin.password,
                                "y",
                        ];

                        let stepIndex = 0;
                        let buffer = "";
                        let success = false;

                        stream.on("data", (data) => {
                                const text = data.toString();
                                process.stdout.write(text);
                                buffer += text;

                                if (buffer.includes("User has been created")) {
                                        success = true;
                                }

                                if (
                                        buffer.includes("Failed to create user") ||
                                        buffer.includes("E-Mail address is invalid") ||
                                        buffer.includes("Password is too short")
                                ) {
                                        reject(new Error("Postal rejected admin user input"));
                                        stream.end();
                                        return;
                                }

                                if (buffer.trimEnd().endsWith(":") && stepIndex < steps.length) {
                                        stream.write(steps[stepIndex] + "\n");
                                        stepIndex++;
                                        buffer = "";
                                }
                        });

                        stream.stderr.on("data", (d) => process.stderr.write(d));

                        stream.on("close", () => {
                                if (success) {
                                        console.log("✅ Admin user created successfully");
                                        resolve();
                                } else {
                                        reject(new Error("postal make-user did not confirm success"));
                                }
                        });
                });
        });
}

/* --------------------------------------------------
   MAIN
-------------------------------------------------- */
async function main() {
        const admin = await promptAdmin();
        const conn = await connectSSH();

        try {
                /* Cleanup */
                await exec(
                        conn,
                        `
docker rm -f postal postal-web-1 postal-worker-1 postal-smtp-1 postal-mariadb postal-caddy 2>/dev/null || true
docker volume rm postal_db postal_storage postal_caddy_data 2>/dev/null || true
rm -rf /opt/postal /usr/bin/postal
`,
                        "Cleanup old Postal"
                );

                /* Base packages */
                await exec(
                        conn,
                        `
apt update -y
apt install -y git curl jq netcat-openbsd ca-certificates
`,
                        "Install base packages"
                );

                /* Docker */
                await exec(
                        conn,
                        `
command -v docker || curl -fsSL https://get.docker.com | sh
`,
                        "Ensure Docker"
                );

                /* Postal CLI */
                await exec(
                        conn,
                        `
git clone https://github.com/postalserver/install /opt/postal/install
ln -sf /opt/postal/install/bin/postal /usr/bin/postal
`,
                        "Install Postal CLI"
                );

                /* MariaDB */
                await exec(
                        conn,
                        `
docker run -d --name postal-mariadb \
  -p 127.0.0.1:3306:3306 \
  --restart always \
  -e MARIADB_DATABASE=postal \
  -e MARIADB_ROOT_PASSWORD=postal \
  mariadb:10.11
`,
                        "Start MariaDB"
                );

                /* Bootstrap */
                await exec(
                        conn,
                        `postal bootstrap ${process.env.POSTAL_DOMAIN}`,
                        "Postal bootstrap"
                );

                /* 🔥 ENABLE IP POOLS (POSTAL 3.x – CORRECT KEY) */
                await exec(
                        conn,
                        `
# Remove existing smtp block if present
sed -i '/^smtp:/,/^[^ ]/d' /opt/postal/config/postal.yml || true

# Add correct smtp.use_ip_pools config
printf "\\nsmtp:\\n  use_ip_pools: true\\n" >> /opt/postal/config/postal.yml
`,
                        "Enable IP pools (smtp.use_ip_pools)"
                );

                /* Initialize + Start */
                await exec(conn, `postal initialize`, "Postal initialize");
                await exec(conn, `postal start`, "Postal start");

                /* Admin */
                await createAdmin(conn, admin);

                /* Start Caddy */
                await exec(
                        conn,
                        `
cat > /opt/postal/config/Caddyfile <<EOF
${process.env.POSTAL_DOMAIN} {
  reverse_proxy 127.0.0.1:5000
}
EOF

docker run -d \
  --name postal-caddy \
  --restart always \
  --network host \
  -v /opt/postal/config/Caddyfile:/etc/caddy/Caddyfile \
  -v /opt/postal/caddy-data:/data \
  caddy
`,
                        "Start Caddy"
                );

                console.log("\n✅ POSTAL INSTALLED SUCCESSFULLY");
                console.log(`🌐 https://${process.env.POSTAL_DOMAIN}`);
                console.log(`👤 Admin: ${admin.email}`);
        } catch (err) {
                console.error("\n❌ ERROR:", err.message);
        } finally {
                conn.end();
        }
}

main();
