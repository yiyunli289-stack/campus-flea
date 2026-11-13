// ============================================
// 测试版 mock 数据（后续接云数据库后整体替换）
// 字段对齐需求文档 Table 26：商品 Listing + 图书扩展 BookListing
// ============================================

const MOCK_GOODS = [
  {
    id: 'g1', cat: 'digital', tradeType: '定价', allowBargain: true,
    title: '九成新苹果 iPad 第9代 64G', price: '1299', condition: '九成新',
    campus: '江安', cover: '#2b3a55', emoji: '💻', images: ['#2b3a55', '#3a4c6b', '#4a5f80'],
    desc: '自用 iPad 第9代 64G Wi-Fi 版，无磕碰无维修，配原装充电器，可当面验机。',
    seller: { name: '阿柠', college: '计算机学院（软件学院）', avatar: '🧑' },
    time: '今天 10:20'
  },
  {
    id: 'g2', cat: 'digital', tradeType: '定价', allowBargain: false,
    title: '小米充电宝 20000mAh', price: '45', condition: '八成新',
    campus: '望江', cover: '#e07a5f', emoji: '🔋', images: ['#e07a5f', '#f0a080'],
    desc: '小米充电宝 20000mAh，支持双向快充，自用半年，正常使用痕迹。',
    seller: { name: '小周', college: '电子信息学院', avatar: '👦' },
    time: '今天 09:05'
  },
  {
    id: 'g3', cat: 'life', tradeType: '竞价', allowBargain: true,
    title: '宿舍懒人沙发椅', price: '60', condition: '七成新',
    campus: '江安', cover: '#81b29a', emoji: '🛋️', images: ['#81b29a', '#9cc4b0'],
    desc: '懒人沙发椅，可折叠，毕业离校出，价格好商量，宿舍自提。',
    seller: { name: '阿杰', college: '化学工程学院', avatar: '🧔' },
    time: '昨天 21:40'
  },
  {
    id: 'g4', cat: 'sports', tradeType: '定价', allowBargain: true,
    title: '羽毛球拍一副（带球包）', price: '80', condition: '九成新',
    campus: '望江', cover: '#3d5a80', emoji: '🏸', images: ['#3d5a80', '#4d6d94'],
    desc: '尤尼克斯球拍一副，线刚换过，附球包和一筒球。',
    seller: { name: '小李', college: '体育学院', avatar: '🏃' },
    time: '昨天 18:00'
  },
  {
    id: 'g5', cat: 'clothes', tradeType: '定价', allowBargain: true,
    title: '秋冬卫衣 L码 仅穿两次', price: '55', condition: '九成新',
    campus: '江安', cover: '#5f6c7b', emoji: '👕', images: ['#5f6c7b', '#6f7c8b'],
    desc: '加绒卫衣 L 码，颜色百搭，仅穿两次，无起球。',
    seller: { name: '小陈', college: '法学院', avatar: '👧' },
    time: '3 天前'
  },
  {
    id: 'g6', cat: 'stationery', tradeType: '竞价', allowBargain: true,
    title: '护眼台灯 可调光', price: '25', condition: '八成新',
    campus: '望江', cover: '#a68a64', emoji: '💡', images: ['#a68a64', '#b89a74'],
    desc: '护眼台灯，三档调光，触摸开关，毕业出。',
    seller: { name: '小王', college: '文学院', avatar: '👩' },
    time: '3 天前'
  }
];

const MOCK_BOOKS = [
  {
    id: 'b1', cat: 'book', tradeType: '定价', allowBargain: true,
    title: '高等数学（第七版）同济', price: '15', condition: '少量笔记',
    campus: '江安', cover: '#B4100A', emoji: '📕', images: ['#B4100A', '#8E0D08'],
    isbn: '9787040396638', author: '同济大学数学系', publisher: '高等教育出版社', edition: '第七版',
    college: '数学学院', course: '高等数学A',
    noteLevel: '少量', noteDesc: '前两章有少量划线，无答案填写',
    defects: '书脊轻微磨损',
    innerPhotos: ['#c46a5a', '#d08a7a'],
    desc: '大一高数教材，课堂笔记少量，不影响阅读使用。',
    seller: { name: '小胡', college: '电气工程学院', avatar: '👩' },
    time: '昨天 22:10'
  },
  {
    id: 'b2', cat: 'book', tradeType: '定价', allowBargain: false,
    title: '大学物理（上下册）', price: '20', condition: '无笔记',
    campus: '望江', cover: '#7a4e2d', emoji: '📗', images: ['#7a4e2d', '#8a5e3d'],
    isbn: '9787040209773', author: '张三慧', publisher: '清华大学出版社', edition: '第三版',
    college: '物理学院', course: '大学物理',
    noteLevel: '无笔记', noteDesc: '全新未使用',
    defects: '无',
    innerPhotos: [],
    desc: '大学物理上下册，几乎全新，无任何笔记。',
    seller: { name: '小林', college: '建筑与环境学院', avatar: '👨' },
    time: '昨天 20:30'
  },
  {
    id: 'b3', cat: 'book', tradeType: '竞价', allowBargain: true,
    title: '数据结构（C语言版）', price: '18', condition: '较多笔记',
    campus: '江安', cover: '#2f6d5a', emoji: '📘', images: ['#2f6d5a', '#3f7d6a'],
    isbn: '9787302251446', author: '严蔚敏', publisher: '清华大学出版社', edition: '第二版',
    college: '计算机学院（软件学院）', course: '数据结构',
    noteLevel: '较多', noteDesc: '多个章节有划线批注和答案填写',
    defects: '封面边角有折痕',
    innerPhotos: ['#3a8a72', '#4a9a82', '#5aaa92'],
    desc: '数据结构教材，笔记较多但对复习有帮助，价格可议。',
    seller: { name: '小赵', college: '计算机学院（软件学院）', avatar: '🧑' },
    time: '3 天前'
  },
  {
    id: 'b4', cat: 'book', tradeType: '定价', allowBargain: true,
    title: '考研英语真题 2025', price: '10', condition: '少量笔记',
    campus: '望江', cover: '#8a3b2c', emoji: '📙', images: ['#8a3b2c', '#9a4b3c'],
    isbn: '9787521401234', author: '张剑', publisher: '世界图书出版公司', edition: '2025版',
    college: '外国语学院', course: '考研英语',
    noteLevel: '少量', noteDesc: '部分题目有铅笔标注',
    defects: '无',
    innerPhotos: ['#a55b4c'],
    desc: '考研英语真题，2025 版，铅笔标注可擦。',
    seller: { name: '小孙', college: '公共管理学院', avatar: '👩' },
    time: '5 天前'
  }
];

const ALL_GOODS = MOCK_GOODS.concat(MOCK_BOOKS);

function getGoodsById(id) {
  return ALL_GOODS.find((g) => g.id === id);
}

module.exports = { MOCK_GOODS, MOCK_BOOKS, ALL_GOODS, getGoodsById };
