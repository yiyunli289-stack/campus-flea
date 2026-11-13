// 展示辅助：时间/价格格式化 + 商品列表装饰（emoji、价格文本）
const CAT_EMOJI = { book: '📚', digital: '💻', life: '🧺', stationery: '✏️', sports: '🏀', clothes: '👕', other: '📦' };

function fmtPrice(n) {
  const num = Number(n) || 0;
  return num.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000 && now.getDate() === d.getDate()) return Math.floor(diff / 3600000) + '小时前';
  const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  if (d.getFullYear() === now.getFullYear()) return md;
  return d.getFullYear() + '-' + md;
}

function decorateGoods(list) {
  return (list || []).map((g) => ({
    ...g,
    emoji: CAT_EMOJI[g.cat] || '📦',
    priceText: fmtPrice(g.price)
  }));
}

module.exports = { fmtPrice, fmtTime, decorateGoods };
