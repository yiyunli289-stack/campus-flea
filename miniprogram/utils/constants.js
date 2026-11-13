// 全局常量：校区 / 成色 / 交易方式 / 笔记等级 / 类目
const CAMPUS_LIST = ['江安校区', '望江校区', '华西校区'];
const CONDITIONS = ['全新', '几乎全新', '轻微使用', '明显使用'];
const TRADE_TYPES = ['定价', '竞价'];
const NOTE_LEVELS = ['无笔记', '少量', '较多', '大量'];

const CATEGORY_MAP = {
  book: { name: '图书教材', icon: '📚' },
  digital: { name: '数码电子', icon: '💻' },
  life: { name: '生活用品', icon: '🧺' },
  stationery: { name: '文具办公', icon: '✏️' },
  sports: { name: '运动户外', icon: '🏀' },
  clothes: { name: '服饰配件', icon: '👕' },
  other: { name: '其他', icon: '📦' }
};

module.exports = { CAMPUS_LIST, CONDITIONS, TRADE_TYPES, NOTE_LEVELS, CATEGORY_MAP };
