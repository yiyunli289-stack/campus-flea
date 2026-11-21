'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const shared = path.join(root,'shared','notifications');
const modules = {
  chat:['core.js','trade.js'],
  offer:['core.js','trade.js'],
  goods:['core.js','trade.js'],
  notification:['core.js','delivery.js'],
  'notification-worker':['core.js','delivery.js','trade.js']
};

for (const [name,files] of Object.entries(modules)) {
  const dest = path.join(root,'cloudfunctions',name,'lib');
  fs.mkdirSync(dest,{recursive:true});
  for (const file of files) fs.copyFileSync(path.join(shared,file),path.join(dest,file));
}
console.log('已打包通知共享模块，共 5 个云函数目录。');
