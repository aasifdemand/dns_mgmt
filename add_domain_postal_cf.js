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
            zoneId: row.CF_ZONE_ID ? row.CF_ZONE_ID.toString().trim() : null,
            apiToken: row.CF_API_TOKEN ? row.CF_API_TOKEN.toString().trim() : null,
            domain: row.POSTAL_DOMAIN ? row.POSTAL_DOMAIN.toString().trim() : null
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

/* ---------------- Get DKIM Key from Postal ---------------- */
async function getDKIMFromPostal(conn, serverPermalink, domainName) {
    console.log(`🔐 Retrieving DKIM key from Postal for domain: ${domainName}...`);

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

server_permalink = '${serverPermalink.replace(/'/g, "'\"'\"'")}'
domain_name = '${domainName.replace(/'/g, "'\"'\"'")}'

server = Server.find_by(permalink: server_permalink)
if server.nil?
  puts "ERROR: Server not found"
  exit 1
end

domain = server.domains.find_by(name: domain_name)
if domain.nil?
  puts "ERROR: Domain not found"
  exit 1
end

# Check if domain has DKIM (after verification, Postal should have generated it)
puts "Domain verified: \#{domain.verified?}"
puts "Domain verified at: \#{domain.verified_at}"

# Check if DKIM private key exists on domain
if domain.dkim_private_key.present?
  puts "DKIM_PRIVATE_KEY_EXISTS:true"
  
  # Try to get DKIM identifier string (selector)
  if domain.dkim_identifier_string.present?
    puts "DKIM_SELECTOR:\#{domain.dkim_identifier_string}"
    
    # Try to get public key - generated from private key
    require 'openssl'
    begin
      private_key = OpenSSL::PKey::RSA.new(domain.dkim_private_key)
      public_key = private_key.public_key
      public_key_pem = public_key.to_pem
        .gsub("-----BEGIN PUBLIC KEY-----", "")
        .gsub("-----END PUBLIC KEY-----", "")
        .gsub(/\\s+/, "")
        .strip
      
      puts "DKIM_PUBLIC_KEY:\#{public_key_pem}"
      puts "DKIM_KEY_TYPE:RSA"
      puts "DKIM_KEY_LENGTH:\#{private_key.n.num_bits}"
    rescue => e
      puts "ERROR generating public key: \#{e.message}"
    end
  end
else
  puts "DKIM_PRIVATE_KEY_EXISTS:false"
  
  # Try to generate DKIM if it doesn't exist
  if domain.verified? && domain.respond_to?(:generate_dkim_key!)
    puts "Attempting to generate DKIM key..."
    begin
      domain.generate_dkim_key!
      domain.reload
      
      if domain.dkim_private_key.present?
        puts "DKIM_GENERATED:true"
        puts "DKIM_SELECTOR:\#{domain.dkim_identifier_string}"
        
        require 'openssl'
        private_key = OpenSSL::PKey::RSA.new(domain.dkim_private_key)
        public_key = private_key.public_key
        public_key_pem = public_key.to_pem
          .gsub("-----BEGIN PUBLIC KEY-----", "")
          .gsub("-----END PUBLIC KEY-----", "")
          .gsub(/\\s+/, "")
          .strip
        
        puts "DKIM_PUBLIC_KEY:\#{public_key_pem}"
      else
        puts "DKIM_GENERATED:false"
      end
    rescue => e
      puts "ERROR generating DKIM: \#{e.message}"
    end
  else
    puts "ERROR: No DKIM private key found and domain not verified"
  end
end
`;

    const command = `
cat > /tmp/get_dkim.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/get_dkim.rb
docker cp /tmp/get_dkim.rb postal-web-1:/tmp/get_dkim.rb
docker exec postal-web-1 ruby /tmp/get_dkim.rb
rm -f /tmp/get_dkim.rb
docker exec postal-web-1 rm -f /tmp/get_dkim.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        // Check for DKIM info
        const selector = extractValue(result, 'DKIM_SELECTOR');
        const publicKey = extractValue(result, 'DKIM_PUBLIC_KEY');
        const privateKeyExists = result.includes('DKIM_PRIVATE_KEY_EXISTS:true');
        const generated = result.includes('DKIM_GENERATED:true');

        if (selector && publicKey) {
            console.log(`✅ Retrieved DKIM key - Selector: ${selector}`);
            return { selector, key: publicKey, generated };
        } else if (privateKeyExists) {
            console.log("⚠️  DKIM private key exists but couldn't extract public key");
            return null;
        } else {
            console.log("❌ No DKIM key found for domain");
            return null;
        }

    } catch (error) {
        console.log("❌ Failed to retrieve DKIM key:", error.message);
        return null;
    }
}

