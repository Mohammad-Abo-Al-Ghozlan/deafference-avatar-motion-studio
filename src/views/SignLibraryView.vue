<template>
  <main id="top" class="library-view">
    <section class="intro" aria-labelledby="library-title">
      <div>
        <p class="eyebrow"><span>Library</span> 250 isolated signs · asl-v2 pipeline</p>
        <h1 id="library-title">Sign library.<br /><em>Every word on the avatar.</em></h1>
      </div>
      <p class="intro-copy">
        Each word is one dataset take retargeted onto this avatar by the asl-v2 pipeline,
        played here with the studio's motion player and checked with the studio's full-clip QA.
        Words are looked up one by one: this is not translation, and no clip is
        Deaf-approved yet.
      </p>
    </section>

    <dl v-if="index" class="library-stats" aria-label="Library summary">
      <div><dt>Words</dt><dd>{{ index.counts.words }}</dd></div>
      <div><dt>Two-handed</dt><dd>{{ index.counts.twoHanded }}<small> 2nd hand synthesized</small></dd></div>
      <div><dt>Studio QA · raw</dt><dd>{{ index.counts.qaPass.raw }}<small> / {{ index.counts.words }} pass</small></dd></div>
      <div><dt>Studio QA · conformed</dt><dd>{{ index.counts.qaPass.conformed }}<small> / {{ index.counts.words }} pass</small></dd></div>
      <div><dt>Deaf-approved</dt><dd>{{ index.counts.approved }}<small> · {{ reviewedCount }} reviewed here</small></dd></div>
    </dl>

    <div class="motion-workspace library-workspace">
      <article class="panel avatar-panel">
        <header class="panel-header">
          <div>
            <p>Avatar output</p>
            <h2>{{ mode === 'phrase' ? 'Phrase test' : 'Word test' }}</h2>
          </div>
          <div class="variant-switch" role="group" aria-label="Motion version">
            <button type="button" :class="{ active: variant === 'conformed' }" :aria-pressed="variant === 'conformed'" title="Projected onto the studio's anatomical joint limits" @click="setVariant('conformed')">Conformed</button>
            <button type="button" :class="{ active: variant === 'raw' }" :aria-pressed="variant === 'raw'" title="The pipeline's bake as delivered" @click="setVariant('raw')">Raw</button>
          </div>
        </header>

        <div class="avatar-wrap clip-avatar-wrap library-avatar-wrap">
          <ClipAvatarView
            :clip="clip"
            :media="null"
            :clock="clock"
            debug-id="sign-library"
            :label="`Deafference avatar signing ${currentLabel}`"
            @ready="avatarReady = true"
            @error="handleError"
            @status="viewStatus = $event"
          />

          <AvatarCornerLabel :label="mode === 'phrase' ? 'Phrase' : 'Word'" :value="currentLabel" />

          <div class="avatar-hud" aria-label="Playback state">
            <span :class="{ detected: phase === 'Sign' }"><i></i> {{ phase || '—' }}</span>
            <span :class="{ uncertain: variant === 'raw' }"><i></i> {{ variant }}</span>
            <span :class="{ uncertain: currentWord?.review !== 'approved' }"><i></i> {{ currentWord?.review === 'approved' ? 'Deaf-approved' : 'Not reviewed' }}</span>
          </div>
        </div>

        <div class="timeline library-timeline">
          <div class="phase-track" aria-hidden="true">
            <span v-for="segment in segments" :key="segment.startFrame" :style="strokeStyle(segment)" :title="`${glossLabel(segment.gloss)}: sign`"></span>
          </div>
          <input
            type="range"
            min="0"
            :max="Math.max(duration, 0.01)"
            step="0.001"
            :value="currentTime"
            :disabled="!clip"
            aria-label="Position"
            @input="seek"
          />
          <div><span>{{ currentTime.toFixed(2) }} s</span><span>{{ duration.toFixed(2) }} s</span></div>
        </div>

        <div class="transport">
          <button class="transport-main" type="button" :disabled="!clip" @click="togglePlayback">
            <span :class="playing ? 'pause-symbol' : 'play-symbol'" aria-hidden="true"></span>
            {{ playing ? 'Pause' : 'Play' }}
          </button>
          <button class="transport-icon" type="button" title="Restart" aria-label="Restart" :disabled="!clip" @click="restart">
            <span class="restart-symbol" aria-hidden="true"></span>
          </button>
          <button class="transport-text" type="button" title="Previous word (P)" :disabled="mode !== 'word' || !clip" @click="step(-1)">‹ Prev</button>
          <button class="transport-text" type="button" title="Next word (N)" :disabled="mode !== 'word' || !clip" @click="step(1)">Next ›</button>
          <label class="loop-toggle">
            <input v-model="loop" type="checkbox" :disabled="runAll.active" />
            <span>Loop</span>
          </label>
          <label class="speed-control">
            <span>Speed</span>
            <select v-model.number="rate">
              <option :value="0.25">0.25×</option>
              <option :value="0.5">0.5×</option>
              <option :value="0.75">0.75×</option>
              <option :value="1">1×</option>
            </select>
          </label>
        </div>

        <div class="tracking-readout">
          <div>
            <span class="metric-label">Frame</span>
            <strong>{{ viewStatus?.frameIndex ?? '—' }}<small> / {{ clip ? clip.file.frameCount - 1 : '—' }}</small></strong>
          </div>
          <div>
            <span class="metric-label">Phase</span>
            <strong class="phase-word">{{ phase || '—' }}</strong>
          </div>
          <div>
            <span class="metric-label">Sign length</span>
            <strong>{{ strokeSeconds }}<small> s</small></strong>
          </div>
        </div>

        <div class="run-all">
          <div>
            <strong>Play every word</strong>
            <small v-if="runAll.active">Word {{ runAll.position + 1 }} of {{ runAll.queue.length }} · {{ glossLabel(runAll.queue[runAll.position] ?? '') }}</small>
            <small v-else>Plays the words in the list below one after another (≈ {{ runAllMinutes }} min at 1×).</small>
          </div>
          <button type="button" :class="{ stop: runAll.active }" :disabled="!index || !avatarReady" @click="runAll.active ? stopRunAll() : startRunAll()">
            {{ runAll.active ? 'Stop' : 'Start' }}
          </button>
        </div>
      </article>

      <aside class="panel list-panel">
        <header class="panel-header">
          <div>
            <p>Library</p>
            <h2>Words</h2>
          </div>
          <span class="live-badge offline"><i></i> {{ index ? `${index.counts.words} baked` : 'Loading' }}</span>
        </header>
        <LibraryWordList
          v-if="index"
          ref="wordList"
          :words="index.words"
          :selected="selected"
          :current="mode === 'phrase' || runAll.active ? currentGloss : ''"
          :reviews="currentReviews"
          :attention="attention"
          @select="(gloss) => selectWord(gloss)"
        />
        <div v-else class="list-loading" aria-live="polite">
          <div class="loader-orbit"><span></span></div>
          <p>{{ loadError ? 'Library unavailable' : 'Loading the sign library' }}</p>
        </div>
      </aside>
    </div>

    <p v-if="loadError" class="error-banner" role="alert">
      <strong>Sign library:</strong> {{ loadError }}
      <button type="button" @click="loadError = null">Dismiss</button>
    </p>

    <div v-if="currentWord && index" class="library-detail">
      <article class="panel detail-panel">
        <header class="panel-header">
          <div>
            <p>Word {{ currentWord.gloss }}</p>
            <h2>{{ glossLabel(currentWord.gloss) }}</h2>
          </div>
          <span class="review-pill" :class="currentWord.review">{{ REVIEW_TEXT[currentWord.review] }}</span>
        </header>

        <div class="detail-body">
          <ul v-if="attention(currentWord).length" class="attention-list" aria-label="Check this word">
            <li v-for="item in attention(currentWord)" :key="item">{{ item }}</li>
          </ul>

          <dl class="detail-facts">
            <div><dt>Handedness</dt><dd>{{ CLASS_TEXT[currentWord.signClass] ?? currentWord.signClass }}</dd></div>
            <div><dt>Second hand</dt><dd>{{ PASSIVE_TEXT[currentWord.passive] ?? currentWord.passive }}</dd></div>
            <div><dt>Dataset take</dt><dd>sequence {{ currentWord.source.sequenceId }} · signer {{ currentWord.source.participantId }}</dd></div>
            <div><dt>Selection</dt><dd>candidate {{ currentWord.source.rank }} of {{ currentWord.source.alternatives + 1 }} · {{ SELECTION_TEXT[currentWord.source.selection] ?? currentWord.source.selection }}</dd></div>
            <div><dt>Timing</dt><dd>{{ currentWord.stroke }} sign frames + {{ currentWord.holdIn + currentWord.holdOut }} ease frames @ {{ index.fps }} fps</dd></div>
          </dl>

          <div class="qa-grid">
            <section v-for="v in index.variants" :key="v" :class="['qa-card', currentWord.qa[v].pass ? 'pass' : 'fail']" :aria-label="`Studio QA, ${v}`">
              <h3>{{ v === 'raw' ? 'Raw (pipeline)' : 'Conformed' }} · <span>{{ currentWord.qa[v].pass ? 'QA pass' : `${currentWord.qa[v].failures.length} QA finding${currentWord.qa[v].failures.length > 1 ? 's' : ''}` }}</span></h3>
              <ul v-if="currentWord.qa[v].failures.length">
                <li v-for="failure in currentWord.qa[v].failures" :key="failure">{{ failure }}</li>
              </ul>
              <p v-else>Joint ranges, hinges, finger order, wrist and elbow limits, continuity: all within the studio's thresholds.</p>
            </section>
          </div>

          <dl class="detail-facts conformance-facts" aria-label="What the conformance changed">
            <div><dt>Elbow swivel</dt><dd>{{ currentWord.conformance.maxSwivelDeg }}° <small>(hand kept in place)</small></dd></div>
            <div><dt>Hand orientation change</dt><dd :class="{ warn: currentWord.conformance.maxHandOrientationChangeDeg >= ORIENTATION_WARN_DEG }">{{ currentWord.conformance.maxHandOrientationChangeDeg }}°</dd></div>
            <div><dt>Fingertip shift</dt><dd>{{ currentWord.conformance.maxFingertipShiftMm }} mm</dd></div>
            <div><dt>Wrist position shift</dt><dd>{{ currentWord.conformance.maxHandPositionShiftMm }} mm</dd></div>
          </dl>
        </div>
      </article>

      <article class="panel review-panel">
        <header class="panel-header">
          <div>
            <p>Deaf review</p>
            <h2>Decision for this take</h2>
          </div>
          <span class="live-badge offline"><i></i> {{ reviewedCount }} reviewed</span>
        </header>
        <div class="review-body">
          <p class="review-note">
            Judge the conformed version (what the app ships). The decision is saved in this browser
            for the take (sequence {{ currentWord.source.sequenceId }}) and exported as the pipeline's
            <code>deaf_review_decisions.csv</code>.
          </p>
          <label class="review-field">
            <span>Reviewer</span>
            <input v-model="reviewer" type="text" autocomplete="name" placeholder="Name or initials" @change="saveReviewer" />
          </label>
          <label class="review-field">
            <span>Notes</span>
            <textarea v-model="notes" rows="3" placeholder="What is wrong or right: handshape, location, movement, orientation, second hand…"></textarea>
          </label>
          <div class="review-actions">
            <button type="button" class="approve" :class="{ active: decision === 'approved' }" :disabled="!canReview" @click="decide('approved')">Approve</button>
            <button type="button" class="reject" :class="{ active: decision === 'rejected' }" :disabled="!canReview" @click="decide('rejected')">Reject</button>
            <button type="button" :disabled="!canReview || !decision" @click="decide(null)">Clear</button>
          </div>
          <p v-if="!canReview" class="review-stale">Decisions are made one word at a time: pick the word in the list to review it.</p>
          <p v-if="staleDecision" class="review-stale">A saved decision belongs to another take of this word and is not exported.</p>
          <button type="button" class="export" :disabled="!reviewedCount" @click="exportCsv">Export deaf_review_decisions.csv</button>
          <small class="review-help">Shortcuts (outside text fields): Space play/pause · N next · P previous · A approve · X reject.</small>
        </div>
      </article>
    </div>

    <section v-if="index" class="panel phrase-panel" aria-labelledby="phrase-title">
      <header class="panel-header">
        <div>
          <p>Lookup test</p>
          <h2 id="phrase-title">Type English words, play their library signs back to back</h2>
        </div>
      </header>
      <div class="phrase-body">
        <form class="phrase-form" @submit.prevent="playPhrase">
          <label class="visually-hidden" for="phrase-input">Words</label>
          <input id="phrase-input" v-model="phraseText" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. hello thank you mom" />
          <button type="submit" :disabled="!phraseWords.length || !avatarReady">Play {{ phraseWords.length }} sign{{ phraseWords.length === 1 ? '' : 's' }}</button>
        </form>
        <ul class="phrase-tokens" aria-label="Lookup result">
          <li v-for="(token, i) in tokens" :key="`${i}-${token.text}`" :class="{ missing: !token.gloss, current: mode === 'phrase' && token.gloss && token.gloss === currentGloss }">
            <span>{{ token.text }}</span>
            <small>{{ token.gloss ? glossLabel(token.gloss) : 'not in library' }}</small>
          </li>
        </ul>
        <p class="phrase-note">
          Dictionary lookup in English word order, one isolated sign per word with an ease to the
          idle pose between signs. It does not apply ASL grammar, facial expressions or
          coarticulation, and words outside the 250-word library are skipped.
        </p>
      </div>
    </section>

    <section class="truth-strip" aria-label="Scope of the sign library">
      <div>
        <span class="truth-number">01</span>
        <p><strong>Isolated signs</strong>: one dataset take per word, retargeted onto this exact avatar (same GLB sha256 as the pipeline used).</p>
      </div>
      <div>
        <span class="truth-number">02</span>
        <p><strong>Second hands are synthesized</strong> for all {{ index?.counts.twoHanded ?? 87 }} two-handed words (mirrored or a lexicon base hand), not recorded.</p>
      </div>
      <div>
        <span class="truth-number">03</span>
        <p><strong>Pending Deaf review</strong>: none of these clips may be shown to users as correct signing until a fluent Deaf signer approves it.</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import AvatarCornerLabel from '../components/AvatarCornerLabel.vue'
