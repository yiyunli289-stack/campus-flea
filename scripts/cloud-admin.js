'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { adminHttp } = require('../shared/server/http');
const { runWorker } = require('../shared/server/worker');
const { collections } = require('../shared/server/defaults');

const dist = path.resolve(__dirname, '../admin-web/dist');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};
const responseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

async function checkCloud(service) {
  const counts = {};
  for (const name of collections) {
    try { counts[name] = await service.store.count(name); }
    catch (error) {
      const code = String(error.code || 'UNKNOWN').replace(/[^\w.-]/g, '');
      throw new Error(`云环境集合 ${name} 读取失败（${code}），请核对目标环境、集合和凭证。`);
    }
  }
  const [account, publicSettings, rules, products, pendingReports, auditHead] = await Promise.all([
    service.store.get('systemLocks', 'bootstrap'), service.store.get('settings', 'public'),
    service.store.get('settings', 'rules'),
    service.store.find('goods', {}, { limit: 1, fields: { title: true } }),
    service.store.count('reports', require('../shared/server/service').reportStateFilter('pending')),
    service.store.get('systemLocks', 'audit-head')
  ]);
  const initialized = !!account && !!publicSettings && !!rules;
  return { initialized, hasAudit: !!auditHead, goods: counts.goods, reports: counts.reports, pendingReports,
    sampledGoods: products.length, collections: collections.length };
}

async function serveStatic(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { ...responseHeaders, Allow: 'GET, HEAD' }).end();
    return;
  }
  // The only directly served paths are files emitted by Vite.
  const asset = /^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname) ? pathname.slice(1) : null;
  if (!asset && (pathname.startsWith('/assets/') || path.posix.extname(pathname))) {
    response.writeHead(404, responseHeaders).end();
    return;
  }
  const file = path.join(dist, asset || 'index.html');
  const stat = await fs.stat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile()) {
    response.writeHead(404, responseHeaders).end();
    return;
  }
  response.writeHead(200, {
    ...responseHeaders,
    'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).on('error', () => response.destroy()).pipe(response);
}

async function handle(service, request, response) {
  const { pathname } = new URL(request.url, service.env.ADMIN_ORIGIN);
  if (pathname === '/healthz' && request.method === 'GET') {
    response.writeHead(200, { ...responseHeaders, 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (!pathname.startsWith('/api/')) return serveStatic(request, response, pathname);
  if (!pathname.startsWith('/api/admin/')) {
    response.writeHead(404, responseHeaders).end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 128 * 1024) {
      response.writeHead(413, { ...responseHeaders, 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ code: 'BODY_TOO_LARGE', msg: '请求体超过大小限制' }));
      request.resume();
      return;
    }
    chunks.push(chunk);
  }
  const result = await adminHttp(service, {
    path: request.url, httpMethod: request.method, headers: request.headers,
    body: Buffer.concat(chunks).toString('utf8'),
    requestContext: { sourceIp: request.socket.remoteAddress }
  });
  response.writeHead(result.statusCode, { ...responseHeaders, ...result.headers }).end(result.body);
}

function createServer(service) {
  return http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (request, response) => {
    handle(service, request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(500, responseHeaders).end();
    });
  });
}

async function main(env = process.env) {
  const { context } = require('./cloud-context');
  const { service } = context(env);
  const result = await checkCloud(service);
  console.log(JSON.stringify({ environment: env.TCB_ENV, ...result }));
  if (process.argv.includes('--check')) return;
  if (!result.initialized) throw new Error('请先运行 npm run bootstrap:cloud -- --apply，初始化配置和首位管理员');

  const host = env.ADMIN_HOST || '127.0.0.1';
  const port = Number(env.PORT || 8788);
  const production = env.NODE_ENV === 'production';
  const origin = new URL(env.ADMIN_ORIGIN || `http://127.0.0.1:${port}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      (production && origin.protocol !== 'https:') ||
      (!production && !['127.0.0.1', 'localhost', '::1'].includes(host))) {
    throw new Error('请核对后台监听地址、端口和 ADMIN_ORIGIN。生产访问地址必须使用 HTTPS。');
  }
  service.env = { ...env, ADMIN_ORIGIN: origin.origin };
  await fs.access(path.join(dist, 'index.html')).catch(() => { throw new Error('请先运行 npm run build'); });
  const server = createServer(service);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : '后台监听失败');
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`真实云库后台 ${origin.origin}`);
    if (env.ADMIN_RUN_WORKER === '1') {
      const poll = async () => {
        try { await runWorker(service, 10); }
        catch (error) { console.error('治理队列执行失败', String(error.code || 'UNKNOWN').replace(/[^\w.-]/g, '')); }
        finally { setTimeout(poll, 15_000).unref(); }
      };
      void poll();
    }
  });
}

if (require.main === module) {
  main().then(() => {
    if (process.argv.includes('--check')) process.exit(0);
  }, error => {
    console.error(error instanceof TypeError ? '后台配置格式无效' : error.message);
    process.exit(1);
  });
}

module.exports = { createServer };
