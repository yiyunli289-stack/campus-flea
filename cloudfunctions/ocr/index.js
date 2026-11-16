// 云函数：图书识别 + ISBN 书目查询
// 路线 A（免费）：微信云开发 OCR cloud.openapi.ocr.printedText + 自建书脊切分
// 路线 C（免费）：ISBN 连续扫码；isbnLookup 用豆瓣 ISBN 页补齐书名/作者/出版社/封面
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MEM = Object.create(null); // 单实例内存缓存，避免重复请求豆瓣
const MEM_TTL = 6 * 60 * 60 * 1000;

exports.main = async (event) => {
  const { action } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  if (action === 'ocrImage') return ocrImage(event);
  if (action === 'isbnLookup') return isbnLookup(event);
  if (action === 'isbnBatch') return isbnBatch(event);
  if (action === 'diag') return diag();
  return { code: -1, msg: '未知操作' };
}

/* ============================== 自检 ============================== */

// 返回云函数环境信息 + 一次真实的 OCR 云调用结果，用来定位「调用失败」的具体原因
async function diag() {
  let sdkVersion = '';
  try {
    sdkVersion = require('wx-server-sdk/package.json').version || '';
  } catch (e) { /* ignore */ }

  let config = null;
  try {
    config = JSON.parse(require('fs').readFileSync(__dirname + '/config.json', 'utf8'));
  } catch (e) { /* ignore */ }

  const out = {
    sdkVersion,
    hasOpenapi: !!(cloud.openapi && cloud.openapi.ocr && cloud.openapi.ocr.printedText),
    config,
    node: process.version
  };

  // 1x1 PNG，只用来验证「云调用是否被授权」；图片本身过小，OCR 可能返回空或格式错误
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  try {
    const r = await cloud.openapi.ocr.printedText({
      type: 'photo',
      img: { contentType: 'image/png', value: png1x1 }
    });
    out.ocrTest = { ok: true, items: ((r && r.items) || []).length };
  } catch (e) {
    const errMsg = (e && (e.errMsg || e.message)) || String(e);
    const errCode = (e && (e.errCode || e.code)) || '';
    out.ocrTest = { ok: false, errCode, errMsg };
    if (/101003|market quota/i.test(errMsg + ' ' + errCode)) {
      out.ocrTest.hint = 'needs_activate';
      out.ocrTest.note = '接口已授权，但微信服务市场的 OCR 服务未订购，免费额度未生效';
    }
    console.error('diag ocr error:', e);
  }
  return { code: 0, data: out };
};

/* ============================ ISBN 书目查询 ============================ */

async function isbnLookup(event) {
  const isbn = normalizeIsbn(event.isbn);
  if (!isbn) return { code: -1, msg: 'ISBN 位数不对（需 10 或 13 位）' };

  const book = await lookupIsbn(isbn);
  return { code: 0, data: book };
}

async function isbnBatch(event) {
  const list = Array.from(new Set((event.isbns || []).map(normalizeIsbn).filter(Boolean))).slice(0, 20);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await lookupIsbn(list[i]));
    if (i < list.length - 1) await sleep(200);
  }
  return { code: 0, data: { list: out } };
}

async function lookupIsbn(isbn) {
  const hit = MEM[isbn];
  if (hit && Date.now() - hit.t < MEM_TTL) return hit.data;

  // 先验校验位：豆瓣对非法 ISBN 会回退到无关条目
  if (!to13(isbn)) {
    const bad = { isbn, found: false, note: 'ISBN 校验位不正确，请核对条码' };
    MEM[isbn] = { t: Date.now(), data: bad };
    return bad;
  }

  let book;
  try {
    const html = await fetchText('https://book.douban.com/isbn/' + isbn + '/', {
      referer: 'https://book.douban.com/'
    });
    book = parseDouban(html, isbn);
  } catch (e) {
    console.error('douban lookup failed', isbn, e && (e.message || e.errMsg));
    book = { isbn, found: false, note: '书目服务暂时不可用，可稍后重试或手填' };
  }

  if (book.found && book.coverUrl) {
    book.coverFileID = await cacheCover(isbn, book.coverUrl);
  }
  delete book.coverUrl;

  MEM[isbn] = { t: Date.now(), data: book };
  return book;
}