import ClipAvatarView, { type ClipViewStatus } from '../components/ClipAvatarView.vue'
import LibraryWordList from '../components/LibraryWordList.vue'
import { MotionClip } from '../motion/clip/MotionClip'
import { PlaybackClock } from '../motion/clip/PlaybackClock'
import { segmentAt, sequenceMotionFile, wordMotionFile, type SequenceSegment } from '../motion/library/clips'
import type { LibraryVariant, ReviewStatus, SignLibraryWord } from '../motion/library/format'
import { loadSignLibrary, type LoadedSignLibrary } from '../motion/library/load'
import { buildLookup, glossLabel, lookupText } from '../motion/library/lookup'
import { parseReviewRecords, reviewCsv, type Decision, type ReviewRecord } from '../motion/library/review'
import type { ViewStatus } from '../types/ui'

const emit = defineEmits<{ status: [status: ViewStatus] }>()

const REVIEWS_KEY = 'deafference.signLibrary.reviews.v1'
const REVIEWER_KEY = 'deafference.signLibrary.reviewer.v1'
/** Hand-orientation change above which the conformed version must be compared with the raw one. */
const ORIENTATION_WARN_DEG = 15

const REVIEW_TEXT: Record<ReviewStatus, string> = {
  pending_deaf_review: 'Pending Deaf review',
  approved: 'Deaf-approved',
  rejected: 'Rejected'
}
const CLASS_TEXT: Record<string, string> = { '1': 'One-handed', '2s': 'Two-handed, symmetric', '2a': 'Two-handed, asymmetric' }
const PASSIVE_TEXT: Record<string, string> = {
  none: 'Not used (one-handed)',
  recorded: 'Recorded',
  mirrored_arm_and_hand: 'Synthesized: mirror of the dominant hand',
  mirrored_hand: 'Synthesized: mirrored handshape',
  base: 'Synthesized: static base hand from the lexicon'
}
const SELECTION_TEXT: Record<string, string> = {
  held_out: 'held-out signer',
  split_fallback: 'training signer (no held-out take passed)',
  gate_relaxed: 'quality gates relaxed'
}

