// 云函数：图书识别
// 路线 A（免费）：微信云开发 OCR cloud.openapi.ocr.printedText + 自建书脊切分
// 路线 C（免费）：ISBN 连续扫码，由小程序端处理，不走本函数
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { action } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };
  if (action === 'ocrImage') return ocrImage(event);
  return { code: -1, msg: '未知操作' };
};

async function ocrImage(event) {
  const fileID = event.fileID;
  if (!fileID) return { code: -1, msg: '缺少图片' };

  let buffer;
  try {
    const dl = await cloud.downloadFile({ fileID });
    buffer = dl.fileContent;
  } catch (e) {
    return { code: -1, msg: '下载图片失败' };
  }

  let res;
  try {
    res = await cloud.openapi.ocr.printedText({
      type: 'photo',
      img: { contentType: 'image/jpeg', value: buffer }
    });
  } catch (e) {
    console.error('openapi ocr error', e);
    return { code: -1, msg: 'OCR 调用失败：' + (e.errMsg || e.message || '未知') + '（可改用连续扫码）' };
  }

  const items = (res && res.items) || (res && res.result && res.result.items) || [];
  if (!items.length) {
    return { code: 0, data: { books: [], note: '未识别到文字，请让书平放、书脊横向、清晰无遮挡后重拍' } };
  }
  return { code: 0, data: { books: segment(items) } };
}

// 把 OCR 文本框按坐标聚成「一本书」
function segment(items) {
  const blocks = [];
  items.forEach((it) => {
    const text = (it.text || '').trim();
    if (!text) return;
    const p = it.pos || {};
    const pts = [p.left_top, p.right_top, p.right_bottom, p.left_bottom].filter(
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
      .sort((a, b) => (a.cx - b.cx) || (a.cy - b.cy))
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