function parseDouban(html, isbn) {
  if (!html || html.length < 800) return { isbn, found: false };

  const og = (prop) => {
    const m = html.match(new RegExp('<meta property="og:' + prop + '" content="([^"]*)"'));
    return m ? decodeHtml(m[1]).trim() : '';
  };

  let ld = null;
  const mld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (mld) {
    try {
      ld = JSON.parse(mld[1]);
    } catch (e) {
      ld = null;
    }
  }

  const title = ((ld && ld.name) || og('title') || '').trim();
  if (!title) return { isbn, found: false };

  // 豆瓣条目自带 ISBN 时做一次交叉校验，避免拿到错书
  const ldIsbn = ld && ld.isbn ? normalizeIsbn(ld.isbn) : '';
  if (ldIsbn && to13(ldIsbn) && to13(ldIsbn) !== to13(isbn)) {
    return { isbn, found: false, note: '豆瓣条目与 ISBN 不一致' };
  }

  let author = '';
  if (ld && Array.isArray(ld.author)) {
    author = ld.author
      .map((a) => (a && a.name ? a.name : ''))
      .filter(Boolean)
      .join(' / ');
  }
  if (!author) author = infoValue(html, '作者');

  const priceText = infoValue(html, '定价');
  const priceM = priceText.match(/(\d+(?:\.\d+)?)/);

  return {
    isbn,
    found: true,
    title,
    author,
    publisher: infoValue(html, '出版社'),
    pubDate: infoValue(html, '出版时间'),
    price: priceM ? Number(priceM[1]) : 0,
    summary: og('description').slice(0, 120),
    coverUrl: og('image'),
    url: og('url'),
    source: 'douban'
  };
}

