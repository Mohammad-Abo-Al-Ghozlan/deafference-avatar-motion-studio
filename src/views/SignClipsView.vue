<template>
  <main id="top" class="clips-view">
    <section class="intro clips-intro" aria-labelledby="clips-title">
      <div>
        <p class="eyebrow"><span>Clips</span> Two recordings · one pipeline</p>
        <h1 id="clips-title">Two recorded clips.<br /><em>Replayed by the avatar.</em></h1>
      </div>
      <p class="intro-copy">
        Each section plays a recorded signer next to the Deafference avatar.
        The avatar's motion was computed offline from that video, with the same
        pipeline and QA as the studio's sample clip, and follows the frame on screen.
      </p>
    </section>

    <nav class="clip-jump" aria-label="Sections">
      <a v-for="config in clips" :key="config.id" :href="`#section-${config.section}`" @click.prevent="jumpTo(config.section)">
        <span>{{ String(config.section).padStart(2, '0') }}</span>
        Section {{ config.section }}
        <small>{{ stateText(config.id) }}</small>
      </a>
    </nav>

    <SignClipSection
      v-for="config in clips"
      :key="config.id"
      :ref="(instance) => registerSection(config.id, instance)"
      :config="config"
      @playing="pauseOthers"
      @state="states[$event.id] = $event"
    />

    <section class="truth-strip" aria-label="Scope of these clips">
      <div>
        <span class="truth-number">01</span>
        <p><strong>Motion transfer</strong> replays each recorded performance on the avatar; it does not translate or generate signing.</p>
      </div>
      <div>
        <span class="truth-number">02</span>
        <p><strong>Same offline pipeline</strong> for every clip: Holistic tracking, anatomical hand model, constrained IK, full-clip QA.</p>
      </div>
      <div>
        <span class="truth-number">03</span>
        <p><strong>Human review remains required</strong>: a fluent Deaf signer must review these animations before they are treated as accurate signing.</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import SignClipSection from '../components/SignClipSection.vue'
import { SIGN_CLIPS } from './signClips'
import type { ViewStatus } from '../types/ui'

type SectionInstance = InstanceType<typeof SignClipSection>
interface SectionState { id: string; ready: boolean; playing: boolean; error: boolean }

const emit = defineEmits<{ status: [status: ViewStatus] }>()

const clips = SIGN_CLIPS
const sections = new Map<string, SectionInstance>()
const states = reactive<Record<string, SectionState>>({})

function registerSection(id: string, instance: unknown) {
  if (instance) sections.set(id, instance as SectionInstance)
  else sections.delete(id)
}

/** One section plays at a time: starting one pauses the others. */
function pauseOthers(id: string) {
  for (const [other, section] of sections) if (other !== id) section.pause()
}

function jumpTo(section: number) {
  document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function stateText(id: string) {
  const state = states[id]
  if (!state) return 'Loading'
  if (state.error) return 'Unavailable'
  if (state.playing) return 'Playing'
  return state.ready ? 'Ready' : 'Loading'
}

const status = computed<ViewStatus>(() => {
  const list = clips.map((c) => states[c.id])
  const playing = clips.find((c) => states[c.id]?.playing)
  if (playing) return { text: `Playing section ${playing.section}`, live: true }
  if (list.some((s) => s?.error)) return { text: 'A clip is unavailable', error: true }
  if (list.every((s) => s?.ready)) return { text: 'Ready', ready: true }
  return { text: 'Preparing clips' }
})

watch(status, (value) => emit('status', value), { immediate: true })
</script>
