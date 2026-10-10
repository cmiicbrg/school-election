<script setup lang="ts">
// How to print the sheets, for both print pages: a batch's page shows the
// same codes every time; a Wahlgang's shows its valid batches as they are
// when it opens, so a top-up or a replacement comes in with the next
// opening. Either prints until the Wahlgang begins, at actual size.

defineProps<{
  /** The page of every batch of a Wahlgang, not of one. */
  all?: boolean
}>()
</script>

<template>
  <p v-if="all">
    Diese Seite zeigt alle gültigen Stapel des Wahlgangs, jeden mit immer denselben Codes; ein zusätzlicher oder ersetzter Stapel kommt beim nächsten Öffnen dazu. Sie kann bis zum Beginn des Wahlgangs noch einmal gedruckt werden.
  </p>
  <p v-else>
    Diese Seite zeigt immer dieselben Codes. Sie kann bis zum Beginn des Wahlgangs noch einmal gedruckt werden; neue Codes gibt es nur über „Stapel ersetzen“ auf der Seite des Wahltermins.
  </p>
  <p>
    Ohne Verkleinerung drucken (tatsächliche Größe, keine Ränder): Jede Karte ist genau ein Sechstel des Blattes, drei Schnitte entlang der Linien trennen sie.
  </p>
</template>
