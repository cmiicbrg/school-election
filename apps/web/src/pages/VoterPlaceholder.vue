<script setup lang="ts">
// Where a card's QR code and typed address lead: the voter page, which a
// later version fills in. Until then this page says so and touches
// nothing: the key stays in the fragment, which the browser never sends,
// and this page never reads it.
</script>

<template>
  <main class="voter">
    <h1>Stimmabgabe</h1>
    <p>Die Stimmabgabe ist in dieser Version noch nicht möglich. Bitte wenden Sie sich an die Wahlleitung.</p>
  </main>
</template>

<style scoped>
.voter {
  max-width: 36rem;
  margin: 0 auto;
  padding: 16px;
  font-family: system-ui, sans-serif;
}
</style>
