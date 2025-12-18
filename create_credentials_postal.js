import "dotenv/config";
import { Client } from "ssh2";
import axios from "axios";
import XLSX from "xlsx";
import fs from "fs";

/* ---------------- Load Postal SSH config from Sheet2 ---------------- */
async function loadPostalConfig() {
    const res = await axios.get(process.env.DNS_FILE_URL, { responseType: "arraybuffer" });
    const wb = XLSX.read(res.data, { type: "buffer" });

    const sheet = wb.Sheets[process.env.POSTAL_SHEET_NAME];
    if (!sheet) throw new Error("POSTAL_SHEET_NAME not found");

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const row = rows.find(r => r.HOST && r.SSH_USER && r.SSH_PASSWORD);
    if (!row) throw new Error("No valid SSH configuration found in Sheet2");

    return {
        host: row.HOST.toString().trim(),
        user: row.SSH_USER.toString().trim(),
        pass: row.SSH_PASSWORD.toString().trim(),
        serverDomain: row.POSTAL_DOMAIN ? row.POSTAL_DOMAIN.toString().trim() : null
    };
}

/* ---------------- Find the Mail Server ---------------- */
async function findMailServer(conn) {
    console.log("🔍 Finding mail server...");

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

# Get all servers
servers = Server.all
if servers.empty?
  puts "ERROR: No servers found"
  exit 1
end

# Find the main mail server (not the postal.* one)
# Usually the mail server is the one without 'postal.' prefix
mail_server = nil

servers.each do |server|
  # Skip servers with 'postal.' in the name (the postal admin server)
  unless server.name.include?('postal.')
    mail_server = server
    break
  end
end

# If no non-postal server found, take the first one
mail_server ||= servers.first

puts "MAIL_SERVER_FOUND:true"
puts "MAIL_SERVER_NAME:#{mail_server.name}"
puts "MAIL_SERVER_PERMALINK:#{mail_server.permalink}"
puts "MAIL_SERVER_ID:#{mail_server.id}"
puts "MAIL_SERVER_ORGANIZATION:#{mail_server.organization.name}"
puts "MAIL_SERVER_DOMAINS:#{mail_server.domains.count}"
puts "MAIL_SERVER_MODE:#{mail_server.mode}"
`;

    const command = `
cat > /tmp/find_mail_server.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/find_mail_server.rb
docker cp /tmp/find_mail_server.rb postal-web-1:/tmp/find_mail_server.rb
docker exec postal-web-1 ruby /tmp/find_mail_server.rb

rm -f /tmp/find_mail_server.rb
docker exec postal-web-1 rm -f /tmp/find_mail_server.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        const serverInfo = {
            found: result.includes('MAIL_SERVER_FOUND:true'),
            name: extractValue(result, 'MAIL_SERVER_NAME'),
            permalink: extractValue(result, 'MAIL_SERVER_PERMALINK'),
            id: extractValue(result, 'MAIL_SERVER_ID'),
            organization: extractValue(result, 'MAIL_SERVER_ORGANIZATION'),
            domainCount: extractValue(result, 'MAIL_SERVER_DOMAINS'),
            mode: extractValue(result, 'MAIL_SERVER_MODE')
        };

        if (serverInfo.found) {
            console.log(`✅ Found mail server: ${serverInfo.name} (${serverInfo.permalink})`);
            return serverInfo;
        } else {
            throw new Error("Mail server not found");
        }

    } catch (error) {
        console.error("❌ Failed to find mail server:", error.message);
        throw error;
    }
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

/* ---------------- Get Server Info ---------------- */
async function getServerInfo(conn) {
    console.log("🔍 Getting server information...");

    const command = `
docker exec postal-web-1 rails runner "
servers = Server.all
if servers.empty?
  puts 'ERROR: No servers found'
  exit 1
end

puts '=== SERVERS ==='
servers.each_with_index do |server, index|
  puts '[' + (index + 1).to_s + '] ' + server.name
  puts '  Permalink: ' + server.permalink
  puts '  ID: ' + server.id.to_s
  puts '  Mode: ' + server.mode
  puts '  Organization: ' + server.organization.name
  puts '  Domains: ' + server.domains.count.to_s
  server.domains.each do |domain|
    status = domain.verified? ? 'Verified' : 'Unverified'
    puts '    - ' + domain.name + ' (' + status + ')'
  end
  puts ''
end
"
`;

    try {
        const result = await execSSH(conn, command);
        return result;
    } catch (e) {
        console.error("❌ Failed to get server info:", e.message);
        throw e;
    }
}

