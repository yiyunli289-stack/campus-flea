<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

interface Funnel { mode: string; view: number; request: number; response: number; accept: number; lockCancel: number; sold: number }
interface College { college: string; materials: number; matched: number; listed: number; gap: number; searches: number; empty: number }
interface Statistics {
  since: string; end: string; funnel: Funnel[]; colleges: College[];
  searches: number; emptySearches: number
}
const data = ref<Statistics>();
const days = ref(30);
const error = ref('');
const loading = ref(false);
const percent = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : '—';
async function load() {
  error.value = '';
  loading.value = true;
  try { data.value = await api<Statistics>('/statistics?days=' + days.value); }
  catch (err) { error.value = (err as Error).message; }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="page-intro"><div><h1>运营统计</h1><p v-if="data">{{ data.since }} 至 {{ data.end }}</p></div>
    <el-select v-model="days" style="width:140px" @change="load"><el-option v-for="n in [7,30,90]" :key="n" :label="'最近 '+n+' 天'" :value="n" /></el-select>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb" />
  <div v-loading="loading" v-if="data">
    <section class="panel">
      <h2>交易漏斗</h2>
      <p class="muted">按新版本上线后记录的事件计数。响应包含接受与拒绝，历史浏览无法回填。</p>
      <el-table :data="data.funnel">
        <el-table-column prop="mode" label="交易方式" />
        <el-table-column prop="view" label="详情浏览" />
        <el-table-column prop="request" label="购买申请" />
        <el-table-column prop="response" label="卖家响应" />
        <el-table-column prop="accept" label="接受" />
        <el-table-column prop="lockCancel" label="取消锁定" />
        <el-table-column prop="sold" label="标记售出" />
      </el-table>
    </section>
    <section class="panel mt">
      <h2>书单运营</h2><p class="muted">全站图书搜索无结果率 {{ percent(data.emptySearches, data.searches) }}，在售覆盖按发布书单与当前商品匹配。</p>
      <el-table :data="data.colleges" max-height="560">
        <el-table-column prop="college" label="学院" min-width="170" />
        <el-table-column prop="materials" label="有效教材数" min-width="100" />
        <el-table-column prop="listed" label="在售图书数" min-width="100" />
        <el-table-column label="在售覆盖率" min-width="105"><template #default="{row}">{{ percent(row.matched,row.materials) }}</template></el-table-column>
        <el-table-column prop="gap" label="教材缺口" min-width="85" />
        <el-table-column label="搜索无结果率" min-width="110"><template #default="{row}">{{ percent(row.empty,row.searches) }}</template></el-table-column>
      </el-table>
    </section>
  </div>
</template>