const library = shallowRef<LoadedSignLibrary | null>(null)
const loadError = ref<string | null>(null)
const avatarReady = ref(false)
const selected = ref('')
const variant = ref<LibraryVariant>('conformed')
const mode = ref<'word' | 'phrase'>('word')
const clip = shallowRef<MotionClip | null>(null)
const segments = shallowRef<SequenceSegment[]>([])
const viewStatus = shallowRef<ClipViewStatus | null>(null)
const clock = new PlaybackClock()
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const rate = ref(1)
const loop = ref(true)
const runAll = reactive({ active: false, queue: [] as string[], position: 0 })
const wordList = ref<InstanceType<typeof LibraryWordList> | null>(null)
const phraseText = ref('hello thank you mom')
/** Words of the phrase being played (the text box may have changed since). */
const playedWords = shallowRef<SignLibraryWord[]>([])

const index = computed(() => library.value?.index ?? null)
const words = computed(() => index.value?.words ?? [])
const byGloss = computed(() => new Map(words.value.map((word) => [word.gloss, word])))
const lookup = computed(() => buildLookup(words.value.map((word) => word.gloss)))
const tokens = computed(() => lookupText(phraseText.value, lookup.value))
const phraseWords = computed(() => tokens.value.flatMap((token) => (token.gloss ? [byGloss.value.get(token.gloss)!] : [])))

