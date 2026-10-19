/**
 * n8n Cloud Automation Setup Script
 * Usage:
 *   node setup-n8n.js <N8N_INSTANCE_URL> <N8N_API_KEY>
 * Or with environment variables:
 *   N8N_URL=https://myinstance.app.n8n.cloud N8N_API_KEY=xxx node setup-n8n.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const n8nUrlInput = process.argv[2] || process.env.N8N_URL;
const apiKey = process.argv[3] || process.env.N8N_API_KEY;

if (!n8nUrlInput || !apiKey) {
  console.log(`
========================================================================
⚡ n8n Cloud Automated Folder & Workflow Provisioner
========================================================================
Usage:
  node setup-n8n.js <N8N_INSTANCE_URL> <N8N_API_KEY>

Examples:
  node setup-n8n.js https://my-team.app.n8n.cloud n8n_api_key_xxxxxxxx
  node setup-n8n.js https://fms.n8n.lexisolution.com n8n_api_key_xxxxxxxx
========================================================================
`);
  process.exit(1);
}

const n8nUrl = n8nUrlInput.replace(/\/+$/, '');

function apiRequest(endpoint, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(n8nUrl + endpoint);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const payload = data ? JSON.stringify(data) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch(e) { json = { raw: body }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json);
        } else {
          reject(new Error(`API Error [HTTP ${res.statusCode}]: ${JSON.stringify(json)}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log(`\n🔗 Connecting to n8n at: ${n8nUrl}`);

  // 1. Verify connection & check projects/folders
  let projectId = null;
  const folderName = 'Backup & Fleet Monitoring';

  try {
    console.log(`📁 Checking projects & folders for "${folderName}"...`);
    const projectsRes = await apiRequest('/api/v1/projects');
    const projects = projectsRes.data || projectsRes || [];
    const existing = projects.find(p => (p.name || '').toLowerCase() === folderName.toLowerCase());

    if (existing) {
      projectId = existing.id;
      console.log(`✅ Found existing folder: "${folderName}" (ID: ${projectId})`);
    } else {
      console.log(`📁 Creating new project folder: "${folderName}"...`);
      try {
        const createRes = await apiRequest('/api/v1/projects', 'POST', {
          name: folderName,
          type: 'team'
        });
        projectId = createRes.id || (createRes.data && createRes.data.id);
        console.log(`✅ Project folder created successfully! (ID: ${projectId})`);
      } catch (err) {
        console.log(`ℹ️ Project folder creation not available on current plan/license (workflows will be created in default project).`);
      }
    }
  } catch (err) {
    console.log(`ℹ️ Projects endpoint skipped (${err.message}). Proceeding directly with workflows.`);
  }

  // 2. Discover workflows in ./workflows directory
  const workflowsDir = path.join(__dirname, 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    console.error(`❌ Workflows directory not found at: ${workflowsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
  console.log(`\n📦 Found ${files.length} workflow files to upload:\n`);

  for (const file of files) {
    const filePath = path.join(workflowsDir, file);
    try {
      const wfData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const wfPayload = {
        name: wfData.name,
        nodes: wfData.nodes || [],
        connections: wfData.connections || {},
        settings: wfData.settings || {}
      };
      if (projectId) {
        wfPayload.projectId = projectId;
      }

      console.log(`⏳ Uploading: "${wfData.name}" (${file})...`);
      const created = await apiRequest('/api/v1/workflows', 'POST', wfPayload);
      const wfId = created.id || (created.data && created.data.id);
      console.log(`   ✅ Workflow created! ID: ${wfId}`);

      // Activate workflow if it has triggers
      try {
        await apiRequest(`/api/v1/workflows/${wfId}/activate`, 'POST');
        console.log(`   🟢 Activated!`);
      } catch(actErr) {
        console.log(`   ℹ️ (Workflow created in draft. Ready to activate after credentials check).`);
      }
    } catch (err) {
      console.error(`   ❌ Failed to upload ${file}:`, err.message);
    }
  }

  console.log(`\n🎉 All done! Folder "${folderName}" and workflows have been provisioned in n8n.`);
}

run().catch(err => {
  console.error('\n❌ Execution failed:', err);
  process.exit(1);
});
