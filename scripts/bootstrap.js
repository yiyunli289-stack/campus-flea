'use strict';
const {context}=require('./cloud-context');const {collections}=require('../shared/server/defaults');
async function run(){
  if(!process.argv.includes('--apply')){console.log('预览：请在云开发控制台预先创建集合：'+collections.join(', ')+'。写入配置及首个超管需使用 --apply，并设置 ADMIN_BOOTSTRAP_USERNAME/PASSWORD。');return;}
  const {db,service:s}=context();
  const missing=[];
  for(const name of collections){try{await db.collection(name).count();}catch(e){if(/COLLECTION_NOT_EXIST|collection.*not.*exist|集合不存在/i.test(e.code+' '+e.message))missing.push(name);else throw e;}}
  if(missing.length)throw new Error('请先在云开发控制台创建集合：'+missing.join(', ')+'；未写入任何初始化数据');
  const bootstrap = await s.store.get('systemLocks','bootstrap');
  if (!bootstrap) {
    const username = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!password || password.length < 12 || password.length > 128) throw new Error('请提供 12 至 128 位初始密码');
    await s.auth.createAccount(null,{username,password,role:'super'},true);
  }
  await s.initialize(require('../miniprogram/utils/colleges').ALL_COLLEGES);
  console.log('环境初始化完成；未输出密码。已初始化的管理员不会被覆盖。');
}
run().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
