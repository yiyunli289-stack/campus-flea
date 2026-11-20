import { createRouter, createWebHistory } from 'vue-router';
import { restore, session } from './api';
import Login from './views/Login.vue';
import Dashboard from './views/Dashboard.vue';
import Records from './views/Records.vue';
import Config from './views/Config.vue';
import Booklists from './views/Booklists.vue';
import Statistics from './views/Statistics.vue';
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/login', component: Login, meta: { title: '登录' } },
  { path: '/', component: Dashboard, meta: { title: '治理工作台' } },
  { path: '/config/:kind', component: Config, meta: { title: '类目与规则配置', super: true } },
  { path: '/booklists', component: Booklists, meta: { title: '学院书单', super: true } },
  { path: '/statistics', component: Statistics, meta: { title: '运营统计' } },
  { path: '/records/:entity', component: Records, meta: { title: '治理记录' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
] });
router.beforeEach(async to => {
  if (!session.ready) await restore();
  if (!session.admin && to.path !== '/login') return '/login';
  if (session.admin && to.path === '/login') return '/';
  if (to.meta.super && session.admin?.role !== 'super') return '/';
  if (to.params.entity === 'admins' && session.admin?.role !== 'super') return '/';
  if (to.params.entity === 'audit' && session.admin?.role === 'readonly') return '/';
});
