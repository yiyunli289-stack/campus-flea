<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, date, labels } from '../api';

const fieldLabels = {
  school: '学校', campus: '校区', college: '学院', major: '专业', grade: '年级',
  term: '学年学期', course: '课程', courseType: '课程性质', materialType: '教材类别',
  title: '书名', isbn: 'ISBN', author: '作者', publisher: '出版社', edition: '版次',
  source: '来源', verifiedOn: '核验日期', expiresOn: '有效期至', note: '备注'
};
type Field = keyof typeof fieldLabels;
type Book = Record<Field, string> & { active: boolean; _id?: string; maintainer?: string };
interface Version { _id: string; publishedAt: number; count: number }
interface Feedback { _id: string; title: string; changes: Partial<Book>; note: string; state: string }
interface BooklistsState {
  rows: Book[]; revision: string; hasDraft: boolean; publishedVersion: string;
  versions: Version[]; feedback: Feedback[]; feedbackTotal: number
}
const createBook = (): Book => ({
  school: '四川大学', campus: '', college: '', major: '', grade: '', term: '', course: '', courseType: '',
  materialType: '必修教材', title: '', isbn: '', author: '', publisher: '', edition: '', note: '',
  source: '', verifiedOn: '', expiresOn: '', active: true
});
const state = ref<BooklistsState>();
const error = ref('');
const busy = ref(false);
const keyword = ref('');
const tab = ref('items');
const itemPage = ref(1);
const feedbackPage = ref(1);
const editorOpen = ref(false);
const item = ref<Book>(createBook());
const importOpen = ref(false);
const importText = ref('');
const preview = ref<{ valid: number; errors: { row: number; message: string }[] }>();
const filtered = computed(() => {
  const search = keyword.value.trim().toLowerCase();
  return (state.value?.rows || []).filter(row =>
    [row.title, row.isbn, row.college, row.major, row.course, row.term].some(value => value.toLowerCase().includes(search)));
});
const visibleRows = computed(() => filtered.value.slice((itemPage.value - 1) * 20, itemPage.value * 20));

async function load() {
  busy.value = true;
  error.value = '';
  try { state.value = await api<BooklistsState>('/booklists?page=' + feedbackPage.value); }
  catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}
onMounted(load);

async function action(op: string, payload: Record<string, unknown>, prompt: string) {
  if (!state.value || busy.value) return false;
  try {
    const { value } = await ElMessageBox.prompt(prompt, '确认书单操作', {
      inputType: 'textarea', inputValidator: (reason: string) => !!reason?.trim() || '请填写操作原因',
      confirmButtonText: '确认执行', cancelButtonText: '取消'
    });
    busy.value = true;
    await api('/action', { op, ...payload, revision: state.value.revision, reason: value, confirm: true });
    ElMessage.success('已保存');
    await load();
    return true;
  } catch (err) {
    if (err instanceof Error) ElMessage.error(err.message);
    return false;
  } finally { busy.value = false; }
}

function edit(row?: Book) {
  item.value = row ? { ...row } : createBook();
  editorOpen.value = true;
}
async function save() {
  if (await action('booklist.save', { id: item.value._id, row: item.value }, '保存到待发布的书单草稿，请填写原因。')) editorOpen.value = false;
}
async function readImport(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 110_000) { ElMessage.error('文件过大，请分次导入'); return; }
  importText.value = (await file.text()).replace(/^\uFEFF/, '');
  preview.value = undefined;
}
function importRows(): unknown[] {
  const rows: unknown = JSON.parse(importText.value);
  if (!Array.isArray(rows)) throw new Error('请提供 JSON 数组');
  return rows;
}
async function previewImport() {
  try { preview.value = await api('/action', { op: 'booklist.preview', rows: importRows() }); }
  catch (err) { ElMessage.error((err as Error).message); }
}
async function commitImport() {
  if (await action('booklist.import', { rows: importRows() }, '将通过校验的条目加入草稿，请填写原因。')) {
    importOpen.value = false;
    importText.value = '';
    preview.value = undefined;
  }
}
</script>

