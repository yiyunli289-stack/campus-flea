import { reactive } from 'vue';
export interface Admin { _id: string; username: string; role: 'super' | 'reviewer' | 'readonly'; active: boolean }
export const session = reactive<{ admin: Admin | null; csrf: string; ready: boolean }>({ admin: null, csrf: '', ready: false });
export async function api<T = any>(path: string, data?: unknown): Promise<T> {
  const response = await fetch('/api/admin' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (response.status === 401) { session.admin = null; session.csrf = ''; }
  if (result.code !== 0) throw new Error(result.msg + (result.requestId ? `（${result.requestId.slice(0, 8)}）` : ''));
  return result.data as T;
}
export async function restore() {
  try { Object.assign(session, await api('/session')); } catch { session.admin = null; }
  session.ready = true;
}
export const canWrite = () => session.admin?.role === 'super' || session.admin?.role === 'reviewer';
export const isSuper = () => session.admin?.role === 'super';
export function date(value: unknown) { return value ? new Date(typeof value === 'string' && !/^\d+$/.test(value) ? value : Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'; }
export const labels: Record<string, string> = { pending: '待处理', review: '待复核', approved: '已通过', rejected: '未通过／未选中', resolved: '已处理', on: '在售', off: '已下架', locked: '已锁定', sold: '已售出', normal: '正常', removed: '违规下架', banned: '已封禁', restricted: '受限', failed: '失败', done: '已完成', running: '处理中', draft: '草稿', published: '已发布', super: '超级管理员', reviewer: '审核员', readonly: '运营只读', goods: '商品', users: '用户', offers: '报价留言', messages: '会话消息', report: '举报', appeal: '申诉' };