/* ---------------- Add Domain to Server ---------------- */
async function addDomainToServer(conn, serverPermalink, domainName) {
    console.log(`🌐 Adding domain "${domainName}" to server "${serverPermalink}"...`);

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

if ARGV.length < 2
  puts "ERROR: Expected server permalink and domain name"
  exit 1
end

server_permalink = ARGV[0]
domain_name = ARGV[1]

# Find the server
server = Server.find_by(permalink: server_permalink)
if server.nil?
  puts "ERROR: Server not found: \#{server_permalink}"
  exit 1
end

# Check if domain already exists
existing_domain = server.domains.find_by(name: domain_name)
if existing_domain
  puts "DOMAIN_EXISTS:true"
  puts "DOMAIN_NAME:\#{existing_domain.name}"
  puts "DOMAIN_VERIFIED:\#{existing_domain.verified?}"
  puts "DOMAIN_VERIFICATION_TOKEN:\#{existing_domain.verification_token}"
  exit 0
end

# Create the domain
begin
  domain = server.domains.create!(
    name: domain_name,
    verification_method: 'DNS'
  )
  
  puts "DOMAIN_CREATED:true"
  puts "DOMAIN_NAME:\#{domain.name}"
  puts "DOMAIN_ID:\#{domain.id}"
  puts "DOMAIN_VERIFIED:\#{domain.verified?}"
  puts "DOMAIN_VERIFICATION_TOKEN:\#{domain.verification_token}"
  
rescue => e
  puts "ERROR: Failed to create domain: \#{e.message}"
  exit 1
end
`;

    const command = `
cat > /tmp/add_domain.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/add_domain.rb
docker cp /tmp/add_domain.rb postal-web-1:/tmp/add_domain.rb
docker exec postal-web-1 ruby /tmp/add_domain.rb '${serverPermalink.replace(/'/g, "'\"'\"'")}' '${domainName.replace(/'/g, "'\"'\"'")}'
rm -f /tmp/add_domain.rb
docker exec postal-web-1 rm -f /tmp/add_domain.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        if (result.includes('ERROR:')) {
            throw new Error(result.split('ERROR:')[1].trim());
        }

        // Parse domain info
        const domainInfo = {
            name: extractValue(result, 'DOMAIN_NAME'),
            verified: extractValue(result, 'DOMAIN_VERIFIED') === 'true',
            verificationToken: extractValue(result, 'DOMAIN_VERIFICATION_TOKEN')
        };

        if (domainInfo.verificationToken) {
            console.log(`✅ Domain added. Verification token: ${domainInfo.verificationToken}`);
            return domainInfo;
        } else if (domainInfo.verified) {
            console.log(`✅ Domain already exists and is verified`);
            return domainInfo;
        }

        return null;

    } catch (error) {
        console.error("❌ Failed to add domain:", error.message);
        return null;
    }
}

/* ---------------- Create Verification Record in Cloudflare ---------------- */
async function createVerificationRecord(cloudflareConfig, domainName, verificationToken) {
    console.log("🔐 Creating verification TXT record in Cloudflare...");

    const { zoneId, apiToken } = cloudflareConfig;

    const verificationRecord = {
        type: "TXT",
        name: domainName,
        content: `postal-verification=${verificationToken}`,
        ttl: 300,
        proxied: false
    };

    try {
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            verificationRecord,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            console.log(`✅ Created verification TXT record for ${domainName}`);
            return true;
        } else {
            console.log(`❌ Failed to create verification record: ${response.data.errors?.[0]?.message}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Error creating verification record: ${error.message}`);
        return false;
    }
}

