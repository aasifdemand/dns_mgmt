import "dotenv/config";
import { Client } from "ssh2";
import axios from "axios";
import XLSX from "xlsx";

/* ---------------- Load Postal SSH config and Cloudflare credentials (Sheet2) ---------------- */
async function loadConfig() {
    const res = await axios.get(process.env.DNS_FILE_URL, { responseType: "arraybuffer" });
    const wb = XLSX.read(res.data, { type: "buffer" });

    const sheet = wb.Sheets[process.env.POSTAL_SHEET_NAME];
    if (!sheet) throw new Error("POSTAL_SHEET_NAME not found");

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const row = rows.find(r => r.HOST && r.SSH_USER && r.SSH_PASSWORD);
    if (!row) throw new Error("No valid SSH configuration found in Sheet2");

    return {
        ssh: {
            host: row.HOST.toString().trim(),
            user: row.SSH_USER.toString().trim(),
            pass: row.SSH_PASSWORD.toString().trim()
        },
        cloudflare: {
            zoneId: row.CLOUDFLARE_ZONE_ID ? row.CLOUDFLARE_ZONE_ID.toString().trim() : null,
            apiToken: row.CLOUDFLARE_API_TOKEN ? row.CLOUDFLARE_API_TOKEN.toString().trim() : null,
            domain: row.CLOUDFLARE_DOMAIN ? row.CLOUDFLARE_DOMAIN.toString().trim() : null
        }
    };
}

/* ---------------- SSH ---------------- */
function connectSSH({ host, user, pass }) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn
            .on("ready", () => resolve(conn))
            .on("error", reject)
            .connect({
                host,
                username: user,
                password: pass,
                readyTimeout: 30000
            });
    });
}

/* ---------------- Execute SSH Command ---------------- */
function execSSH(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);

            let stdout = '';
            let stderr = '';

            stream.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                process.stdout.write(output);
            });

            stream.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                process.stderr.write(output);
            });

            stream.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Command failed with code ${code}`));
                }
            });
        });
    });
}

/* ---------------- Check if server already exists ---------------- */
async function checkExistingServer(conn) {
    console.log("🔍 Checking for existing servers...");

    const command = `
docker exec postal-web-1 rails runner "
puts '=== EXISTING SERVERS ==='
if Server.count == 0
  puts 'No servers found'
else
  Server.all.each do |server|
    puts 'Server: ' + server.name
    puts '  ID: ' + server.id.to_s
    puts '  Mode: ' + server.mode
    puts '  Permalink: ' + server.permalink
    puts '  Organization: ' + (server.organization ? server.organization.name : 'None')
    puts '  IP Pool ID: ' + server.ip_pool_id.to_s
    puts ''
  end
end
puts 'Total servers: ' + Server.count.to_s
"
`;

    try {
        const result = await execSSH(conn, command);
        return result;
    } catch (e) {
        console.error("❌ Failed to check servers:", e.message);
        throw e;
    }
}

/* ---------------- Create First Mail Server ---------------- */
async function createMailServer(conn, serverName, mode = "Live") {
    console.log(`🚀 Creating mail server: ${serverName} (Mode: ${mode})...`);

    // Create a Ruby script to create the mail server
    const rubyScript = `
#!/usr/bin/env ruby

# Set Rails environment
ENV['RAILS_ENV'] = 'production'

# Load Rails environment
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

puts "=== Creating Postal Mail Server ==="
puts "Rails environment loaded successfully"

# Parse the arguments
if ARGV.length < 2
  puts "ERROR: Expected server name and mode"
  exit 1
end

server_name = ARGV[0]
server_mode = ARGV[1]

puts "Server name: \#{server_name}"
puts "Server mode: \#{server_mode}"

# Check if server already exists
existing_server = Server.find_by(name: server_name)
if existing_server
  puts "⚠️  Server '\#{server_name}' already exists!"
  puts "  ID: \#{existing_server.id}"
  puts "  Mode: \#{existing_server.mode}"
  puts "  Permalink: \#{existing_server.permalink}"
  # Return server info for DNS configuration
  puts "SERVER_ID:\#{existing_server.id}"
  puts "SERVER_PERMALINK:\#{existing_server.permalink}"
  exit 0
end

