'use strict';
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const root=path.resolve(__dirname,'..');
let count=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','lib','.git','dist','.local','.npm-cache','admin-web'].includes(e.name))continue;const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.js')){cp.execFileSync(process.execPath,['--check',f],{stdio:'pipe'});count++;}else if(f.endsWith('.json'))JSON.parse(fs.readFileSync(f,'utf8'));}}
walk(root);console.log(`语法和JSON检查通过：${count} 个JavaScript文件`);