const frame = computed(() => viewStatus.value?.frameIndex ?? 0)
const segmentIndex = computed(() => (segments.value.length ? segmentAt(segments.value, frame.value) : -1))
const currentGloss = computed(() => (segmentIndex.value >= 0 ? segments.value[segmentIndex.value].gloss : selected.value))
const currentWord = computed<SignLibraryWord | null>(() => byGloss.value.get(mode.value === 'phrase' ? currentGloss.value : selected.value) ?? null)
const currentLabel = computed(() => (currentWord.value ? glossLabel(currentWord.value.gloss) : '—'))
const phase = computed(() => {
  const segment = segments.value[segmentIndex.value]
  if (!segment || !clip.value) return ''
  if (frame.value < segment.strokeStart) return 'Ease in'
  if (frame.value < segment.strokeEnd) return 'Sign'
  return 'Return'
})
const strokeSeconds = computed(() => (currentWord.value && index.value ? (currentWord.value.stroke / index.value.fps).toFixed(2) : '—'))
const runAllMinutes = computed(() => {
  const queue = wordList.value?.visibleGlosses() ?? words.value.map((w) => w.gloss)
  const frames = queue.reduce((sum, gloss) => sum + (byGloss.value.get(gloss)?.frameCount ?? 0), 0)
  return index.value ? Math.max(1, Math.round(frames / index.value.fps / 60)) : 0
})

