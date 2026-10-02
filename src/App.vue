<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#top" aria-label="Deafference Motion Studio home">
        <span class="brand-mark" aria-hidden="true"><i></i></span>
        <span class="brand-copy">
          <strong>deafference</strong>
          <small>Motion Studio</small>
        </span>
      </a>

      <nav class="view-tabs" role="tablist" aria-label="Views">
        <button
          v-for="tab in tabs"
          :id="`tab-${tab.view}`"
          :key="tab.view"
          :ref="(el) => { if (el) tabButtons[tab.view] = el as HTMLButtonElement }"
          class="view-tab"
          :class="{ active: view === tab.view }"
          type="button"
          role="tab"
          :aria-selected="view === tab.view"
          aria-controls="view-panel"
          :tabindex="view === tab.view ? 0 : -1"
          @click="setView(tab.view)"
          @keydown="handleTabKey"
        >
          <strong>{{ tab.label }}</strong>
          <small>{{ tab.hint }}</small>
        </button>
      </nav>

      <div class="system-status" :class="{ ready: status.ready, live: status.live, error: status.error }">
        <span class="status-dot"></span>
        <span>{{ status.text }}</span>
      </div>
    </header>

    <div id="view-panel" role="tabpanel" :aria-labelledby="`tab-${view}`">
      <!-- v-if, not v-show: each view owns WebGL contexts and media that must be released when hidden. -->
      <StudioView v-if="view === 'studio'" @status="status = $event" />
      <SignClipsView v-else @status="status = $event" />
    </div>

    <footer class="footer">
      <span>Deafference Motion Studio · Technical prototype</span>
      <span>MediaPipe Holistic → anatomical hand model + constrained IK → Three.js</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import StudioView from './views/StudioView.vue'
import type { AppView, ViewStatus } from './types/ui'

// Loaded on first use: the default studio view does not pay for it.
const SignClipsView = defineAsyncComponent(() => import('./views/SignClipsView.vue'))

const tabs: { view: AppView; label: string; hint: string; hash: string }[] = [
  { view: 'studio', label: 'Motion studio', hint: 'Sample · upload · camera', hash: '#studio' },
  { view: 'clips', label: 'Sign clips', hint: '2 recorded sections', hash: '#sign-clips' }
]

/** Only these hashes select a view; other anchors (#top, #section-1, ...) just scroll. */
function viewFromHash(hash: string): AppView | null {
  return tabs.find((tab) => tab.hash === hash)?.view ?? null
}

const view = ref<AppView>(viewFromHash(window.location.hash) ?? 'studio')
const status = ref<ViewStatus>({ text: 'Preparing motion engine' })
const tabButtons: Partial<Record<AppView, HTMLButtonElement>> = {}

function setView(next: AppView) {
  if (next !== view.value) {
    view.value = next
    status.value = { text: 'Preparing motion engine' }
    window.scrollTo({ top: 0 })
  }
  const hash = tabs.find((tab) => tab.view === next)!.hash
  // The studio is the default view: keep its URL clean.
  const url = `${window.location.pathname}${window.location.search}${next === 'studio' ? '' : hash}`
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== url) window.history.replaceState(null, '', url)
}

/** Arrow keys move between tabs (WAI-ARIA tabs pattern). */
async function handleTabKey(event: KeyboardEvent) {
  const order = tabs.map((tab) => tab.view)
  const index = order.indexOf(view.value)
  let next: AppView | null = null
  if (event.key === 'ArrowRight') next = order[(index + 1) % order.length]
  else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length]
  else if (event.key === 'Home') next = order[0]
  else if (event.key === 'End') next = order[order.length - 1]
  if (!next) return
  event.preventDefault()
  setView(next)
  await nextTick()
  tabButtons[next]?.focus()
}

function handleHashChange() {
  const next = viewFromHash(window.location.hash)
  if (next && next !== view.value) setView(next)
}

onMounted(() => window.addEventListener('hashchange', handleHashChange))
onBeforeUnmount(() => window.removeEventListener('hashchange', handleHashChange))
</script>
