// Recycle bin dialog: restores or permanently deletes materials (projects) and library assets.
//
// Deletion in the studio is reversible: a project file is moved to trash/, an asset is flagged in
// assets/index.json (files stay on disk). This dialog is the only place that can unlink bytes.
import { defineComponent, onMounted, ref } from 'vue'
import { t } from '../i18n/index.js'

const ago = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 60000))
  if (mins < 1) return t('trash.justNow')
  if (mins < 60) return t('trash.minutesAgo', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('trash.hoursAgo', { n: hours })
  return t('trash.daysAgo', { n: Math.round(hours / 24) })
}
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
    const busy = ref('')
    const error = ref('')
    const projects = ref([])
    const assets = ref([])
    const projectBytes = ref(0)

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

    async function post(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error?.message || 'failed')
      return j
    }

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