// ---- Review state (browser-local; exported as CSV).
const reviews = ref<Record<string, ReviewRecord>>(readStorage(REVIEWS_KEY, parseReviewRecords))
const reviewer = ref(readStorage(REVIEWER_KEY, (text) => text ?? ''))
const notes = ref('')
/** Decisions about the takes the library holds now (a decision about another take of the word is stale). */
const currentReviews = computed(() => Object.fromEntries(words.value.flatMap((w) => {
  const record = reviews.value[w.gloss]
  return record && record.sequenceId === w.source.sequenceId ? [[w.gloss, record]] : []
})) as Record<string, ReviewRecord>)
const reviewedCount = computed(() => Object.keys(currentReviews.value).length)
/** Review applies to the word on screen; in phrase mode that word changes while it plays. */
const canReview = computed(() => mode.value === 'word' && Boolean(currentWord.value))
const decision = computed<Decision | null>(() => {
  const word = currentWord.value
  const record = word ? reviews.value[word.gloss] : undefined
  return record && record.sequenceId === word!.source.sequenceId ? record.decision : null
})
const staleDecision = computed(() => {
  const word = currentWord.value
  const record = word ? reviews.value[word.gloss] : undefined
  return Boolean(record && record.sequenceId !== word!.source.sequenceId)
})

function readStorage<T>(key: string, parse: (text: string | null) => T): T {
  try {
    return parse(window.localStorage.getItem(key))
  } catch {
    return parse(null)
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode / blocked storage: decisions stay in memory for this visit.
  }
}

function attention(word: SignLibraryWord): string[] {
  const out: string[] = []
  for (const failure of word.qa.conformed.failures) {
    out.push(failure === 'hand resets to rest pose while tracked'
      ? 'The dominant hand stays at the rest handshape during the sign: this take had no finger data'
      : `Studio QA: ${failure}`)
  }
  if (word.conformance.maxHandOrientationChangeDeg >= ORIENTATION_WARN_DEG) {
    out.push(`Conformance turns the hand by up to ${word.conformance.maxHandOrientationChangeDeg}° (wrist beyond its range in the raw take): compare Conformed with Raw`)
  }
  return out
}

function strokeStyle(segment: SequenceSegment) {
  const total = Math.max(1, (clip.value?.file.frameCount ?? 1) - 1)
  return { left: `${(segment.strokeStart / total) * 100}%`, width: `${((segment.strokeEnd - segment.strokeStart) / total) * 100}%` }
}

// ---- Playback.
function loadClip(next: MotionClip, nextSegments: SequenceSegment[], options: { keepTime?: boolean; autoplay?: boolean } = {}) {
  const time = options.keepTime ? clock.time() : 0
  const wasPlaying = clock.playing
  clip.value = next
  segments.value = nextSegments
  clock.load(next.duration)
  clock.loop = loop.value && !runAll.active
  duration.value = next.duration
  if (options.keepTime) clock.seek(Math.min(time, next.duration))
  if (options.autoplay || (options.keepTime && wasPlaying)) clock.play()
  currentTime.value = clock.time()
}

