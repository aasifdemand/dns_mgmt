import "dotenv/config";
import { Client } from "ssh2";
import axios from "axios";
import XLSX from "xlsx";

/* ---------------- Load Postal SSH config (Sheet2) ---------------- */
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
        pass: row.SSH_PASSWORD.toString().trim()
    };
}

/* ---------------- Load IP pools (Sheet4) ---------------- */
async function loadIPPools() {
    const res = await axios.get(process.env.DNS_FILE_URL, { responseType: "arraybuffer" });
    const wb = XLSX.read(res.data, { type: "buffer" });

    const sheet = wb.Sheets[process.env.IP_POOL_SHEETNAME];
    if (!sheet) throw new Error("IP_POOL_SHEETNAME not found");

    const targetPoolName = process.env.IP_POOL_NAME || "verisence";
    const domain = process.env.IP_DOMAIN || "verisence.tech";

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" })
        .filter(r => r.IP && r.Value);

    const ips = rows.map(r => ({
        ip: r.Value.toString().trim(),
        hostname: `${r.IP.toString().trim().toLowerCase()}.${domain}`
    }));

    if (!ips.length) throw new Error("No IP addresses found");

    console.log(`Using domain: ${domain}`);
    console.log(`Hostname pattern: ipX.${domain}`);

    return {
        poolName: targetPoolName,
        ips: ips
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

/* ---------------- Add IPs to existing pool ---------------- */
async function addIPsToPool(conn, poolName, ips) {
    console.log(`📦 Adding ${ips.length} IPs to pool "${poolName}"...`);

    // Create a Ruby script that fixes the organization issue
    const rubyScript = `
#!/usr/bin/env ruby

# Set Rails environment
ENV['RAILS_ENV'] = 'production'

# Load Rails environment
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

puts "=== Adding IPs to Postal Pool ==="
puts "Rails environment loaded successfully"

# Parse the JSON data passed as arguments
require 'json'

if ARGV.length < 2
  puts "ERROR: Expected pool name and IPs JSON"
  exit 1
end

pool_name = ARGV[0]
ips_json = ARGV[1]

begin
  ips_data = JSON.parse(ips_json)
rescue => e
  puts "ERROR: Failed to parse JSON: \#{e.message}"
  exit 1
end

puts "Target pool: \#{pool_name}"
puts "IPs to add: \#{ips_data.size}"

# Get the first server and its organization
server = Server.first
if server.nil?
  puts "ERROR: No Postal server found!"
  exit 1
end

organization = server.organization
if organization.nil?
  puts "ERROR: Server has no organization!"
  exit 1
end

puts "Server: \#{server.name} (Organization: \#{organization.name})"

# Find or create the IP pool WITHIN the organization
pool = organization.ip_pools.find_by(name: pool_name)
if pool.nil?
  puts "Pool not found in organization. Looking for existing pool..."
  # Check if pool exists outside organization
  existing_pool = IPPool.find_by(name: pool_name)
  if existing_pool
    puts "Found pool but it belongs to different organization"
    puts "Creating new pool within current organization..."
    pool = organization.ip_pools.create!(name: pool_name)
    puts "Created new pool: \#{pool.name} (ID: \#{pool.id})"
  else
    puts "Creating new pool..."
    pool = organization.ip_pools.create!(name: pool_name)
    puts "Created new pool: \#{pool.name} (ID: \#{pool.id})"
  end
else
  puts "Found pool: \#{pool.name} (ID: \#{pool.id})"
end

puts "Current IPs in pool: \#{pool.ip_addresses.count}"

# Set this pool as default if no default is set
if server.ip_pool_id.nil?
  server.update!(ip_pool_id: pool.id)
  puts "⭐ Set as default IP pool for server"
elsif server.ip_pool_id == pool.id
  puts "✓ This is already the server's default pool"
end

success_count = 0
skipped_count = 0
error_count = 0

ips_data.each_with_index do |ip_info, index|
  ip_address = ip_info['ip'].to_s.strip
  hostname = ip_info['hostname'].to_s.strip
  
  puts "\\n[#{index + 1}/\#{ips_data.size}] Processing: \#{ip_address}"
  puts "  Hostname: \#{hostname}"
  
  begin
    # Check if IP already exists in this pool
    existing_ip = pool.ip_addresses.find_by(ipv4: ip_address)
    
    if existing_ip
      puts "  ⚠️  IP already exists in pool (ID: \#{existing_ip.id})"
      # Update hostname if different
      if existing_ip.hostname != hostname
        existing_ip.update!(hostname: hostname)
        puts "  ✓ Updated hostname to: \#{hostname}"
      end
      skipped_count += 1
    else
      # Add new IP address with custom hostname
      ip_record = pool.ip_addresses.new(
        ipv4: ip_address,
        hostname: hostname,
        priority: 0
      )
      
      if ip_record.save
        puts "  ✓ Added IP: \#{ip_address}"
        puts "  ✓ Set hostname: \#{hostname}"
        success_count += 1
      else
        puts "  ❌ Failed to add IP: \#{ip_record.errors.full_messages.join(', ')}"
        error_count += 1
      end
    end
    
  rescue => e
    puts "  ❌ Error: \#{e.message}"
    error_count += 1
  end
end

puts "\\n=== SUMMARY ==="
puts "Successfully added: \#{success_count}"
puts "Already existed (skipped): \#{skipped_count}"
puts "Errors: \#{error_count}"
puts "Total IPs in pool now: \#{pool.ip_addresses.count}"

if error_count > 0
  puts "\\n⚠️  Some IPs failed to add"
  exit 1
else
  puts "\\n✅ All IPs processed successfully"
  exit 0
end
`;

    // Create the IPs JSON
    const ipsJson = JSON.stringify(ips);

    // Create the complete command
    const command = `
# Create the Ruby script
cat > /tmp/add_ips_to_pool.rb << 'EOF'
${rubyScript}
EOF

# Make it executable
chmod +x /tmp/add_ips_to_pool.rb

# Copy to postal container
docker cp /tmp/add_ips_to_pool.rb postal-web-1:/tmp/add_ips_to_pool.rb

# Execute the script with pool name and IPs JSON as arguments
docker exec postal-web-1 ruby /tmp/add_ips_to_pool.rb '${poolName.replace(/'/g, "'\"'\"'")}' '${ipsJson.replace(/'/g, "'\"'\"'")}'

# Clean up
rm -f /tmp/add_ips_to_pool.rb
docker exec postal-web-1 rm -f /tmp/add_ips_to_pool.rb 2>/dev/null || true
`;

    console.log("🚀 Adding IPs to existing pool...");
    await execSSH(conn, command);
    console.log("✅ IPs added to pool successfully");
}

/* ---------------- Check existing pools ---------------- */
async function listExistingPools(conn) {
    console.log("🔍 Checking existing IP pools...");

    const command = `
docker exec postal-web-1 rails runner "
puts '=== EXISTING IP POOLS ==='
Organization.all.each do |org|
  puts 'Organization: ' + org.name + ' (ID: ' + org.id.to_s + ')'
  org.ip_pools.each do |pool|
    puts '  Pool: ' + pool.name + ' (ID: ' + pool.id.to_s + ')'
    puts '    IP Addresses: ' + pool.ip_addresses.count.to_s
    pool.ip_addresses.each do |ip|
      puts '      - ' + ip.ipv4 + ' (hostname: ' + ip.hostname + ', ID: ' + ip.id.to_s + ')'
    end
  end
  puts ''
end

server = Server.first
if server
  puts 'Server: ' + server.name
  puts 'Organization: ' + server.organization.name if server.organization
  puts 'Default IP Pool ID: ' + server.ip_pool_id.to_s
  if server.ip_pool_id
    default_pool = IPPool.find_by(id: server.ip_pool_id)
    if default_pool
      puts 'Default Pool: ' + default_pool.name
    end
  end
end
"
`;

    try {
        await execSSH(conn, command);
    } catch (e) {
        console.log("⚠️  Failed to list pools:", e.message);
    }
}

/* ---------------- Test the connection first ---------------- */
async function testConnection(conn) {
    console.log("🧪 Testing Postal connection and permissions...");

    const testCommand = `
docker exec postal-web-1 rails runner "
server = Server.first
if server
  puts 'Server: ' + server.name
  puts 'Organization: ' + (server.organization ? server.organization.name : 'NONE')
  puts 'Can create IP pools: ' + (server.organization ? 'YES' : 'NO')
else
  puts 'ERROR: No server found'
end
"
`;

    try {
        const result = await execSSH(conn, testCommand);
        console.log("✅ Connection test successful");
        return result;
    } catch (e) {
        console.error("❌ Connection test failed:", e.message);
        throw e;
    }
}

/* ---------------- MAIN ---------------- */
(async () => {
    let conn = null;

    try {
        console.log("🔍 Loading Postal configuration...");
        const postal = await loadPostalConfig();
        console.log(`📡 Connecting to ${postal.host}...`);

        console.log("📋 Loading IP addresses...");
        const poolData = await loadIPPools();
        console.log(`📊 Found ${poolData.ips.length} IP addresses to add`);

        // Display IPs for verification
        console.log(`\n📋 IPs to add to pool "${poolData.poolName}":`);
        poolData.ips.forEach((ipData, i) => {
            console.log(`  ${i + 1}. ${ipData.ip} → ${ipData.hostname}`);
        });

        // Connect SSH
        conn = await connectSSH(postal);
        console.log("✅ SSH connection established");

        // Test connection first
        await testConnection(conn);

        // First, list existing pools to see what's there
        await listExistingPools(conn);

        // Add IPs to the pool
        await addIPsToPool(conn, poolData.poolName, poolData.ips);

        // Show final verification
        console.log("\n🔍 Final verification...");
        await listExistingPools(conn);

        console.log("\n🎉 ALL IPs ADDED TO POOL SUCCESSFULLY!");

    } catch (e) {
        console.error("\n❌ ERROR:", e.message);
        process.exit(1);
    } finally {
        if (conn) {
            conn.end();
            console.log("🔌 SSH connection closed");
        }
    }
})();