# Check total servers
if Server.count > 0
  puts "⚠️  There are already \#{Server.count} server(s) in the system"
  puts "Existing servers:"
  Server.all.each { |s| puts "  - \#{s.name} (ID: \#{s.id})" }
end

# Get or create default organization
organization = Organization.first
if organization.nil?
  puts "Creating default organization..."
  organization = Organization.create!(
    name: "Default Organization",
    permalink: "default",
    time_zone: "UTC"
  )
  puts "Created organization: \#{organization.name} (ID: \#{organization.id})"
else
  puts "Using organization: \#{organization.name} (ID: \#{organization.id})"
end

# Create the server
begin
  server = organization.servers.create!(
    name: server_name,
    mode: server_mode,
    # Leave ip_pool_id as nil (empty)
    ip_pool_id: nil,
    # Set reasonable defaults
    message_retention_days: 60,
    raw_message_retention_days: 30,
    raw_message_retention_size: 2048,
    spam_threshold: 5.0,
    spam_failure_threshold: 20.0
  )
  
  puts "✅ Server created successfully!"
  puts ""
  puts "=== SERVER DETAILS ==="
  puts "Name: \#{server.name}"
  puts "ID: \#{server.id}"
  puts "Mode: \#{server.mode}"
  puts "Permalink: \#{server.permalink}"
  puts "UUID: \#{server.uuid}"
  puts "Token: \#{server.token}"
  puts "Organization: \#{server.organization.name}"
  puts "IP Pool: \#{server.ip_pool_id.nil? ? 'None (empty)' : server.ip_pool_id}"
  
  # Return server info for DNS configuration
  puts "SERVER_ID:\#{server.id}"
  puts "SERVER_PERMALINK:\#{server.permalink}"
  
rescue => e
  puts "❌ Failed to create server: \#{e.message}"
  puts "Backtrace:"
  e.backtrace.first(5).each { |line| puts "  \#{line}" }
  exit 1
end

exit 0
`;

    // Create the complete command
    const command = `
# Create the Ruby script
cat > /tmp/create_mail_server.rb << 'EOF'
${rubyScript}
EOF

# Make it executable
chmod +x /tmp/create_mail_server.rb

# Copy to postal container
docker cp /tmp/create_mail_server.rb postal-web-1:/tmp/create_mail_server.rb

# Execute the script with server name and mode as arguments
docker exec postal-web-1 ruby /tmp/create_mail_server.rb '${serverName.replace(/'/g, "'\"'\"'")}' '${mode}'

# Clean up
rm -f /tmp/create_mail_server.rb
docker exec postal-web-1 rm -f /tmp/create_mail_server.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);
        // Extract server info from output
        const serverIdMatch = result.match(/SERVER_ID:(\d+)/);
        const serverPermalinkMatch = result.match(/SERVER_PERMALINK:(\S+)/);

        return {
            success: true,
            serverId: serverIdMatch ? serverIdMatch[1] : null,
            serverPermalink: serverPermalinkMatch ? serverPermalinkMatch[1] : null,
            output: result
        };
    } catch (error) {
        console.error("❌ Failed to create mail server:", error.message);
        throw error;
    }
}

/* ---------------- Generate DKIM Key ---------------- */
async function generateDKIM(conn, serverPermalink) {
    console.log(`🔐 Generating DKIM key for server: ${serverPermalink}...`);

    const dkimCommand = `
docker exec postal-web-1 postal dkim show ${serverPermalink}
`;

    try {
        const result = await execSSH(conn, dkimCommand);

        // Extract DKIM selector and key from output
        const selectorMatch = result.match(/Selector:\s+(\S+)/);
        const keyMatch = result.match(/Key:\s+([\s\S]+?)(?=\n\n|\n$)/);

        if (selectorMatch && keyMatch) {
            const selector = selectorMatch[1].trim();
            const key = keyMatch[1].trim().replace(/\n\s*/g, '');
            return { selector, key };
        }

        console.log("⚠️  Could not parse DKIM output, using fallback...");
        return { selector: "postal", key: null };

    } catch (e) {
        console.log("⚠️  Could not generate DKIM key:", e.message);
        return { selector: "postal", key: null };
    }
}