/* ---------------- Find Server by Name ---------------- */
async function findServerByName(conn, serverName) {
    console.log(`🔍 Looking for server: ${serverName}`);

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

server_name = ARGV[0]
server = Server.find_by(name: server_name)

if server.nil?
  puts "ERROR: Server '#{server_name}' not found"
  puts "Available servers:"
  Server.all.each do |s|
    puts "  - #{s.name} (permalink: #{s.permalink})"
  end
  exit 1
end

puts "FOUND_SERVER:true"
puts "SERVER_NAME:#{server.name}"
puts "SERVER_PERMALINK:#{server.permalink}"
puts "SERVER_ID:#{server.id}"
puts "SERVER_ORGANIZATION:#{server.organization.name}"
puts "DOMAIN_COUNT:#{server.domains.count}"
`;

    const command = `
cat > /tmp/find_server.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/find_server.rb
docker cp /tmp/find_server.rb postal-web-1:/tmp/find_server.rb
docker exec postal-web-1 ruby /tmp/find_server.rb '${serverName.replace(/'/g, "'\"'\"'")}'

rm -f /tmp/find_server.rb
docker exec postal-web-1 rm -f /tmp/find_server.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        const serverInfo = {
            found: result.includes('FOUND_SERVER:true'),
            name: extractValue(result, 'SERVER_NAME'),
            permalink: extractValue(result, 'SERVER_PERMALINK'),
            id: extractValue(result, 'SERVER_ID'),
            organization: extractValue(result, 'SERVER_ORGANIZATION'),
            domainCount: extractValue(result, 'DOMAIN_COUNT')
        };

        if (serverInfo.found) {
            console.log(`✅ Found server: ${serverInfo.name} (${serverInfo.permalink})`);
            return serverInfo;
        } else {
            throw new Error("Server not found");
        }

    } catch (error) {
        console.error("❌ Failed to find server:", error.message);
        throw error;
    }
}

/* ---------------- Create SMTP Credentials ---------------- */
async function createSMTPCredentials(conn, serverPermalink, credentialName, holdAllMessages = true) {
    console.log(`🔐 Creating SMTP credentials "${credentialName}"...`);

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

if ARGV.length < 3
  puts "ERROR: Expected server permalink, credential name, and hold flag"
  exit 1
end

server_permalink = ARGV[0]
credential_name = ARGV[1]
hold_messages = ARGV[2] == 'true'

# Find the server
server = Server.find_by(permalink: server_permalink)
if server.nil?
  puts "ERROR: Server not found: #{server_permalink}"
  exit 1
end

# Create the SMTP credential with correct attributes
begin
  # Postal automatically generates the 'key' (password)
  credential = server.credentials.create!(
    type: 'SMTP',
    name: credential_name,
    hold: hold_messages
  )
  
  puts "SUCCESS:true"
  puts "CREDENTIAL_NAME:#{credential.name}"
  puts "CREDENTIAL_TYPE:#{credential.type}"
  puts "CREDENTIAL_KEY:#{credential.key}"
  puts "SERVER_NAME:#{server.name}"
  puts "HOLD_MESSAGES:#{credential.hold}"
  puts "CREATED_AT:#{credential.created_at}"
  puts "CREDENTIAL_UUID:#{credential.uuid}"
  puts "CREDENTIAL_ID:#{credential.id}"
  
rescue => e
  puts "ERROR: Failed to create credential: #{e.message}"
  exit 1
end
`;

    const command = `
cat > /tmp/create_smtp_credential.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/create_smtp_credential.rb
docker cp /tmp/create_smtp_credential.rb postal-web-1:/tmp/create_smtp_credential.rb
docker exec postal-web-1 ruby /tmp/create_smtp_credential.rb '${serverPermalink.replace(/'/g, "'\"'\"'")}' '${credentialName.replace(/'/g, "'\"'\"'")}' '${holdAllMessages}'

rm -f /tmp/create_smtp_credential.rb
docker exec postal-web-1 rm -f /tmp/create_smtp_credential.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        if (!result.includes('SUCCESS:true')) {
            throw new Error(result.split('\n')[0] || 'Unknown error');
        }

        // Parse the credential details from output
        const credential = {
            name: extractValue(result, 'CREDENTIAL_NAME'),
            type: extractValue(result, 'CREDENTIAL_TYPE'),
            key: extractValue(result, 'CREDENTIAL_KEY'),
            serverName: extractValue(result, 'SERVER_NAME'),
            holdMessages: extractValue(result, 'HOLD_MESSAGES') === 'true',
            createdAt: extractValue(result, 'CREATED_AT'),
            uuid: extractValue(result, 'CREDENTIAL_UUID'),
            id: extractValue(result, 'CREDENTIAL_ID')
        };

        if (credential.name && credential.key) {
            console.log(`✅ SMTP credential created: ${credential.name}`);
            console.log(`   Key/Password: ${credential.key}`);
            return credential;
        } else {
            throw new Error("Failed to parse credential details from output");
        }

    } catch (error) {
        console.error("❌ Failed to create SMTP credential:", error.message);
        throw error;
    }
}

/* ---------------- Extract value from output ---------------- */
function extractValue(output, key) {
    const lines = output.split('\n');
    for (const line of lines) {
        if (line.startsWith(key + ':')) {
            return line.substring(key.length + 1).trim();
        }
    }
    return null;
}

