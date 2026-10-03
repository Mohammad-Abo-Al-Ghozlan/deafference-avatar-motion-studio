<template>
  <div class="avatar-corner-label">
    <img class="avatar-logo" :src="LOGO_ON_DARK" alt="Deafference" width="614" height="260" decoding="async" />
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
  </div>
</template>

<script setup lang="ts">
/** Top-left overlay of every avatar view: the Deafference logo and what drives the motion. */
withDefaults(defineProps<{ value: string; label?: string }>(), { label: 'Motion' })

// Generated from media/brand/deafference-logo.original.png by tools/brand/make_logo_variants.py.
const LOGO_ON_DARK = '/brand/deafference-logo-on-dark.png'
</script>
