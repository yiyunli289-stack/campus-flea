'use strict';
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function main(){
  const root=path.resolve(__dirname,'..');const password=crypto.randomBytes(20).toString('hex');const localDir='browser-'+Date.now();
  const dataDir=path.join(root,'.local',localDir);fs.mkdirSync(dataDir,{recursive:true});const now=Date.now();
  // Isolated local fixtures exercise real HTTP/UI actions, never production data.
  const goods={_id:'qa-goods',sellerId:'qa-seller',title:'浏览器审核商品',cat:'digital',price:100,status:'on',moderationStatus:'review',moderationTaskId:'qa-review',enforcement:'normal',contentVersion:'qa-v1',images:[],innerPhotos:[],createdAt:now};
  fs.writeFileSync(path.join(dataDir,'database.json'),JSON.stringify({users:{'qa-seller':{_id:'qa-seller',_openid:'qa-seller',nickName:'测试卖家',campus:'江安校区',contact:'private-fixture',profileComplete:true,accountStatus:'normal',moderationStatus:'approved',createdAt:now}},goods:{'qa-goods':goods},moderationTasks:{'qa-review':{_id:'qa-review',targetType:'goods',targetId:'qa-goods',ownerId:'qa-seller',version:'qa-v1',status:'review',textStatus:'review',media:[],createdAt:now}},moderationCases:{'qa-review':{_id:'qa-review',taskId:'qa-review',targetType:'goods',targetId:'qa-goods',ownerId:'qa-seller',version:'qa-v1',state:'pending',createdAt:now}}}));
  const env={...process.env,ADMIN_BOOTSTRAP_USERNAME:'qa-admin',ADMIN_BOOTSTRAP_PASSWORD:password,LOCAL_DATA_DIR:localDir,NODE_ENV:'development',PORT:'0'};
  const backend=spawn(process.execPath,['scripts/dev-server.js'],{cwd:root,env,stdio:'pipe',windowsHide:true});
  let logs='';backend.stderr.on('data',c=>logs+=c);
  const ready=new Promise((resolve,reject)=>{
    let stdout='';
    const timer=setTimeout(()=>reject(Error('本地后台启动超时')),10000);
    backend.once('exit',code=>{clearTimeout(timer);reject(Error('后台退出：'+code));});
    backend.once('error',error=>{clearTimeout(timer);reject(error);});
    backend.stdout.on('data',chunk=>{
      stdout+=chunk;
      const origin=stdout.match(/http:\/\/127\.0\.0\.1:\d+(?=；)/)?.[0];
      if (origin) {clearTimeout(timer);resolve(origin);}
    });
  });
  let browser;
  try{
    const origin=await ready;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.getByPlaceholder('请输入管理账号').fill('qa-admin');await page.getByPlaceholder('请输入密码').fill(password);await page.getByRole('button',{name:'登录管理后台'}).click();
    await page.getByRole('heading',{name:'治理工作台'}).waitFor();
    await page.screenshot({path:path.join(root,'.local',localDir,'dashboard.png'),fullPage:true});
    await page.getByRole('link',{name:'内容审核',exact:false}).click();await page.getByRole('button',{name:'详情',exact:true}).click();await page.getByText('浏览器审核商品',{exact:true}).waitFor();await page.getByRole('button',{name:'审核决定',exact:true}).click();
    let actionDialog=page.getByRole('dialog',{name:'确认管理操作'});await actionDialog.getByLabel('具体原因 / 核查结论（必填）').fill('浏览器核查通过');await actionDialog.getByText('我已核对对象、措施和影响范围，确认执行').click();await actionDialog.getByRole('button',{name:'确认执行'}).click();await actionDialog.waitFor({state:'hidden'});await page.locator('.el-table').getByText('已处理',{exact:true}).waitFor();
    await page.getByRole('link',{name:'商品治理',exact:false}).click();await page.getByRole('button',{name:'处置',exact:true}).click();actionDialog=page.getByRole('dialog',{name:'确认管理操作'});await actionDialog.getByLabel('具体原因 / 核查结论（必填）').fill('浏览器验证下架联动');await actionDialog.getByText('我已核对对象、措施和影响范围，确认执行').click();await actionDialog.getByRole('button',{name:'确认执行'}).click();await actionDialog.waitFor({state:'hidden'});await page.getByText('违规下架',{exact:true}).waitFor();
    await page.getByRole('link',{name:'管理员',exact:false}).click();await page.getByRole('button',{name:'新建管理员'}).click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('账号（3至40位字母、数字或 _.-）').fill('qa-reader');await dialog.getByLabel('初始密码（至少12位）').fill(password);
    await dialog.locator('.el-select').click();await page.getByRole('option',{name:'运营只读',exact:true}).click();await dialog.getByLabel('具体原因 / 核查结论（必填）').fill('浏览器验证只读角色');await dialog.getByText('我已核对对象、措施和影响范围，确认执行').click();await dialog.getByRole('button',{name:'确认执行'}).click();
    await page.getByText('qa-reader',{exact:true}).waitFor();
    await page.getByRole('link',{name:'类目与字典',exact:false}).click();await page.getByRole('tab',{name:'标签',exact:true}).click();await page.getByRole('button',{name:'新增条目'}).click();
    await dialog.getByLabel('稳定编码').fill('qa-tag');await dialog.getByLabel('显示名称').fill('浏览器测试标签');await dialog.getByRole('button',{name:'应用到本地草稿'}).click();
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.getByRole('button',{name:'发布草稿'}).click();
    await page.locator('.el-message-box textarea').fill('浏览器验证配置发布');await page.getByRole('button',{name:'确认发布',exact:true}).click();await page.getByText('配置已发布',{exact:true}).waitFor();
    await page.reload();await page.getByRole('tab',{name:'标签',exact:true}).click();await page.getByText('浏览器测试标签',{exact:true}).waitFor();
    await page.getByRole('link',{name:'学院书单',exact:false}).click();
    await page.getByRole('heading',{name:'学院书单'}).waitFor();
    await page.getByRole('button',{name:'批量导入'}).click();
    await page.getByRole('button',{name:'填入模板'}).click();
    await page.getByRole('button',{name:'检查错误和冲突'}).click();
    await page.getByText('第 1 条',{exact:false}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('link',{name:'运营统计',exact:false}).click();
    await page.getByRole('heading',{name:'交易漏斗'}).waitFor();
    await page.locator('.account').click();await page.getByText('退出登录',{exact:true}).click();await page.getByPlaceholder('请输入管理账号').fill('qa-reader');await page.getByPlaceholder('请输入密码').fill(password);await page.getByRole('button',{name:'登录管理后台'}).click();await page.getByRole('heading',{name:'治理工作台'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'类目与字典',exact:false}).count(),0);
    await page.goto(origin+'/records/users');await page.getByRole('heading',{name:'用户治理'}).waitFor();assert.equal(await page.getByRole('button',{name:'处置',exact:true}).count(),0);
    await page.setViewportSize({width:800,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    assert.deepEqual(errors,[]);console.log('独立后台浏览器验证通过：登录、审核、下架、权限、配置发布、书单导入校验、运营统计、窄屏布局。截图在 .local/'+localDir+'/dashboard.png');
  }catch(e){console.error(logs);throw e;}finally{if(browser)await browser.close();backend.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