/* ---------------- Create Multiple SMTP Credentials ---------------- */
async function createMultipleCredentials(conn, serverPermalink, baseName, count = 1, holdAllMessages = true) {
    console.log(`🔐 Creating ${count} SMTP credential(s)...`);

    const credentials = [];

    for (let i = 1; i <= count; i++) {
        console.log(`\n📝 Creating credential ${i}/${count}...`);

        const credentialName = count > 1 ? `${baseName}${i}` : baseName;

        try {
            const credential = await createSMTPCredentials(conn, serverPermalink, credentialName, holdAllMessages);
            credentials.push(credential);
            console.log(`✅ Created: ${credential.name}`);
        } catch (error) {
            console.log(`⚠️  Failed to create credential ${i}: ${error.message}`);
        }

        // Small delay between creations
        if (i < count) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    return credentials;
}

/* ---------------- Generate XLSX File ---------------- */
function generateXLSXFile(credentials, serverInfo) {
    console.log("📊 Generating XLSX file...");

    // Prepare data for Excel - Only Domain, Name, Password columns
    const excelData = credentials.map((cred, index) => ({
        'Domain': serverInfo.serverName,
        'Name': cred.name,
        'Password': cred.key  // Use the 'key' field as password
    }));

    // Create workbook
    const wb = XLSX.utils.book_new();

    // Main credentials sheet with only 3 columns
    const ws = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(wb, ws, 'SMTP Credentials');

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const filename = `smtp-credentials-${timestamp}.xlsx`;

    // Write to file
    XLSX.writeFile(wb, filename);

    console.log(`✅ XLSX file generated: ${filename}`);
    console.log(`📁 Location: ${process.cwd()}/${filename}`);

    return filename;
}

/* ---------------- Display Credentials Summary ---------------- */
function displayCredentialsSummary(credentials, serverName) {
    console.log("\n" + "=".repeat(60));
    console.log("📋 CREDENTIALS SUMMARY");
    console.log("=".repeat(60));

    credentials.forEach((cred, index) => {
        console.log(`\n[${index + 1}] ${cred.name}`);
        console.log(`   Domain: ${serverName}`);
        console.log(`   Name: ${cred.name}`);
        console.log(`   Password: ${cred.key || 'N/A'}`);
        console.log(`   Connection: smtp://${cred.name}:${cred.key || '******'}@${serverName}:587`);
    });

    console.log("\n" + "=".repeat(60));
    console.log(`Total credentials created: ${credentials.length}`);
    console.log("=".repeat(60));
}


/* ---------------- MAIN ---------------- */
(async () => {
    let conn = null;

    try {
        console.log("🔍 Loading configuration...");
        const config = await loadPostalConfig();

        if (!config.serverDomain) {
            throw new Error("POSTAL_DOMAIN not found in Sheet2");
        }

        // Configuration
        const credentialBaseName = process.env.CREDENTIAL_BASE_NAME || "serververisence";
        const credentialCount = parseInt(process.env.CREDENTIAL_COUNT || "1");
        const holdAllMessages = process.env.HOLD_MESSAGES !== "false"; // Default true

        console.log(`\n🎯 Configuration:`);
        console.log(`   Credential Base Name: ${credentialBaseName}`);
        console.log(`   Number of Credentials: ${credentialCount}`);
        console.log(`   Hold All Messages: ${holdAllMessages ? 'Yes' : 'No'}`);

        // Connect SSH
        conn = await connectSSH(config);
        console.log("✅ SSH connection established");

        // Get server info first
        try {
            const serverInfoOutput = await getServerInfo(conn);
            console.log(serverInfoOutput);
        } catch (e) {
            console.log("⚠️  Could not get server list, trying direct approach...");
        }

        // Find the mail server automatically
        const serverInfo = await findMailServer(conn);

        if (!serverInfo || !serverInfo.found) {
            throw new Error("Could not find a mail server");
        }

        console.log(`\n✅ Using mail server: ${serverInfo.name} (${serverInfo.permalink})`);

        // Confirm creation
        console.log(`\n⚠️  About to create ${credentialCount} SMTP credential(s) for server: ${serverInfo.name}`);
        console.log("Press Enter to continue or Ctrl+C to cancel...");
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create credentials
        const credentials = await createMultipleCredentials(
            conn,
            serverInfo.permalink,
            credentialBaseName,
            credentialCount,
            holdAllMessages
        );

        if (credentials.length === 0) {
            throw new Error("No credentials were created");
        }

        // Display summary
        displayCredentialsSummary(credentials, serverInfo.name);

        // Generate XLSX file with only 3 columns: Domain, Name, Password
        const filename = generateXLSXFile(credentials, {
            serverName: serverInfo.name
        });

        console.log("\n🎉 SMTP CREDENTIALS CREATION COMPLETE!");
        console.log("\n📝 Next steps:");
        console.log(`1. Download the generated file: ${filename}`);
        console.log("2. The XLSX contains 3 columns: Domain, Name, Password");
        console.log("3. Use Name as username and Password as password for SMTP auth");
        console.log("4. Configure email clients with these credentials");
        console.log("\n⚠️  Security reminder:");
        console.log("   - Store the XLSX file securely");
        console.log("   - The 'Password' column contains the actual SMTP password");

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