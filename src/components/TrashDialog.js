// ============================================================================
// TrashDialog —— 回收站弹窗
//
// 界面位置：素材库底部「回收站」按钮打开的模态框。
//
// 设计背景：工作区里的删除是可逆的 —— 工程文件被移动到 trash/，素材只是在 assets/index.json
// 里打上删除标记（文件仍留在磁盘上）。本弹窗是唯一真正能把字节从磁盘移除的地方，
// 因此提供「恢复」与「彻底删除」两种操作，以及「清空回收站」。
//
// 数据来源：全部通过本地服务端 HTTP 接口（/api/trash*）读写，组件本身不碰文件系统。
// ============================================================================
import { defineComponent, onMounted, ref } from 'vue'
import { t } from '../i18n/index.js'

/**
 * 把删除时间戳格式化成「刚刚 / N 分钟前 / N 小时前 / N 天前」的相对时间。
 * @param {number} ts 删除时间（毫秒）；缺省时按“现在”处理
 * @returns {string} 本地化后的相对时间文本
 */
const ago = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 60000))
  if (mins < 1) return t('trash.justNow')
  if (mins < 60) return t('trash.minutesAgo', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('trash.hoursAgo', { n: hours })
  return t('trash.daysAgo', { n: Math.round(hours / 24) })
}
/**
 * 把字节数格式化成 KB / MB；不足 1KB 也显示 1KB，0 显示 0 KB。
 * @param {number} n 字节数
 * @returns {string}
 */
const kb = (n) => {
  const v = Number(n) || 0
  if (!v) return '0 KB'
  return v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(v / 1024)) + ' KB'
}

