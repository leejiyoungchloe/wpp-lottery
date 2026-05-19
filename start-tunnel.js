const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 5173;

console.log('正在启动 Cloudflare Tunnel，请稍候...\n');

const cf = spawn('npx', ['cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['inherit', 'pipe', 'pipe']
});

let urlFound = false;

function tryExtractUrl(data) {
  if (urlFound) return;
  const match = data.toString().match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
  if (match) {
    urlFound = true;
    const tunnelUrl = match[1];
    console.log('');
    console.log('======================================');
    console.log(' Cloudflare Tunnel 已就绪！');
    console.log('');
    console.log(` 扫码链接: ${tunnelUrl}`);
    console.log('======================================');
    console.log('');

    const server = spawn(process.argv[0], ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, TUNNEL_URL: tunnelUrl },
      stdio: 'inherit'
    });

    server.on('exit', (code) => {
      cf.kill();
      process.exit(code != null ? code : 0);
    });
  }
}

cf.stdout.on('data', tryExtractUrl);
cf.stderr.on('data', tryExtractUrl);

cf.on('exit', (code) => {
  if (!urlFound) {
    console.error('\n错误：Cloudflare Tunnel 异常退出，未能获取公网链接');
    console.error('请确保网络可访问 Cloudflare，然后重试。');
    process.exit(1);
  }
});

setTimeout(() => {
  if (!urlFound) {
    console.error('\n错误：未能获取 Cloudflare Tunnel URL（超时 60 秒）');
    cf.kill();
    process.exit(1);
  }
}, 60000);