/* ---------------- Create Cloudflare DNS Records ---------------- */
async function createCloudflareDNS(cloudflareConfig, serverName, serverIp, dkimInfo) {
    console.log("🌐 Creating Cloudflare DNS records...");

    const { zoneId, apiToken, domain } = cloudflareConfig;

    if (!zoneId || !apiToken || !domain) {
        console.log("⚠️  Missing Cloudflare credentials in Sheet2");
        console.log("   Required columns: CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_DOMAIN");
        return false;
    }

    // Extract base domain from server name if not provided
    const targetDomain = domain || serverName.split('.').slice(-2).join('.');

    // DNS records to create
    const dnsRecords = [
        // MX Records
        {
            type: "MX",
            name: targetDomain,
            content: serverName,
            priority: 10,
            ttl: 3600,
            proxied: false
        },
        {
            type: "MX",
            name: `*.${targetDomain}`,
            content: serverName,
            priority: 10,
            ttl: 3600,
            proxied: false
        },
        // SPF Record
        {
            type: "TXT",
            name: targetDomain,
            content: `v=spf1 mx a ~all`,
            ttl: 3600,
            proxied: false
        },
        // DMARC Record
        {
            type: "TXT",
            name: `_dmarc.${targetDomain}`,
            content: `v=DMARC1; p=none; rua=mailto:postmaster@${targetDomain}`,
            ttl: 3600,
            proxied: false
        }
    ];

    // Add DKIM record if we have the key
    if (dkimInfo && dkimInfo.key) {
        dnsRecords.push({
            type: "TXT",
            name: `${dkimInfo.selector}._domainkey.${targetDomain}`,
            content: `v=DKIM1; k=rsa; p=${dkimInfo.key}`,
            ttl: 3600,
            proxied: false
        });
    }

    // Add A record if we have server IP
    if (serverIp) {
        dnsRecords.push({
            type: "A",
            name: serverName,
            content: serverIp,
            ttl: 3600,
            proxied: false  // MX records shouldn't be proxied
        });
    }

    console.log(`📋 Creating ${dnsRecords.length} DNS records for ${targetDomain}...`);

    // Create DNS records using Cloudflare API
    const results = [];

    for (const record of dnsRecords) {
        try {
            const response = await axios.post(
                `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
                record,
                {
                    headers: {
                        'Authorization': `Bearer ${apiToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.success) {
                console.log(`✅ Created ${record.type} record: ${record.name} -> ${record.content}`);
                results.push({ success: true, record: record.name });
            } else {
                console.log(`⚠️  Failed to create ${record.type} record for ${record.name}:`, response.data.errors);
                results.push({ success: false, record: record.name, errors: response.data.errors });
            }
        } catch (error) {
            console.log(`❌ Error creating ${record.type} record for ${record.name}:`, error.message);
            results.push({ success: false, record: record.name, error: error.message });
        }

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`\n📊 DNS Creation Summary: ${successCount}/${dnsRecords.length} records created successfully`);

    return successCount > 0;
}

/* ---------------- Verify Cloudflare DNS Records ---------------- */
async function verifyCloudflareDNS(cloudflareConfig) {
    console.log("🔍 Verifying Cloudflare DNS records...");

    const { zoneId, apiToken, domain } = cloudflareConfig;

    if (!zoneId || !apiToken || !domain) {
        console.log("⚠️  Cannot verify DNS without Cloudflare credentials");
        return;
    }

    try {
        const response = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    per_page: 100
                }
            }
        );

        if (response.data.success) {
            const records = response.data.result;
            const domainRecords = records.filter(r => r.name.includes(domain));

            console.log(`\n📋 Found ${domainRecords.length} DNS records for ${domain}:`);

            // Group by type
            const byType = {};
            domainRecords.forEach(record => {
                if (!byType[record.type]) byType[record.type] = [];
                byType[record.type].push(record);
            });

            Object.keys(byType).sort().forEach(type => {
                console.log(`\n${type} Records:`);
                byType[type].forEach(record => {
                    console.log(`  ${record.name} -> ${record.content} (TTL: ${record.ttl})`);
                });
            });

            // Check for required records
            const requiredTypes = ['MX', 'TXT', 'A'];
            const missingTypes = requiredTypes.filter(type =>
                !byType[type] || byType[type].length === 0
            );

            if (missingTypes.length > 0) {
                console.log(`\n⚠️  Missing record types: ${missingTypes.join(', ')}`);
            } else {
                console.log("\n✅ All required DNS record types present");
            }

        }
    } catch (error) {
        console.log("❌ Failed to verify DNS records:", error.message);
    }
}

