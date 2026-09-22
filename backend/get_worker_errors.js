import { spawn } from 'child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  console.log('Starting local Wrangler Dev Worker...');
  const wranglerProcess = spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
    cwd: 'c:/Users/Aditya Jadhav/Desktop/Dump/Placement Monitoring/backend',
    shell: true,
    env: {
      ...process.env,
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '3306',
      DATABASE_USER: 'root',
      DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
      DATABASE_NAME: 'placement_monitoring',
      API_KEY: 'fca62d64a27546855b39922e967a1fb53086eb293c66f7f6a7cd67f8976a4dfc'
    }
  });

  let workerUp = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8787/health');
      if (res.status === 200) {
        workerUp = true;
        break;
      }
    } catch (e) {}
    await sleep(1000);
  }

  if (!workerUp) {
    console.error('Worker failed to start.');
    wranglerProcess.kill();
    process.exit(1);
  }

  console.log('Worker is up. Requesting failing routes...');

  const paths = [
    '/api/students',
    '/api/stats/analytics',
    '/api/reports/placements'
  ];

  for (const path of paths) {
    try {
      const res = await fetch(`http://127.0.0.1:8787${path}`);
      console.log(`\n--- Route: ${path} ---`);
      console.log('Status:', res.status);
      const data = await res.json();
      console.log('Body:', JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`Error requesting ${path}:`, err.message);
    }
  }

  wranglerProcess.kill();
  process.exit(0);
}

run();
