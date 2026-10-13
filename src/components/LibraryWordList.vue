<template>
  <div class="word-list">
    <div class="word-list-tools">
      <label class="word-search">
        <span class="visually-hidden">Search words</span>
        <input v-model="query" type="search" placeholder="Search 250 words" autocomplete="off" spellcheck="false" @keydown.down.prevent="focusRow(0)" />
      </label>
      <div class="word-filters" role="group" aria-label="Filter words">
        <button
          v-for="option in FILTERS"
          :key="option.id"
          type="button"
          class="word-filter"
          :class="{ active: filter === option.id }"
          :aria-pressed="filter === option.id"
          @click="filter = option.id"
        >
          {{ option.label }} <small>{{ counts[option.id] }}</small>
        </button>
      </div>
    </div>

    <p class="word-list-count" aria-live="polite">{{ visible.length }} of {{ words.length }} words</p>

    <ul ref="listElement" class="word-rows" aria-label="Library words">
      <li v-for="(word, i) in visible" :key="word.gloss">
        <button
          type="button"
          class="word-row"
          :class="{ selected: word.gloss === selected, current: word.gloss === current }"
          :aria-current="word.gloss === selected ? 'true' : undefined"
          :data-gloss="word.gloss"
          @click="emit('select', word.gloss)"
          @keydown.down.prevent="focusRow(i + 1)"
          @keydown.up.prevent="i === 0 ? focusSearch() : focusRow(i - 1)"
        >
          <span class="word-name">{{ glossLabel(word.gloss) }}</span>
          <span class="word-badges">
            <i v-if="word.hands === 'both'" class="badge two" title="Two-handed sign">2H</i>
            <i v-if="attention(word).length" class="badge warn" :title="attention(word).join('; ')">!</i>
            <i v-if="reviews[word.gloss]" class="badge" :class="reviews[word.gloss].decision" :title="`Reviewed: ${reviews[word.gloss].decision}`">{{ reviews[word.gloss].decision === 'approved' ? '✓' : '✕' }}</i>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="!visible.length" class="word-empty">No word matches.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SignLibraryWord } from '../motion/library/format'
import { glossLabel } from '../motion/library/lookup'
import type { ReviewRecord } from '../motion/library/review'

export type WordFilter = 'all' | 'two' | 'attention' | 'unreviewed' | 'reviewed'

const props = defineProps<{
  words: readonly SignLibraryWord[]
  selected: string
  /** Word currently playing in "play all" or phrase mode. */
  current?: string
  reviews: Readonly<Record<string, ReviewRecord>>
  attention: (word: SignLibraryWord) => string[]
}>()

const emit = defineEmits<{ select: [gloss: string] }>()

const FILTERS: { id: WordFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'two', label: 'Two-handed' },
  { id: 'attention', label: 'Check' },
  { id: 'unreviewed', label: 'Unreviewed' },
  { id: 'reviewed', label: 'Reviewed' }
]

const query = ref('')
const filter = ref<WordFilter>('all')
const listElement = ref<HTMLUListElement | null>(null)

const matches = (word: SignLibraryWord, which: WordFilter) => {
  if (which === 'two') return word.hands === 'both'
  if (which === 'attention') return props.attention(word).length > 0
  if (which === 'unreviewed') return !props.reviews[word.gloss]
  if (which === 'reviewed') return Boolean(props.reviews[word.gloss])
  return true
}

const counts = computed(() => Object.fromEntries(FILTERS.map((f) => [f.id, props.words.filter((w) => matches(w, f.id)).length])) as Record<WordFilter, number>)

const visible = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '')
  return props.words.filter((word) => matches(word, filter.value) && (!q || word.gloss.toLowerCase().includes(q) || glossLabel(word.gloss).toLowerCase().replace(/[\s/]+/g, '').includes(q)))
})

function rows() {
  return Array.from(listElement.value?.querySelectorAll<HTMLButtonElement>('button.word-row') ?? [])
}

function focusRow(i: number) {
  const list = rows()
  if (!list.length) return
  const button = list[Math.max(0, Math.min(i, list.length - 1))]
  button.focus()
  button.click()
}

function focusSearch() {
  listElement.value?.parentElement?.querySelector<HTMLInputElement>('.word-search input')?.focus()
}

/** Visible glosses in order (for "play all"). */
function visibleGlosses() {
  return visible.value.map((w) => w.gloss)
}

defineExpose({ visibleGlosses })
</script>

<style scoped>
.word-list {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-height: 0;
}

.word-list-tools {
  display: grid;
  gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
}

.word-search input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: #0c1417;
  font-size: 12px;
}

.word-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.word-filter {
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  font-weight: 650;
  cursor: pointer;
}

.word-filter small {
  margin-left: 3px;
  color: var(--muted-2);
  font-size: 9px;
}

.word-filter.active {
  color: #062029;
  background: var(--cyan);
  border-color: var(--cyan);
}

.word-filter.active small {
  color: #0b3a45;
}

.word-list-count {
  margin: 0;
  padding: 8px 16px;
  color: var(--muted-2);
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.word-rows {
  margin: 0;
  padding: 0 8px 10px;
  overflow-y: auto;
  list-style: none;
  max-height: 520px;
}

.word-row {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--ink);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.word-row:hover {
  background: rgba(255, 255, 255, 0.035);
}

.word-row.selected {
  border-color: rgba(127, 233, 255, 0.35);
  background: rgba(127, 233, 255, 0.08);
}

.word-row.current .word-name::before {
  content: "▶ ";
  color: var(--green);
}

.word-name {
  font-size: 13px;
  font-weight: 560;
}

.word-badges {
  display: inline-flex;
  gap: 4px;
}

.badge {
  min-width: 22px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  padding: 0 5px;
  border-radius: 5px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.06);
  font-size: 9px;
  font-style: normal;
  font-weight: 750;
}

.badge.two {
  color: var(--cyan);
}

.badge.warn {
  color: #1d1200;
  background: var(--orange);
}

.badge.approved {
  color: #04261a;
  background: var(--green);
}

.badge.rejected {
  color: #2b0505;
  background: var(--danger);
}

.word-empty {
  margin: 0;
  padding: 18px 16px;
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 840px) {
  .word-rows {
    max-height: 340px;
  }
}
</style>