/* ---------------- Get Server IP from SSH config ---------------- */
async function getServerIPFromConfig(config) {
    // Try to get IP from various sources
    const ipSources = [
        config.ssh.host,
        process.env.SERVER_IP
    ];

    for (const source of ipSources) {
        if (source && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(source)) {
            console.log(`📡 Using server IP: ${source}`);
            return source;
        }
    }

    console.log("⚠️  Could not determine server IP automatically");
    console.log("   Add SERVER_IP to .env or ensure HOST in Sheet2 is an IP address");
    return null;
}

/* ---------------- MAIN ---------------- */
(async () => {
    let conn = null;

    try {
        console.log("🔍 Loading configuration from Sheet2...");
        const config = await loadConfig();
        console.log(`📡 Connecting to ${config.ssh.host}...`);

        // Server configuration
        const serverName = process.env.SERVER_NAME || "verisence.tech";
        const serverMode = process.env.SERVER_MODE || "Live";

        console.log(`\n🎯 Target Server Configuration:`);
        console.log(`   Name: ${serverName}`);
        console.log(`   Mode: ${serverMode}`);
        console.log(`   IP Pool: Empty (to be set later)`);

        if (config.cloudflare.zoneId && config.cloudflare.apiToken) {
            console.log(`   Cloudflare: Enabled (Zone: ${config.cloudflare.zoneId})`);
        } else {
            console.log(`   Cloudflare: Disabled (missing credentials in Sheet2)`);
        }

        // Connect SSH
        conn = await connectSSH(config.ssh);
        console.log("✅ SSH connection established");

        // Check existing servers first
        await checkExistingServer(conn);

        // Confirm creation
        console.log(`\n⚠️  About to create mail server "${serverName}"`);
        console.log("Press Enter to continue or Ctrl+C to cancel...");
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create the mail server
        const serverResult = await createMailServer(conn, serverName, serverMode);

        if (!serverResult.serverPermalink) {
            throw new Error("Failed to get server permalink after creation");
        }

        // Generate DKIM key
        const dkimInfo = await generateDKIM(conn, serverResult.serverPermalink);

        // Get server IP for DNS A record
        const serverIp = await getServerIPFromConfig(config);

        // Create Cloudflare DNS records if credentials are available
        if (config.cloudflare.zoneId && config.cloudflare.apiToken) {
            console.log("\n🌐 Setting up Cloudflare DNS...");
            const dnsSuccess = await createCloudflareDNS(
                config.cloudflare,
                serverName,
                serverIp,
                dkimInfo
            );

            if (dnsSuccess) {
                console.log("\n✅ Cloudflare DNS configured successfully!");

                // Verify the DNS records
                await verifyCloudflareDNS(config.cloudflare);

                console.log("\n📝 DNS propagation may take a few minutes to a few hours");
                console.log("   You can check propagation with: dig MX " + (config.cloudflare.domain || serverName));
            }
        } else {
            console.log("\n⚠️  Skipping Cloudflare DNS setup (missing credentials)");
            console.log("   Add these columns to Sheet2:");
            console.log("   - CLOUDFLARE_ZONE_ID");
            console.log("   - CLOUDFLARE_API_TOKEN");
            console.log("   - CLOUDFLARE_DOMAIN (optional, defaults to server domain)");
        }

        // Get server credentials
        console.log("\n🔑 Server Credentials Summary:");
        console.log(`   Server Name: ${serverName}`);
        console.log(`   Permalink: ${serverResult.serverPermalink}`);
        console.log(`   DKIM Selector: ${dkimInfo.selector}`);
        if (dkimInfo.key) {
            console.log(`   DKIM Key: Generated (see above)`);
        }

        console.log("\n🎉 MAIL SERVER CREATION COMPLETE!");
        console.log("\n📝 Next steps:");
        console.log("1. Wait for DNS propagation (if using Cloudflare)");
        console.log("2. Test email delivery");
        console.log("3. Create and assign IP pools using your other script");
        console.log("4. Configure additional domains in Postal UI");

    } catch (e) {
        console.error("\n❌ ERROR:", e.message);
        process.exit(1);
    } finally {
        if (conn) {
            conn.end();
            console.log("\n🔌 SSH connection closed");
        }
    }
})();