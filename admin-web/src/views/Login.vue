<script setup lang="ts">
import { ref } from 'vue'; import { useRouter } from 'vue-router'; import { api, session } from '../api';
const username=ref('');const password=ref('');const busy=ref(false);const error=ref('');const router=useRouter();
async function submit() {
  if(!username.value||!password.value) {error.value='请输入账号和密码';return;}
  busy.value=true;error.value='';
  try {Object.assign(session,await api('/login',{username:username.value,password:password.value}));password.value='';router.replace('/');}
  catch(e) {error.value=(e as Error).message;}finally {busy.value=false;}
}
</script>
<template><div class="login-page"><section class="login-story"><span class="eyebrow">CAMPUS FLEA · ADMIN</span><h1>让校园交易<br>更安心。</h1><p>内容审核、风险处置与运营配置<br>在这里有序协同。</p><div class="login-mark">校 园 二 手</div></section><section class="login-side"><div class="login-card"><div class="brand-icon">校</div><h2>管理员登录</h2><p class="muted">使用独立管理账号进入安全治理后台</p><el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="mb"/><el-form label-position="top" @submit.prevent="submit"><el-form-item label="管理账号"><el-input v-model="username" size="large" autocomplete="username" placeholder="请输入管理账号"/></el-form-item><el-form-item label="登录密码"><el-input v-model="password" size="large" type="password" show-password autocomplete="current-password" placeholder="请输入密码" @keyup.enter="submit"/></el-form-item><el-button class="login-submit" size="large" type="primary" :loading="busy" @click="submit">登录管理后台</el-button></el-form><div class="login-tip">仅授权人员可访问，查询和操作将记录审计日志。</div></div></section></div></template>