/* ---------------- Check Domain Verification Status and Methods ---------------- */
async function checkDomainVerificationStatus(conn, serverPermalink, domainName) {
    console.log("🔍 Checking domain verification status and methods...");

    const rubyScript = `
#!/usr/bin/env ruby

ENV['RAILS_ENV'] = 'production'
require File.expand_path('/opt/postal/app/config/environment', __FILE__)

server = Server.find_by(permalink: '${serverPermalink.replace(/'/g, "'\"'\"'")}')
if server.nil?
  puts "ERROR: Server not found"
  exit 1
end

domain = server.domains.find_by(name: '${domainName.replace(/'/g, "'\"'\"'")}')
if domain.nil?
  puts "ERROR: Domain not found"
  exit 1
end

puts "=== DOMAIN INFO ==="
puts "Name: \#{domain.name}"
puts "Verified: \#{domain.verified?}"
puts "Verified At: \#{domain.verified_at}"
puts "Verification Method: \#{domain.verification_method}"
puts "Verification Token: \#{domain.verification_token}"
puts "DNS Checked At: \#{domain.dns_checked_at}"

puts "\\n=== TRYING DIFFERENT VERIFICATION APPROACHES ==="

# Try different verification approaches
begin
  # Approach 1: Check if verify_with_dns exists
  if domain.respond_to?(:verify_with_dns)
    puts "Trying verify_with_dns method..."
    domain.verify_with_dns
    domain.reload
    puts "After verify_with_dns: Verified=\#{domain.verified?}"
  end
  
  # Approach 2: Manual verification check
  puts "\\n=== MANUAL DNS CHECK ==="
  
  # Get the expected TXT record value
  expected_value = "postal-verification=\#{domain.verification_token}"
  puts "Expected TXT record: \#{expected_value}"
  
  # Check if DNS record exists (simplified check)
  require 'resolv'
  begin
    resolver = Resolv::DNS.new
    txt_records = resolver.getresources(domain.name, Resolv::DNS::Resource::IN::TXT)
    
    puts "Found \#{txt_records.size} TXT record(s) for \#{domain.name}"
    
    txt_records.each_with_index do |record, i|
      record_strings = record.strings.join('')
      puts "  Record \#{i+1}: \#{record_strings}"
      
      if record_strings.include?(domain.verification_token)
        puts "  ✅ Found matching verification token!"
        
        # Update verification status if not already verified
        if domain.verified_at.nil?
          puts "  Updating verification status..."
          domain.update!(verified_at: Time.now)
          domain.reload
          puts "  After update: Verified=\#{domain.verified?}"
        end
      end
    end
  rescue => e
    puts "  DNS lookup error: \#{e.message}"
  end
  
  puts "\\n=== FINAL STATUS ==="
  puts "FINAL_VERIFIED:\#{domain.verified?}"
  puts "FINAL_VERIFIED_AT:\#{domain.verified_at}"
  
rescue => e
  puts "ERROR during verification: \#{e.message}"
  puts "FINAL_VERIFIED:false"
end
`;

    const command = `
cat > /tmp/check_verification.rb << 'EOF'
${rubyScript}
EOF

chmod +x /tmp/check_verification.rb
docker cp /tmp/check_verification.rb postal-web-1:/tmp/check_verification.rb
docker exec postal-web-1 ruby /tmp/check_verification.rb
rm -f /tmp/check_verification.rb
docker exec postal-web-1 rm -f /tmp/check_verification.rb 2>/dev/null || true
`;

    try {
        const result = await execSSH(conn, command);

        // Check if domain is finally verified
        const finalVerified = result.includes('FINAL_VERIFIED:true');
        const verifiedAt = extractValue(result, 'FINAL_VERIFIED_AT');

        if (finalVerified) {
            console.log(`✅ Domain verified! Verified at: ${verifiedAt}`);
            return true;
        }

        return false;

    } catch (error) {
        console.error("❌ Verification status check failed:", error.message);
        return false;
    }
}

/* ---------------- Create SPF Record in Cloudflare ---------------- */
async function createSPFRecord(cloudflareConfig, domainName) {
    console.log("🔐 Creating SPF record in Cloudflare...");

    const { zoneId, apiToken } = cloudflareConfig;

    const spfRecord = {
        type: "TXT",
        name: domainName,
        content: `v=spf1 mx a ~all`,
        ttl: 3600,
        proxied: false
    };

    try {
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            spfRecord,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            console.log(`✅ Created SPF record for ${domainName}`);
            return true;
        } else {
            console.log(`❌ Failed to create SPF record: ${response.data.errors?.[0]?.message}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Error creating SPF record: ${error.message}`);
        return false;
    }
}

