'use strict';
const categories = [ ['book','图书教材','📚'], ['digital','数码电子','💻'], ['life','生活用品','🧺'], ['stationery','文具办公','✏️'], ['sports','运动户外','🏀'], ['clothes','服饰配件','👕'], ['other','其他','📦'] ];
const item = (code, name) => ({ code, name: name || code, active: true });
const rentalRestrictions = [
  ['accounts','账号'], ['identity','身份凭证'], ['access','钥匙与门禁'],
  ['medicine','药品'], ['hazards','危险品'], ['piracy','盗版物品']
].map(([code,name])=>item(code,name));
function defaultConfig(colleges = []) {
  return {
    categories: categories.map(([code, name, icon]) => ({ code, name, icon, active: true, parent: '', fields: [] })),
    campuses: ['江安校区','望江校区','华西校区'].map(x => item(x)),
    colleges: colleges.map(x => item(x)), majors: [], courses: [], tags: [],
    rentalRestrictions: structuredClone(rentalRestrictions),
    conditions: ['全新','几乎全新','轻微使用','明显使用'].map(x => item(x)),
    noteLevels: ['无笔记','少量','较多','大量'].map(x => item(x)),
    safetyTip: '请选择公共场所面交，先验货，勿提前转账。禁止盗版、违禁品、诈骗、站外支付诱导及骚扰。'
  };
}
const defaultRules = { offerPerHour: 20, messagePerMinute: 20, reportPerHour: 10, priceChangeSeconds: 300,
  lowPriceRatio: 0.1, lowPriceByCategory: {}, action: 'review', prohibitedTerms: ['出售毒品', '代开发票', '出售身份证'] };
const collections = ['users','goods','offers','conversations','messages','reports','adminUsers','adminSessions','systemLocks','rateLimits','configVersions','settings','moderationTasks','moderationCases','userBlocks','riskEvents','governanceActions','notifications','outboxTasks','auditLogs','auditArchives','offerKeys','mediaFiles','booklistFeedback','operationMetrics'];
module.exports = { defaultConfig, defaultRules, collections, rentalRestrictions };
