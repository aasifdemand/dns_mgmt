#!/usr/bin/env node

import axios from "axios";
import readline from "readline";
import dotenv from "dotenv";


dotenv.config();
// Create readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Configuration - Load API key from environment variable
const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
    console.error('❌ Error: INSTANTLY_API_KEY environment variable is not set');
    process.exit(1);
}

// Base URL for Instantly API
const BASE_URL = 'https://api.instantly.ai/api/v1';

// Headers for API requests
const headers = {
    'Authorization': API_KEY,
    'Content-Type': 'application/json'
};

// Ask a question and return promise with answer
function askQuestion(query) {
    return new Promise(resolve => {
        rl.question(query, answer => {
            resolve(answer.trim());
        });
    });
}

// Validate domain format
function validateDomain(domain) {
    // Simple domain validation
    const domainRegex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,}$/;
    return domainRegex.test(domain) || domain.includes('.');
}

async function addDomainToWarmup() {
    try {
        console.log('📧 Instantly.ai Domain Warmup Script\n');

        // Ask for domain
        let domain = await askQuestion('🔗 Enter the domain to warmup (e.g., example.com): ');

        // Validate domain
        while (!validateDomain(domain)) {
            console.log('❌ Invalid domain format. Please enter a valid domain like "example.com"');
            domain = await askQuestion('🔗 Enter the domain to warmup: ');
        }

        // Ask for daily limit
        let dailyLimitInput = await askQuestion('📊 Enter daily email limit (press Enter for default 50): ');
        let dailyLimit = dailyLimitInput ? parseInt(dailyLimitInput) : 50;

        // Validate daily limit
        while (isNaN(dailyLimit) || dailyLimit <= 0) {
            console.log('❌ Please enter a valid number greater than 0');
            dailyLimitInput = await askQuestion('📊 Enter daily email limit: ');
            dailyLimit = dailyLimitInput ? parseInt(dailyLimitInput) : 50;
        }

        console.log(`\n📝 Summary:`);
        console.log(`   Domain: ${domain}`);
        console.log(`   Daily Limit: ${dailyLimit} emails`);

        // Confirm before proceeding
        const confirm = await askQuestion('\n✅ Proceed with adding domain to warmup? (yes/no): ');

        if (!confirm.toLowerCase().startsWith('y')) {
            console.log('❌ Operation cancelled');
            rl.close();
            return;
        }

        console.log(`\n🚀 Adding domain "${domain}" to warmup...`);

        // Step 1: Add domain to warmup
        console.log('\n📝 Step 1: Adding domain to warmup system...');
        const addResponse = await axios.post(
            `${BASE_URL}/warmup/domain/add`,
            {
                domain: domain,
                daily_limit: dailyLimit
            },
            { headers }
        );

        console.log('✅ Domain added successfully!');

        if (addResponse.data.message) {
            console.log(`📋 Message: ${addResponse.data.message}`);
        }

        if (addResponse.data.warmup_id) {
            console.log(`🔑 Warmup ID: ${addResponse.data.warmup_id}`);
        }

        // Wait a moment for the system to process
        console.log('\n⏳ Waiting for warmup status...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Step 2: Check warmup status
        console.log('\n📊 Step 2: Checking warmup status...');
        try {
            const statusResponse = await axios.get(
                `${BASE_URL}/warmup/status`,
                {
                    headers,
                    params: { domain: domain }
                }
            );

            console.log('📈 Warmup Status:');
            const statusData = statusResponse.data;

            // Handle different response formats
            if (statusData.domains && statusData.domains[domain]) {
                const domainInfo = statusData.domains[domain];
                console.log(`   🔗 Domain: ${domain}`);
                console.log(`   📍 Status: ${domainInfo.status || 'Active'}`);
                console.log(`   📊 Daily Limit: ${domainInfo.daily_limit || dailyLimit}`);
                console.log(`   📨 Emails Sent Today: ${domainInfo.sent_today || 0}`);
                console.log(`   📈 Warmup Progress: ${domainInfo.warmup_progress || '0%'}`);

                if (domainInfo.warmup_duration) {
                    console.log(`   ⏱️  Warmup Duration: ${domainInfo.warmup_duration} days`);
                }
            } else if (statusData[domain]) {
                const domainInfo = statusData[domain];
                console.log(`   🔗 Domain: ${domain}`);
                console.log(`   📍 Status: ${domainInfo.status || 'Active'}`);
                console.log(`   📊 Daily Limit: ${domainInfo.daily_limit || dailyLimit}`);
                console.log(`   📨 Emails Sent Today: ${domainInfo.sent_today || 0}`);
            } else {
                console.log('   ℹ️  Domain registered successfully');
                console.log('   📋 Full Response:', JSON.stringify(statusData, null, 2));
            }
        } catch (error) {
            console.log('   ⚠️  Could not fetch detailed status, but domain was added');
        }

        // Step 3: Get all warming domains
        console.log('\n🌐 Step 3: Listing all your warming domains...');
        try {
            const allDomainsResponse = await axios.get(
                `${BASE_URL}/warmup/domains`,
                { headers }
            );

            if (allDomainsResponse.data && Array.isArray(allDomainsResponse.data)) {
                const domains = allDomainsResponse.data;
                console.log(`   📊 Total warming domains in your account: ${domains.length}`);

                if (domains.length > 0) {
                    console.log('\n   📋 Your Warming Domains:');
                    domains.forEach((domainItem, index) => {
                        const domainName = domainItem.domain || domainItem.name || domainItem;
                        const domainStatus = domainItem.status || 'Active';
                        const warmupProgress = domainItem.warmup_progress ? ` (${domainItem.warmup_progress})` : '';
                        console.log(`   ${index + 1}. ${domainName} - ${domainStatus}${warmupProgress}`);
                    });
                }
            } else if (allDomainsResponse.data.domains) {
                const domains = allDomainsResponse.data.domains;
                console.log(`   📊 Total warming domains: ${domains.length}`);

                if (domains.length > 0) {
                    console.log('\n   📋 Domains List:');
                    Object.entries(domains).forEach(([domainName, domainInfo], index) => {
                        console.log(`   ${index + 1}. ${domainName} - ${domainInfo.status || 'Active'}`);
                    });
                }
            }
        } catch (error) {
            console.log('   ℹ️  Could not fetch all domains list, but your domain was added');
        }

        console.log('\n🎉 Domain warmup process initiated successfully!');
        console.log('\n📌 Next Steps:');
        console.log('   1. Monitor deliverability in your Instantly dashboard');
        console.log('   2. The warmup process typically takes 30-60 days');
        console.log('   3. Start with lower volumes and gradually increase');
        console.log(`   4. Domain: ${domain} will now send up to ${dailyLimit} emails/day`);

        console.log('\n🔗 You can check status anytime by running:');
        console.log(`   node warmup.js`);

    } catch (error) {
        console.error('\n❌ Error occurred:');

        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Message: ${error.response.data?.message || 'Unknown error'}`);

            if (error.response.data?.error) {
                console.error(`   Details: ${error.response.data.error}`);
            }

            if (error.response.status === 401) {
                console.error('\n   ⚠️  Check your API key is correct and has proper permissions');
            }
        } else if (error.request) {
            console.error('   No response received. Check your internet connection.');
        } else {
            console.error(`   ${error.message}`);
        }

        console.log('\n💡 Tips:');
        console.log('   - Ensure the domain is verified in your Instantly account');
        console.log('   - Check API key permissions');
        console.log('   - Verify domain DNS records are properly set');
    } finally {
        rl.close();
    }
}

// Main execution
async function main() {
    try {
        await addDomainToWarmup();
    } catch (error) {
        console.error('Unexpected error:', error.message);
        rl.close();
        process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\n👋 Operation cancelled by user');
    rl.close();
    process.exit(0);
});

// Start the script
main();