<template>
  <div class="page-intro">
    <div><h1>学院书单</h1><p>维护学期教材与参考书，核查用户纠错。</p></div>
    <div class="button-row">
      <el-button @click="importOpen = true">批量导入</el-button>
      <el-button type="primary" @click="edit()">新增条目</el-button>
      <el-button type="success" :disabled="!state?.hasDraft" @click="action('booklist.publish', {}, '发布全部书单草稿，请填写原因。')">发布草稿</el-button>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb" />
  <section class="panel" v-loading="busy">
    <p class="muted">{{ state?.hasDraft ? '当前有待发布草稿' : '正在查看已发布条目' }}</p>
    <el-tabs v-model="tab">
      <el-tab-pane label="书单条目" name="items">
        <el-input v-model="keyword" clearable placeholder="搜索书名、课程、学院或 ISBN" @input="itemPage = 1" />
        <el-table :data="visibleRows" empty-text="暂无书单条目" row-key="_id">
          <el-table-column prop="title" label="书名" min-width="160" />
          <el-table-column prop="college" label="学院" min-width="110" />
          <el-table-column prop="course" label="课程" min-width="110" />
          <el-table-column prop="term" label="学期" min-width="110" />
          <el-table-column prop="source" label="来源" min-width="110" />
          <el-table-column prop="verifiedOn" label="核验日期" min-width="110" />
          <el-table-column prop="maintainer" label="维护人" min-width="100" />
          <el-table-column label="状态" width="80"><template #default="{row}">{{ row.active ? '启用' : '停用' }}</template></el-table-column>
          <el-table-column label="操作" width="80"><template #default="{row}"><el-button link type="primary" @click="edit(row)">编辑</el-button></template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="itemPage" :page-size="20" :total="filtered.length" layout="prev, pager, next" />
      </el-tab-pane>
      <el-tab-pane label="历史版本" name="versions">
        <el-table :data="state?.versions || []" empty-text="暂无已发布版本">
          <el-table-column prop="_id" label="版本" min-width="210" />
          <el-table-column prop="count" label="条目数" />
          <el-table-column label="发布时间" min-width="160"><template #default="{row}">{{ date(row.publishedAt) }}</template></el-table-column>
          <el-table-column label="操作"><template #default="{row}">
            <el-button link type="primary" :disabled="state?.publishedVersion===row._id" @click="action('booklist.rollback', { id: row._id }, '重新发布历史版本并替换当前草稿，请填写原因。')">回滚</el-button>
          </template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="纠错反馈" name="feedback">
        <el-table :data="state?.feedback || []" empty-text="暂无反馈">
          <el-table-column prop="title" label="书名" min-width="120" />
          <el-table-column label="建议修改" min-width="160"><template #default="{row}">
            <div v-for="(value, key) in row.changes" :key="key">{{ fieldLabels[key as Field] || key }} {{ value }}</div>
          </template></el-table-column>
          <el-table-column prop="note" label="反馈说明" min-width="160" />
          <el-table-column label="状态" width="85"><template #default="{row}">{{ labels[row.state] || row.state }}</template></el-table-column>
          <el-table-column label="操作" width="170"><template #default="{row}">
            <template v-if="row.state==='pending'">
              <el-button link type="primary" @click="action('booklist.feedback', { id: row._id, decision: 'approved' }, '采纳反馈、发布修正并通知反馈人，请填写原因。')">采纳并发布</el-button>
              <el-button link type="danger" @click="action('booklist.feedback', { id: row._id, decision: 'rejected' }, '关闭反馈并通知反馈人，请填写原因。')">驳回</el-button>
            </template>
          </template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="feedbackPage" :page-size="20" :total="state?.feedbackTotal || 0" layout="prev, pager, next" @current-change="load" />
      </el-tab-pane>
    </el-tabs>
  </section>
  <el-dialog v-model="editorOpen" :title="item._id ? '编辑书单条目' : '新增书单条目'" width="min(820px, 96vw)">
    <el-form label-position="top" class="rule-grid">
      <el-form-item v-for="(label, key) in fieldLabels" :key="key" :label="label">
        <el-select v-if="key==='materialType'" v-model="item[key]"><el-option v-for="name in ['必修教材','推荐教材','参考书']" :key="name" :label="name" :value="name" /></el-select>
        <el-date-picker v-else-if="key==='verifiedOn'||key==='expiresOn'" v-model="item[key]" value-format="YYYY-MM-DD" :value-on-clear="''" />
        <el-input v-else v-model="item[key]" />
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="item.active" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="editorOpen = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存到草稿</el-button></template>
  </el-dialog>
  <el-dialog v-model="importOpen" title="导入书单" width="min(760px, 96vw)">
    <p class="muted">上传 UTF-8 JSON 文件或粘贴 JSON 数组，每次最多 100 条。请用模板中的字段名。</p>
    <input type="file" accept=".json,application/json" @change="readImport" />
    <el-button link type="primary" @click="importText = JSON.stringify([createBook()], null, 2); preview = undefined">填入模板</el-button>
    <el-input v-model="importText" type="textarea" :rows="12" @input="preview = undefined" />
    <div v-if="preview" class="mt">
      <p>通过校验 {{ preview.valid }} 条，需修正 {{ preview.errors.length }} 条。</p>
      <ul v-if="preview.errors.length"><li v-for="err in preview.errors" :key="err.row">第 {{ err.row }} 条 {{ err.message }}</li></ul>
    </div>
    <template #footer><el-button @click="previewImport">检查错误和冲突</el-button><el-button type="primary" :disabled="!preview?.valid || !!preview.errors.length" :loading="busy" @click="commitImport">导入草稿</el-button></template>
  </el-dialog>
</template>