export default defineComponent({
  name: 'TrashDialog',
  emits: ['close', 'changed'],
  setup(props, { emit }) {
    const loading = ref(true)
    /** 正在进行的操作标识（`kind:id` 或 'all'），用于禁用按钮避免重复提交 */
    const busy = ref('')
    const error = ref('')
    /** 回收站中的工程列表 */
    const projects = ref([])
    /** 回收站中的素材列表 */
    const assets = ref([])
    /** 工程占用的总字节数（仅用于展示） */
    const projectBytes = ref(0)

    /** 重新拉取回收站清单；失败时把错误写入 error */
    async function load() {
      loading.value = true
      error.value = ''
      try {
        const r = await fetch('/api/trash')
        const j = await r.json()
        if (!j.ok) throw new Error(j.error?.message || 'failed to load the bin')
        projects.value = j.projects || []
        assets.value = j.assets || []
        projectBytes.value = j.projectBytes || 0
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        loading.value = false
      }
    }

    /**
     * 通用 POST 封装：发送 JSON 并检查 { ok } 返回。
     * @param {string} path 接口路径
     * @param {object} body 请求体
     * @returns {Promise<object>} 服务端返回的 JSON
     * @throws {Error} 请求失败或 ok 为 false 时抛出
     */
    async function post(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error?.message || 'failed')
      return j
    }

    /**
     * 从回收站恢复一项（工程或素材），完成后刷新列表并通知外部刷新界面。
     * @param {'project'|'asset'} kind 类型
     * @param {string} id 条目 id
     */
    async function restore(kind, id) {
      busy.value = kind + ':' + id
      try {
        await post('/api/trash/restore', { kind, id })
        await load()
        emit('changed')
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        busy.value = ''
      }
    }

    /**
     * 彻底删除一项（不可恢复，会真正移除磁盘上的文件）。
     * @param {'project'|'asset'} kind 类型
     * @param {string} id 条目 id
     */
    async function purge(kind, id) {
      busy.value = kind + ':' + id
      try {
        await post('/api/trash/purge', { kind, id })
        await load()
        emit('changed')
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        busy.value = ''
      }
    }

    /** 清空整个回收站（危险操作，模板中仅在列表非空时可用） */
    async function emptyAll() {
      busy.value = 'all'
      try {
        await post('/api/trash/empty', {})
        await load()
        emit('changed')
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        busy.value = ''
      }
    }

    onMounted(load)

    return { loading, busy, error, projects, assets, projectBytes, restore, purge, emptyAll, ago, kb, load, close: () => emit('close'), count: () => projects.value.length + assets.value.length }
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal trash-modal">
        <!-- 弹窗头：标题、条目总数、刷新与关闭 -->
        <div class="modal-head">
          <div class="modal-title">{{ $t('trash.title') }}</div>
          <span class="hint small">{{ $t('trash.count', { n: count() }) }}</span>
          <div class="spacer"></div>
          <button class="btn tiny" :disabled="loading" @click="load">⟳</button>
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="hint small trash-note">{{ $t('trash.note') }}</div>
          <div class="hint small trash-note">{{ $t('trash.bindingNote') }}</div>
          <div v-if="error" class="json-error">{{ error }}</div>
          <div v-if="loading" class="hint">{{ $t('common.loading') }}</div>
          <template v-else>
            <!-- 第一段：被删除的工程（材质） -->
            <div class="trash-section">
              <div class="trash-head">
                {{ $t('trash.materials') }}
                <span class="hint small">{{ projects.length }} · {{ kb(projectBytes) }}</span>
              </div>
              <div v-if="!projects.length" class="hint small">{{ $t('trash.emptyOne') }}</div>
              <div v-for="p in projects" :key="p.id" class="trash-row">
                <span class="trash-name" :title="p.name">{{ p.name }}</span>
                <span class="trash-meta">{{ $t('trash.projectMeta', { res: p.resolution, nodes: p.nodes }) }}</span>
                <span v-if="p.boundAssets" class="trash-meta trash-bound">{{ $t('trash.boundAssets', { n: p.boundAssets }) }}</span>
                <span class="trash-meta">{{ ago(p.deletedAt) }}</span>
                <div class="trash-actions">
                  <button class="btn tiny" :disabled="!!busy" @click="restore('project', p.id)">{{ $t('trash.restore') }}</button>
                  <button class="btn tiny danger" :disabled="!!busy" @click="purge('project', p.id)">{{ $t('trash.purge') }}</button>
                </div>
              </div>
            </div>

            <!-- 第二段：被删除的素材（图片缩略图 / sbsar 徽标） -->
            <div class="trash-section">
              <div class="trash-head">
                {{ $t('trash.assets') }}
                <span class="hint small">{{ assets.length }}</span>
              </div>
              <div v-if="!assets.length" class="hint small">{{ $t('trash.emptyOne') }}</div>
              <div v-for="a in assets" :key="a.id" class="trash-row">
                <span class="trash-thumb">
                  <img v-if="a.kind === 'bitmap'" :src="a.url" :alt="a.name" loading="lazy" />
                  <span v-else class="trash-badge">sbsar</span>
                </span>
                <span class="trash-name" :title="a.name">{{ a.name }}</span>
                <span class="trash-meta">{{ kb(a.bytes) }}<template v-if="a.childCount"> · {{ $t('trash.children', { n: a.childCount }) }}</template></span>
                <span class="trash-meta">{{ ago(a.deletedAt) }}</span>
                <div class="trash-actions">
                  <button class="btn tiny" :disabled="!!busy" @click="restore('asset', a.id)">{{ $t('trash.restore') }}</button>
                  <button class="btn tiny danger" :disabled="!!busy" @click="purge('asset', a.id)">{{ $t('trash.purge') }}</button>
                </div>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-foot">
          <span class="hint">{{ $t('trash.foot') }}</span>
          <div style="display: flex; gap: 8px">
            <button class="btn tiny danger" :disabled="loading || busy === 'all' || !count()" @click="emptyAll">{{ $t('trash.emptyAll') }}</button>
            <button class="btn" @click="close">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>
    </div>
  `
})
