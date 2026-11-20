<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, session, labels } from './api';
const route = useRoute(); const router = useRouter();
const items = computed(() => [
  ['/', '工作台', '01'], ['/records/moderation', '内容审核', '02'], ['/records/reports', '举报与申诉', '03'],
  ['/records/goods', '商品治理', '04'], ['/records/users', '用户治理', '05'], ['/records/risks', '交易风控', '06'],
  ...(session.admin?.role === 'super' ? [['/config/public', '类目与字典', '07'], ['/config/rules', '风控规则', '08'], ['/records/admins', '管理员', '09']] : []),
  ...(session.admin?.role !== 'readonly' ? [['/records/audit', '审计日志', '10']] : []), ['/records/tasks', '后台任务', '11'],
  ...(session.admin?.role === 'super' ? [['/booklists', '学院书单', '12']] : []),
  ['/statistics', '运营统计', '13']
]);
const title = computed(() => items.value.find(i => i[0] === route.path)?.[1] || '校园二手');
const passwordOpen = ref(false); const currentPassword = ref(''); const password = ref(''); const busy = ref(false);
watch(() => session.admin, a => { if (!a && route.path !== '/login') router.replace('/login'); });
async function logout() { await api('/logout', {}); session.admin = null; session.csrf = ''; router.replace('/login'); }
async function changePassword() {
  if (password.value.length < 12) return ElMessage.warning('新密码至少12位');
  try { busy.value = true; await api('/action', { op: 'password.change', currentPassword: currentPassword.value, password: password.value }); passwordOpen.value = false; session.admin = null; ElMessage.success('密码已修改，请重新登录'); }
  catch (e) { ElMessage.error((e as Error).message); } finally { busy.value = false; }
}
</script>
<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="workspace">
    <aside class="sidebar">
      <div class="brand"><div class="brand-icon">校</div><div><strong>校园二手</strong><small>安全治理中心</small></div></div>
      <div class="nav-caption">管理控制台</div>
      <nav><router-link v-for="item in items" :key="item[0]" :to="item[0]" :class="{ selected: route.path === item[0] }"><span>{{ item[2] }}</span>{{ item[1] }}</router-link></nav>
      <div class="sidebar-note">审核有依据<br>处置可追溯</div>
    </aside>
    <div class="main-column">
      <header class="topbar"><div><span class="muted">管理控制台</span><span class="crumb">/</span><strong>{{ title }}</strong></div>
        <el-dropdown trigger="click"><div class="account"><span class="avatar">{{ session.admin?.username.slice(0, 1).toUpperCase() }}</span><div>{{ session.admin?.username }}<small>{{ labels[session.admin?.role || ''] }}</small></div><span>⌄</span></div><template #dropdown><el-dropdown-menu><el-dropdown-item @click="passwordOpen = true">修改密码</el-dropdown-item><el-dropdown-item divided @click="logout">退出登录</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
      </header>
      <main><router-view /></main><footer>校园二手 · 安全治理与运营管理</footer>
    </div>
    <el-dialog v-model="passwordOpen" title="修改密码" width="440px" destroy-on-close><el-form label-position="top"><el-form-item label="原密码"><el-input v-model="currentPassword" type="password" show-password autocomplete="current-password" /></el-form-item><el-form-item label="新密码（至少12位）"><el-input v-model="password" type="password" show-password autocomplete="new-password" /></el-form-item></el-form><template #footer><el-button @click="passwordOpen = false">取消</el-button><el-button type="primary" :loading="busy" @click="changePassword">保存并重新登录</el-button></template></el-dialog>
  </div>
</template>