function selectWord(gloss: string, options: { fromRunAll?: boolean; keepTime?: boolean } = {}) {
  const lib = library.value
  const word = byGloss.value.get(gloss)
  if (!lib || !word) return
  if (!options.fromRunAll && runAll.active) stopRunAll()
  mode.value = 'word'
  selected.value = gloss
  const next = new MotionClip(wordMotionFile(lib.index, lib.data, variant.value, word))
  loadClip(next, [{ gloss, startFrame: 0, frameCount: word.frameCount, strokeStart: word.holdIn, strokeEnd: word.holdIn + word.stroke }], { keepTime: options.keepTime, autoplay: !options.keepTime })
}

function playPhrase() {
  const lib = library.value
  if (!lib || !phraseWords.value.length) return
  if (runAll.active) stopRunAll()
  mode.value = 'phrase'
  playedWords.value = phraseWords.value
  const sequence = sequenceMotionFile(lib.index, lib.data, variant.value, playedWords.value)
  loadClip(new MotionClip(sequence.file), sequence.segments, { autoplay: true })
}

function setVariant(next: LibraryVariant) {
  if (next === variant.value) return
  variant.value = next
  if (mode.value === 'phrase') {
    const lib = library.value
    if (!lib || !playedWords.value.length) return
    const sequence = sequenceMotionFile(lib.index, lib.data, next, playedWords.value)
    loadClip(new MotionClip(sequence.file), sequence.segments, { keepTime: true })
  } else if (selected.value) {
    selectWord(selected.value, { keepTime: true, fromRunAll: runAll.active })
  }
}

function togglePlayback() {
  if (!clip.value) return
  if (clock.playing) clock.pause()
  else clock.play()
  playing.value = clock.playing
}

function restart() {
  if (!clip.value) return
  clock.seek(0)
  clock.play()
}

function seek(event: Event) {
  clock.seek(Number((event.target as HTMLInputElement).value))
  currentTime.value = clock.time()
}

function visibleOrder() {
  return wordList.value?.visibleGlosses() ?? words.value.map((w) => w.gloss)
}