async function createDKIMRecord(cloudflareConfig, domainName, dkimInfo) {
    console.log("🔐 Setting up DKIM record in Cloudflare...");

    const { zoneId, apiToken } = cloudflareConfig;
    const dkimRecordName = `${dkimInfo.selector}._domainkey.${domainName}`;

    // Check if DKIM already exists
    const dkimExists = await checkDKIMRecordExists(cloudflareConfig, domainName, dkimInfo.selector);

    if (dkimExists) {
        console.log("✅ DKIM record already exists - skipping creation");
        return true;
    }

    // Correct DKIM format with t=s; and proper termination
    const dkimContent = `v=DKIM1; t=s; h=sha256; p=${dkimInfo.key};`;

    const dkimRecord = {
        type: "TXT",
        name: dkimRecordName,
        content: dkimContent,  // No quotes here - Cloudflare API handles it
        ttl: 3600,
        proxied: false
    };

    try {
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            dkimRecord,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            console.log(`✅ Created DKIM record for ${domainName}`);
            console.log(`   Selector: ${dkimInfo.selector}`);
            console.log(`   Name: ${dkimRecordName}`);
            console.log(`   Content: ${dkimContent.substring(0, 60)}...`);
            if (dkimInfo.generated) {
                console.log(`   Note: DKIM key was newly generated by Postal`);
            }
            return true;
        } else {
            console.log(`❌ Failed to create DKIM record: ${response.data.errors?.[0]?.message}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Error creating DKIM record: ${error.message}`);
        return false;
    }
}

/* ---------------- Verify Cloudflare DNS Records ---------------- */
async function verifyCloudflareDNS(cloudflareConfig) {
    console.log("\n🔍 Verifying Cloudflare DNS records...");

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

            console.log(`📋 Found ${domainRecords.length} DNS records for ${domain}:`);

            const byType = {};
            domainRecords.forEach(record => {
                if (!byType[record.type]) byType[record.type] = [];
                byType[record.type].push(record);
            });

            Object.keys(byType).sort().forEach(type => {
                console.log(`\n${type} Records:`);
                byType[type].forEach(record => {
                    const displayContent = record.content.length > 50 ?
                        record.content.substring(0, 50) + '...' : record.content;
                    console.log(`  ${record.name} -> ${displayContent} (TTL: ${record.ttl})`);
                });
            });

        }
    } catch (error) {
        console.log("❌ Failed to verify DNS records:", error.message);
    }
}

async function checkSPFRecordExists(cloudflareConfig, domainName) {
    console.log("🔍 Checking if SPF record already exists...");

    const { zoneId, apiToken } = cloudflareConfig;

    try {
        const response = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    type: 'TXT',
                    name: domainName,
                    per_page: 100
                }
            }
        );

        if (response.data.success) {
            const records = response.data.result;

            // Check if any TXT record contains SPF
            for (const record of records) {
                if (record.type === 'TXT' && record.content.includes('v=spf1')) {
                    console.log(`✅ SPF record already exists: ${record.content.substring(0, 50)}...`);
                    return true;
                }
            }

            console.log("ℹ️  No existing SPF record found");
            return false;
        }

        return false;

    } catch (error) {
        console.log(`⚠️  Could not check SPF records: ${error.message}`);
        return false;
    }
}
async function createOrUpdateSPFRecord(cloudflareConfig, domainName) {
    console.log("🔐 Setting up SPF record in Cloudflare...");

    const { zoneId, apiToken } = cloudflareConfig;

    // Check if SPF already exists
    const spfExists = await checkSPFRecordExists(cloudflareConfig, domainName);

    if (spfExists) {
        console.log("✅ SPF record already exists - skipping creation");
        return true;
    }

    // Create new SPF record without quotes around content
    const spfRecord = {
        type: "TXT",
        name: domainName,
        content: "v=spf1 mx a ~all",  // No quotes here - Cloudflare API handles it
        ttl: 3600,
        proxied: false
    };

    try {
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            spfRecord,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            console.log(`✅ Created SPF record for ${domainName}`);
            console.log(`   Content: v=spf1 mx a ~all`);
            return true;
        } else {
            console.log(`❌ Failed to create SPF record: ${response.data.errors?.[0]?.message}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Error creating SPF record: ${error.message}`);
        return false;
    }
}

