'use strict';
const sdk = require('@cloudbase/node-sdk');
const { CloudStore } = require('../shared/server/store');
const { Service } = require('../shared/server/service');

function context(env = process.env) {
  if (!env.TCB_ENV) throw new Error('请设置目标云环境 TCB_ENV');
  const accessKey = env.CLOUDBASE_API_KEY || env.CLOUDBASE_APIKEY;
  const secretId = env.TENCENTCLOUD_SECRETID;
  const secretKey = env.TENCENTCLOUD_SECRETKEY;
  if (!accessKey && (!secretId || !secretKey)) {
    throw new Error('请提供服务端 CLOUDBASE_API_KEY 或腾讯云访问凭证');
  }
  const app = sdk.init({
    env: env.TCB_ENV,
    region: env.TCB_REGION || 'ap-shanghai',
    throwOnCode: true,
    ...(accessKey ? { accessKey } : { secretId, secretKey, sessionToken: env.TENCENTCLOUD_SESSIONTOKEN })
  });
  const db = app.database();
  const provider = {
    async urls(files) {
      const cloudFiles = Array.from(new Set(files.filter(file => file.startsWith('cloud://'))));
      if (!cloudFiles.length) return files;
      try {
        const result = await app.getTempFileURL({ fileList: cloudFiles });
        const urls = new Map(result.fileList.map(file => [file.fileID, file.tempFileURL]));
        return files.map(file => file.startsWith('cloud://') ? urls.get(file) || '' : file);
      } catch {
        // Keep the case accessible even if its legacy evidence file was removed or expired.
        return files.map(file => file.startsWith('cloud://') ? '' : file);
      }
    }
  };
  return { app, db, service: new Service(new CloudStore(db), provider, env) };
}

module.exports = { context };