function step(delta: number) {
  const order = visibleOrder()
  if (!order.length) return
  const at = order.indexOf(selected.value)
  const next = order[(at + delta + order.length) % order.length]
  selectWord(next)
  document.querySelector<HTMLButtonElement>(`.word-row[data-gloss="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' })
}

function startRunAll() {
  const queue = visibleOrder()
  if (!queue.length) return
  runAll.active = true
  runAll.queue = queue
  runAll.position = 0
  selectWord(queue[0], { fromRunAll: true })
}

function stopRunAll() {
  runAll.active = false
  clock.loop = loop.value
}

function advanceRunAll() {
  runAll.position += 1
  if (runAll.position >= runAll.queue.length) {
    stopRunAll()
    return
  }
  const gloss = runAll.queue[runAll.position]
  selectWord(gloss, { fromRunAll: true })
  document.querySelector<HTMLButtonElement>(`.word-row[data-gloss="${CSS.escape(gloss)}"]`)?.scrollIntoView({ block: 'nearest' })
}

watch(loop, (value) => {
  clock.loop = value && !runAll.active
})

watch(rate, (value) => clock.setRate(value))

let raf = 0
function tick() {
  currentTime.value = clock.time()
  playing.value = clock.playing
  if (runAll.active && clock.ended) advanceRunAll()
  raf = requestAnimationFrame(tick)
}

// ---- Review actions.
function decide(next: Decision | null) {
  const word = currentWord.value
  if (!word || !canReview.value) return
  const updated = { ...reviews.value }
  if (next) {
    updated[word.gloss] = { gloss: word.gloss, sequenceId: word.source.sequenceId, decision: next, notes: notes.value.trim(), reviewer: reviewer.value.trim(), at: new Date().toISOString() }
  } else {
    delete updated[word.gloss]
  }
  reviews.value = updated
  writeStorage(REVIEWS_KEY, JSON.stringify(updated))
}

// The notes field shows the saved notes of the word on screen.
watch(() => currentWord.value?.gloss, () => {
  const word = currentWord.value
  const record = word ? reviews.value[word.gloss] : undefined
  notes.value = record && record.sequenceId === word!.source.sequenceId ? record.notes : ''
})

watch(notes, (value) => {
  // Keep the saved decision's notes in sync while the reviewer types.
  const word = currentWord.value
  const record = word ? reviews.value[word.gloss] : undefined
  if (!word || !record || record.sequenceId !== word.source.sequenceId || record.notes === value.trim()) return
  reviews.value = { ...reviews.value, [word.gloss]: { ...record, notes: value.trim(), at: new Date().toISOString() } }
  writeStorage(REVIEWS_KEY, JSON.stringify(reviews.value))
})

function saveReviewer() {
  writeStorage(REVIEWER_KEY, reviewer.value.trim())
}

function exportCsv() {
  const csv = reviewCsv(words.value, currentReviews.value)
  // BOM so spreadsheet apps open the UTF-8 correctly; the pipeline strips it.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'deaf_review_decisions.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function handleKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
  const key = event.key.toLowerCase()
  if (key === ' ') {
    // Space on a focused button activates that button; leave it alone.
    if (target?.closest('button')) return
    event.preventDefault()
    togglePlayback()
  } else if (key === 'n') step(1)
  else if (key === 'p') step(-1)
  else if (key === 'a') decide('approved')
  else if (key === 'x') decide('rejected')
}

function handleError(message: string) {
  loadError.value = `The avatar could not be shown: ${message}`
}

// ---- Status pill.
const status = computed<ViewStatus>(() => {
  if (loadError.value && !index.value) return { text: 'Sign library unavailable', error: true }
  if (!index.value || !avatarReady.value) return { text: 'Preparing sign library' }
  if (playing.value) return { text: `Playing ${currentLabel.value}`, live: true }
  return { text: 'Ready', ready: true }
})
watch(status, (value) => emit('status', value), { immediate: true })

// ---- Lifecycle.
let abort: AbortController | null = null

function installDebugHook() {
  if (!new URLSearchParams(window.location.search).has('debug')) return
  ;(window as unknown as Record<string, unknown>).__deafferenceLibrary = {
    select: (gloss: string) => selectWord(gloss),
    setVariant: (next: LibraryVariant) => setVariant(next),
    pause: () => { clock.pause() },
    seek: (seconds: number) => { clock.seek(seconds) },
    playPhrase: (text: string) => { phraseText.value = text; playPhrase() },
    state: () => ({ selected: selected.value, variant: variant.value, mode: mode.value, time: clock.time(), playing: clock.playing, clipId: clip.value?.file.clipId ?? null, frameCount: clip.value?.file.frameCount ?? 0 })
  }
}

onMounted(async () => {
  raf = requestAnimationFrame(tick)
  window.addEventListener('keydown', handleKey)
  installDebugHook()
  abort = new AbortController()
  try {
    library.value = await loadSignLibrary(undefined, abort.signal)
    const first = byGloss.value.has('hello') ? 'hello' : words.value[0]?.gloss
    if (first) selectWord(first)
  } catch (cause) {
    if (abort.signal.aborted) return
    loadError.value = cause instanceof Error ? cause.message : String(cause)
  }
})

onBeforeUnmount(() => {
  abort?.abort()
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', handleKey)
  delete (window as unknown as Record<string, unknown>).__deafferenceLibrary
})
</script>

<style scoped>
.library-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0 0 18px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}

.library-stats > div {
  display: grid;
  gap: 6px;
  padding: 14px 18px;
}

.library-stats > div + div {
  border-left: 1px solid var(--line);
}

.library-stats dt {
  color: var(--muted-2);
  font-size: 8px;
  font-weight: 750;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.library-stats dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
}

.library-stats dd small {
  color: var(--muted-2);
  font-family: Inter, ui-sans-serif, sans-serif;
  font-size: 10px;
}

.library-workspace {
  grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.75fr);
  align-items: start;
}

.library-avatar-wrap {
  min-height: 500px;
  height: min(60vh, 600px);
}

.variant-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}

.variant-switch button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  color: var(--muted);
  background: transparent;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.variant-switch button.active {
  color: #062029;
  background: var(--cyan);
}

.library-timeline {
  position: relative;
}

.phase-track {
  position: relative;
  height: 4px;
  margin-bottom: 8px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.06);
}

.phase-track span {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 2px;
  background: var(--green);
  opacity: 0.75;
}

.transport-text {
  padding: 0 10px;
  color: var(--ink);
  font-size: 10px;
  font-weight: 650;
}

.loop-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.loop-toggle input {
  accent-color: var(--cyan);
}

.phase-word {
  font-family: inherit !important;
  font-size: 13px !important;
}

.run-all {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 19px 17px;
}

.run-all div {
  display: grid;
  gap: 4px;
}

.run-all strong {
  font-size: 12px;
  font-weight: 650;
}

.run-all small {
  color: var(--muted);
  font-size: 10px;
}

.run-all button {
  height: 34px;
  min-width: 84px;
  border: 1px solid var(--cyan);
  border-radius: 7px;
  color: var(--cyan);
  background: transparent;
  font-size: 10px;
  font-weight: 750;
  cursor: pointer;
}

.run-all button.stop {
  color: #2b0505;
  border-color: var(--danger);
  background: var(--danger);
}

.run-all button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.list-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.list-loading {
  display: grid;
  place-items: center;
  gap: 12px;
  min-height: 240px;
  color: var(--muted);
  font-size: 12px;
}

.library-detail {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.75fr);
  gap: 18px;
  margin-top: 18px;
}

.detail-body,
.review-body,
.phrase-body {
  display: grid;
  gap: 14px;
  padding: 18px 22px 22px;
}

.review-pill {
  padding: 5px 9px;
  border-radius: 999px;
  color: #1d1200;
  background: var(--orange);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.review-pill.approved {
  color: #04261a;
  background: var(--green);
}

.attention-list {
  margin: 0;
  padding: 12px 14px 12px 30px;
  border: 1px solid rgba(255, 184, 107, 0.35);
  border-radius: 10px;
  color: #ffd9b0;
  background: rgba(255, 184, 107, 0.07);
  font-size: 12px;
  line-height: 1.55;
}

.detail-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px 18px;
  margin: 0;
}

.detail-facts dt {
  margin-bottom: 4px;
  color: var(--muted-2);
  font-size: 8px;
  font-weight: 750;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.detail-facts dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.detail-facts dd small {
  color: var(--muted-2);
}

.detail-facts dd.warn {
  color: var(--orange);
  font-weight: 700;
}

.qa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.qa-card {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}

.qa-card h3 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
}

.qa-card.pass h3 span {
  color: var(--green);
}

.qa-card.fail h3 span {
  color: var(--danger);
}

.qa-card ul {
  margin: 0;
  padding-left: 16px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.qa-card p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.review-note,
.phrase-note {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}

.review-note code {
  color: var(--ink);
  font-size: 10px;
}

.review-field {
  display: grid;
  gap: 6px;
  color: var(--muted-2);
  font-size: 8px;
  font-weight: 750;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.review-field input,
.review-field textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: #0c1417;
  font-size: 12px;
  letter-spacing: normal;
  text-transform: none;
  resize: vertical;
}

.review-actions {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
}

.review-actions button,
.export,
.phrase-form button {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.03);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.review-actions button:disabled,
.export:disabled,
.phrase-form button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.review-actions .approve.active {
  color: #04261a;
  border-color: var(--green);
  background: var(--green);
}

.review-actions .reject.active {
  color: #2b0505;
  border-color: var(--danger);
  background: var(--danger);
}

.review-stale {
  margin: 0;
  color: var(--orange);
  font-size: 11px;
}

.review-help {
  color: var(--muted-2);
  font-size: 10px;
}

.phrase-panel {
  margin-top: 18px;
}

.phrase-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
}

.phrase-form input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--ink);
  background: #0c1417;
  font-size: 14px;
}

.phrase-form button {
  height: 40px;
  color: #062029;
  border-color: var(--cyan);
  background: var(--cyan);
}

.phrase-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.phrase-tokens li {
  display: grid;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid rgba(132, 240, 191, 0.3);
  border-radius: 8px;
  background: rgba(132, 240, 191, 0.06);
}

.phrase-tokens li.missing {
  border-color: rgba(255, 139, 139, 0.35);
  background: rgba(255, 139, 139, 0.06);
}

.phrase-tokens li.current {
  border-color: var(--green);
  box-shadow: 0 0 0 1px var(--green) inset;
}

.phrase-tokens span {
  font-size: 13px;
  font-weight: 600;
}

.phrase-tokens small {
  color: var(--muted);
  font-size: 9px;
}

.phrase-tokens li.missing small {
  color: var(--danger);
}

@media (max-width: 1050px) {
  .library-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .library-stats > div:nth-child(4) {
    border-left: 0;
  }

  .library-stats > div:nth-child(n + 4) {
    border-top: 1px solid var(--line);
  }
}

@media (max-width: 840px) {
  .library-workspace,
  .library-detail {
    grid-template-columns: 1fr;
  }

  .library-avatar-wrap {
    height: 62vh;
    min-height: 460px;
  }

  .qa-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 610px) {
  .library-stats {
    grid-template-columns: 1fr 1fr;
  }

  .library-stats > div {
    border-left: 0 !important;
    border-top: 1px solid var(--line);
  }

  .library-stats > div:nth-child(-n + 2) {
    border-top: 0;
  }

  .library-stats > div:nth-child(even) {
    border-left: 1px solid var(--line) !important;
  }

  .transport {
    flex-wrap: wrap;
  }

  .speed-control {
    margin-left: 0;
  }

  .run-all {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-body,
  .review-body,
  .phrase-body {
    padding: 16px;
  }

  .phrase-form {
    grid-template-columns: 1fr;
  }
}
</style>