async function checkDKIMRecordExists(cloudflareConfig, domainName, selector) {
    console.log(`🔍 Checking if DKIM record already exists for selector: ${selector}...`);

    const { zoneId, apiToken } = cloudflareConfig;
    const dkimRecordName = `${selector}._domainkey.${domainName}`;

    try {
        const response = await axios.get(
            `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    type: 'TXT',
                    name: dkimRecordName,
                    per_page: 100
                }
            }
        );

        if (response.data.success) {
            const records = response.data.result;

            if (records.length > 0) {
                console.log(`✅ DKIM record already exists: ${dkimRecordName}`);
                for (const record of records) {
                    console.log(`   Content: ${record.content.substring(0, 60)}...`);
                }
                return true;
            }

            console.log(`ℹ️  No existing DKIM record found for ${dkimRecordName}`);
            return false;
        }

        return false;

    } catch (error) {
        console.log(`⚠️  Could not check DKIM records: ${error.message}`);
        return false;
    }
}

/* ---------------- Complete Domain Setup with Verification ---------------- */
async function setupDomainWithVerification(conn, serverPermalink, domainName, cloudflareConfig) {
    console.log(`🚀 Starting automated domain setup for "${domainName}"...`);

    // Step 1: Add domain to Postal
    const domainInfo = await addDomainToServer(conn, serverPermalink, domainName);
    if (!domainInfo) {
        console.log("❌ Failed to add domain to Postal");
        return null;
    }

    // If domain is already verified, skip verification steps
    if (domainInfo.verified) {
        console.log("✅ Domain is already verified in Postal");

        // Get DKIM from Postal
        const dkimInfo = await getDKIMFromPostal(conn, serverPermalink, domainName);

        return {
            domainName,
            verified: true,
            dkimInfo,
            message: "Domain was already verified"
        };
    }

    // Step 2: Create verification TXT record in Cloudflare
    if (!cloudflareConfig || !cloudflareConfig.zoneId || !cloudflareConfig.apiToken) {
        console.log("⚠️  No Cloudflare credentials - manual verification required");
        console.log(`   Add this TXT record to your DNS:`);
        console.log(`   Name: ${domainName}`);
        console.log(`   Content: postal-verification=${domainInfo.verificationToken}`);
        return { domainName, verified: false, needsManualVerification: true };
    }

    console.log("\n🔐 Setting up domain verification...");

    const verificationSuccess = await createVerificationRecord(
        cloudflareConfig,
        domainName,
        domainInfo.verificationToken
    );

    if (!verificationSuccess) {
        console.log("❌ Failed to create verification record");
        return { domainName, verified: false };
    }

    console.log("✅ Verification record created in Cloudflare");

    // Step 3: Wait longer for DNS propagation (Cloudflare can be slow)
    console.log("⏳ Waiting for DNS propagation (90 seconds - Cloudflare can be slow)...");
    await new Promise(resolve => setTimeout(resolve, 90000));

    // Step 4: Check verification status with detailed debugging
    console.log("\n🔍 Checking domain verification with detailed diagnostics...");
    const verified = await checkDomainVerificationStatus(conn, serverPermalink, domainName);

    if (!verified) {
        console.log("⚠️  Domain not verified yet. DNS might need more time...");
        console.log("⏳ Waiting additional 60 seconds for full propagation...");
        await new Promise(resolve => setTimeout(resolve, 60000));

        console.log("🔍 Final verification check...");
        const verifiedFinal = await checkDomainVerificationStatus(conn, serverPermalink, domainName);

        if (!verifiedFinal) {
            console.log("❌ Domain verification failed even after waiting");
            console.log("\n⚠️  POSSIBLE ISSUES:");
            console.log("   1. DNS propagation is still in progress (can take 5-30 minutes)");
            console.log("   2. TXT record format might be incorrect");
            console.log("   3. Postal's DNS checker might be rate-limited");
            console.log("\n💡 SUGGESTIONS:");
            console.log("   - Wait 5-10 minutes and run script again");
            console.log("   - Check Cloudflare DNS records manually");
            console.log("   - Verify domain manually in Postal web interface");
            return { domainName, verified: false, retryLater: true };
        }
    }

    console.log("✅ Domain verified successfully!");

    // Step 5: Get the newly generated DKIM from Postal
    const dkimInfo = await getDKIMFromPostal(conn, serverPermalink, domainName);

    return {
        domainName,
        verified: true,
        dkimInfo,
        message: "Domain verified and setup complete"
    };
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
        const serverPermalink = "verisence-tech";

        console.log(`\n🎯 Target Server Configuration:`);
        console.log(`   Name: ${serverName}`);
        console.log(`   Permalink: ${serverPermalink}`);

        if (config.cloudflare.zoneId && config.cloudflare.apiToken) {
            console.log(`   Cloudflare: Enabled`);
            console.log(`   Zone ID: ${config.cloudflare.zoneId.substring(0, 8)}...`);
            console.log(`   Domain: ${config.cloudflare.domain || serverName}`);
        } else {
            console.log(`   Cloudflare: Disabled - Check Sheet2 columns: CF_ZONE_ID, CF_API_TOKEN`);
        }

        // Connect SSH
        conn = await connectSSH(config.ssh);
        console.log("✅ SSH connection established");

        // Complete automated domain setup with verification
        if (config.cloudflare.zoneId && config.cloudflare.apiToken) {
            console.log("\n🚀 Starting automated domain setup with verification...");

            const result = await setupDomainWithVerification(
                conn,
                serverPermalink,
                serverName,
                config.cloudflare
            );

            if (result && result.verified) {
                console.log("\n✅ DOMAIN VERIFICATION COMPLETE!");

                // Create SPF record
                const spfCreated = await createOrUpdateSPFRecord(config.cloudflare, serverName);
                // Create DKIM record if available (only if doesn't exist)
                // Create DKIM record if available (only if doesn't exist)
                let dkimCreated = false;
                if (result.dkimInfo) {
                    dkimCreated = await createDKIMRecord(config.cloudflare, serverName, result.dkimInfo);
                }

                console.log("\n📝 Automated Setup Summary:");
                console.log("   1. ✅ Domain added to Postal");
                console.log("   2. ✅ Verification TXT record created in Cloudflare");
                console.log("   3. ✅ Domain verified in Postal");
                console.log(`   4. ${spfCreated ? '✅' : '⚠️'} SPF record ${spfCreated ? 'created/verified' : 'setup failed'}`);
                if (result.dkimInfo) {
                    console.log(`   5. ${dkimCreated ? '✅' : '⚠️'} DKIM record ${dkimCreated ? 'created/verified' : 'setup failed'}`);
                } else {
                    console.log("   5. ⚠️  DKIM record NOT created (no DKIM key available from Postal)");
                }
                // Verify all DNS records
                console.log("\n🔍 Final DNS verification:");
                await verifyCloudflareDNS(config.cloudflare);

                console.log("\n⚠️  DNS propagation may take 30-60 minutes to complete globally");

            } else if (result && result.needsManualVerification) {
                console.log("\n⚠️  MANUAL VERIFICATION REQUIRED");
                console.log("   Please add the verification TXT record shown above to your DNS");
                console.log("   Then run this script again to complete setup");
            } else if (result && result.retryLater) {
                console.log("\n⚠️  VERIFICATION PENDING");
                console.log("   DNS propagation is taking longer than expected");
                console.log("   Run this script again in 5-10 minutes");
            } else {
                console.log("\n❌ Domain setup failed");
            }
        } else {
            console.log("\n⚠️  Manual setup required (no Cloudflare credentials)");
            console.log("   Steps to complete manually:");
            console.log("   1. Add domain in Postal web interface");
            console.log("   2. Add verification TXT record to your DNS");
            console.log("   3. Verify domain in Postal");
            console.log("   4. Add SPF and DKIM records to DNS");
        }

        console.log("\n🔌 SSH connection closing...");

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