'use strict';
const fs=require('node:fs');const path=require('node:path');const root=path.resolve(__dirname,'..');
const functions=['admin','governance','config','safety-callback','governance-worker','login','goods','offer','chat','report','ocr'];
for(const name of functions) {
  const dir=path.join(root,'cloudfunctions',name);fs.mkdirSync(dir,{recursive:true});
  const target=path.join(dir,'lib');fs.mkdirSync(target,{recursive:true});fs.cpSync(path.join(root,'shared/server'),target,{recursive:true});
  const pkg={name:'campus-'+name,version:'1.0.0',private:true,main:'index.js',dependencies:{'wx-server-sdk':'^4.0.2','@cloudbase/node-sdk':'^4.2.1','fast-xml-parser':'^5.3.0'}};
  pkg.overrides = { 'wx-server-sdk': { '@cloudbase/node-sdk': '$@cloudbase/node-sdk' }, axios: '^1.21.1' };
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  const configFile=path.join(dir,'config.json');const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):{};
  const apis={login:['security.msgSecCheck','security.mediaCheckAsync'],goods:['security.msgSecCheck','security.mediaCheckAsync'],offer:['security.msgSecCheck'],chat:['security.msgSecCheck'],ocr:['ocr.printedText']}[name];
  if(apis){config.permissions={...(config.permissions||{}),openapi:apis};fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n');}
}
console.log('已打包11个云函数；lib 为生成文件，请先运行此脚本再上传部署。');