// 取 douban 详情页 #info 区块里的字段，如「出版社」「出版时间」「定价」
function infoValue(html, label) {
  const re = new RegExp(
    '<span class="pl">\\s*' + label + '\\s*:?\\s*</span>\\s*([\\s\\S]{0,300}?)(?:<br\\s*/?>|</div>)',
    'i'
  );
  const m = html.match(re);
  if (!m) return '';
  return decodeHtml(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// 豆瓣封面有防盗链，必须带 Referer 下载，再转存到云存储
async function cacheCover(isbn, url) {
  try {
    const buf = await fetchBuffer(url, { referer: 'https://book.douban.com/' });
    if (!buf || buf.length < 1000) return '';
    const up = await cloud.uploadFile({
      cloudPath: 'covers/' + isbn + '.jpg',
      fileContent: buf
    });
    return up.fileID || '';
  } catch (e) {
    console.error('cover cache failed', isbn, e && (e.message || e.errMsg));
    return '';
  }
}

/* ============================== ISBN 工具 ============================== */

function normalizeIsbn(raw) {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/[^0-9X]/g, '');
  return s.length === 10 || s.length === 13 ? s : '';
}

function isbn13Valid(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

function isbn10Valid(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  sum += s[9] === 'X' ? 10 : Number(s[9]);
  return sum % 11 === 0;
}

// 统一成 13 位用于比较；非法返回 ''
function to13(s) {
  const n = normalizeIsbn(s);
  if (!n) return '';
  if (n.length === 13) return isbn13Valid(n) ? n : '';
  if (!isbn10Valid(n)) return '';
  const core = '978' + n.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

/* ============================ 拍照 OCR 识别 ============================ */

// 按文件头判断真实图片类型，避免把 png/webp 当成 jpeg 传给 OCR
function sniffImageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

async function ocrImage(event) {
  const fileID = event.fileID;
  if (!fileID) return { code: -1, msg: '缺少图片' };

  let buffer;
  try {
    const dl = await cloud.downloadFile({ fileID });
    buffer = dl.fileContent;
  } catch (e) {
    return { code: -1, msg: '下载图片失败：' + ((e && (e.errMsg || e.message)) || '') };
  }
  if (!buffer || !buffer.length) return { code: -1, msg: '图片为空，请重新选择' };
  if (buffer.length > 4 * 1024 * 1024) return { code: -1, msg: '图片过大（>4MB），请压缩后重试' };

  if (!(cloud.openapi && cloud.openapi.ocr && cloud.openapi.ocr.printedText)) {
    return {
      code: -1,
      msg: '当前 cloud 环境没有 openapi.ocr：请在云端重新安装依赖（wx-server-sdk ≥ 2.6.3）后重启云函数'
    };
  }

  let res;
  try {
    res = await cloud.openapi.ocr.printedText({
      type: 'photo',
      img: { contentType: sniffImageType(buffer), value: buffer }
    });
  } catch (e) {
    console.error('openapi ocr error', e);
    const raw = (e && (e.errMsg || e.message)) || String(e);
    const code = (e && (e.errCode || e.code)) || '';
    const tag = (raw + ' ' + code).toLowerCase();

    if (/48001|unauthor|scope|permission|权限|not authorized|未授权/.test(tag)) {
      return {
        code: -1,
        msg:
          'OCR 云调用未授权（' + (code || raw) + '）。先确认 cloudfunctions/ocr/config.json 已声明 ocr.printedText 权限，' +
          '并右键 ocr → 上传并部署（云端安装依赖）；若仍报 48001，说明该小程序没有 OCR 接口权限（常见于个人主体/未认证账号），' +
          '这种情况拍照识别不可用，请改用 ISBN 连续扫码。'
      };
    }
    // 101003 = not enough market quota：OCR 服务未在微信服务市场订购，免费额度根本没生效
    if (/101003|market quota/.test(tag)) {
      return {
        code: -1,
        needActivate: true,
        msg:
          '微信 OCR 服务尚未开通（101003 服务市场配额不足）。免费额度需要先在小程序管理后台「服务市场」' +
          '0 元订购「通用印刷体识别」才会生效；未开通前请改用下方的 ISBN 连续扫码，扫码不依赖这个服务。'
      };
    }
    if (/45009|quota|limit|超出|频率|beyond/.test(tag)) {
      return { code: -1, msg: 'OCR 今日免费额度已用完或调用过于频繁（' + (code || raw) + '），请明天再试或改用 ISBN 扫码' };
    }
    if (/-501000|not found|ResourceNotFound/i.test(tag)) {
      return { code: -1, msg: 'ocr 云函数不存在（-501000）：请确认已部署到当前环境 cloud1-d5gody0jj8418ae20' };
    }
    return {
      code: -1,
      msg: 'OCR 调用失败：' + raw + (code ? '（' + code + '）' : '') + '（可改用连续扫码）',
      errCode: code,
      errMsg: raw
    };
  }

  const items = (res && res.items) || (res && res.result && res.result.items) || [];
  if (!items.length) {
    return {
      code: 0,
      data: { books: [], note: '未识别到文字，请让书平放、书脊横向、清晰无遮挡后重拍' }
    };
  }
  return { code: 0, data: { books: segment(items) } };
}

/* ============================== 书脊切分 ============================== */

// 把 OCR 文本框按坐标聚成「一本书」
function segment(items) {
  const blocks = [];
  items.forEach((it) => {
    const text = (it.text || '').trim();
    if (!text) return;
    // wx-server-sdk 会把返回结果的下划线字段转成驼峰：left_top → leftTop，两种都兼容
    const p = it.pos || {};
    const pick = (a, b) => p[a] || p[b];
    const pts = [pick('leftTop', 'left_top'), pick('rightTop', 'right_top'), pick('rightBottom', 'right_bottom'), pick('leftBottom', 'left_bottom')].filter(
      (q) => q && typeof q.x === 'number'
    );
    if (pts.length === 4) {
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      blocks.push({
        text,
        cx: xs.reduce((a, b) => a + b, 0) / 4,
        cy: ys.reduce((a, b) => a + b, 0) / 4,
        h: Math.max.apply(null, ys) - Math.min.apply(null, ys)
      });
    } else {
      blocks.push({ text, cx: 0, cy: 0, h: 0 });
    }
  });
  if (!blocks.length) return [];

  // 无坐标兜底：整张图当一本
  if (blocks.every((b) => b.h === 0)) {
    return [buildBook(blocks.map((b) => b.text))];
  }

  const medH = median(blocks.map((b) => b.h)) || 20;
  const gap = medH * 1.6;

  // 先按 y（书横放、书脊横向 → 每本书是一条横向带）聚类
  let groups = cluster1D(blocks, 'cy', gap);
  // 若只聚出 1 组，再试按 x（书竖放、书脊并排）
  if (groups.length === 1 && blocks.length > 3) {
    const gx = cluster1D(blocks, 'cx', gap);
    if (gx.length > groups.length) groups = gx;
  }

  return groups.map((g) => {
    const lines = g
      .slice()
      .sort((a, b) => a.cx - b.cx || a.cy - b.cy)
      .map((b) => b.text);
    return buildBook(lines);
  });
}

function cluster1D(blocks, key, gap) {
  const sorted = blocks.slice().sort((a, b) => a[key] - b[key]);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][key] - sorted[i - 1][key] > gap) {
      groups.push(cur);
      cur = [sorted[i]];
    } else {
      cur.push(sorted[i]);
    }
  }
  groups.push(cur);
  return groups;
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// 一组文本行 → 一本书候选
function buildBook(lines) {
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const joined = clean.join(' ');
  const isbnM = joined.match(/97[89]\d{10}/);

  const title = clean.slice().sort((a, b) => b.length - a.length)[0] || '';
  const publisher = clean.find((l) => /出版|出版社|Press|Publishing/i.test(l)) || '';
  const author = clean.find((l) => /著|编著|主编|编|Author|ed\./i.test(l)) || '';

  let confidence = 0.5;
  if (isbnM) confidence += 0.3;
  if (title.length >= 4) confidence += 0.15;

  return {
    title,
    author,
    publisher,
    edition: '',
    isbn: isbnM ? isbnM[0] : '',
    raw: clean,
    confidence: Math.min(0.98, confidence)
  };
}

/* ============================== HTTP 工具 ============================== */

function headers(opts) {
  const h = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  if (opts && opts.referer) h.Referer = opts.referer;
  return h;
}

function fetchText(url, opts, redirects) {
  opts = opts || {};
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers(opts) }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 4) {
        res.resume();
        let next = res.headers.location;
        if (next.charAt(0) === '/') next = 'https://book.douban.com' + next;
        return resolve(fetchText(next, opts, redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 3e6) req.destroy(new Error('response too large'));
      });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function fetchBuffer(url, opts, redirects) {
  opts = opts || {};
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers(opts) }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 4) {
        res.resume();
        let next = res.headers.location;
        if (next.charAt(0) === '/') next = 'https://book.douban.com' + next;
        return resolve(fetchBuffer(next, opts, redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
