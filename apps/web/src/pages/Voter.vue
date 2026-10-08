<script setup lang="ts">
// The voter page, where a card's QR code and typed address lead. The key
// comes from the fragment (voter/bootstrap.ts, before the router) or is
// typed; the page redeems it once, shows the election and the contests the
// key may vote in, one ballot at a time with a review before it is sent,
// and says when everything is cast. The steps live in this component's
// state, never in the URL; a flag in sessionStorage, never a key, lets a
// reload resume the session. The client of its own (voter/voter-api.ts)
// sends nobody to the sign-in page: a voter's 401 is back to the code.
//
// Every request of the session runs through one lane (voter/lane.ts),
// one after another, and belongs to the session it started in: another
// card scanned into this tab starts a new one, as does leaving the page,
// and an answer of an older session changes nothing on the page. So an
// answer that ends a session (the last ballot's, "Beenden"'s) is in
// before the next card is redeemed, and the cookie set last is the last
// card's. The lane is the tab's, not this mounting's.

import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePageTitle } from '../lib/page-title.ts'
import { toSend } from '../voter/ballot-state.ts'
import { pendingKey } from '../voter/bootstrap.ts'
import ContestList from '../voter/ContestList.vue'
import { currentSession, inLane, keyQueued, nextSession, queueKey, stale, takeQueuedKey } from '../voter/lane.ts'
import KeyEntry from '../voter/KeyEntry.vue'
import ReviewStep from '../voter/ReviewStep.vue'
import SlotBallot from '../voter/SlotBallot.vue'
import { castBallot, contests, endSession, redeem, VoterError, type VoterBallot, type VoterContest, type VoterElection } from '../voter/voter-api.ts'
import { keyHint, messageFor } from '../voter/voter-rules.ts'

type Step
  = | { kind: 'loading' }
    | { kind: 'code' }
    | { kind: 'list' }
    | { kind: 'ballot', contest: VoterContest, initial?: VoterBallot }
    | { kind: 'review', contest: VoterContest, ballot: VoterBallot }
    | { kind: 'done' }

/** Set from redemption until the session ends, so that a reload resumes it; never a key. */
const FLAG = 'voter'

const router = useRouter()
const root = ref<HTMLElement | null>(null)
const step = ref<Step>({ kind: 'loading' })
const election = ref<VoterElection | null>(null)
usePageTitle(() => 'Stimmabgabe')
const message = ref<string | null>(null)
const busy = ref(false)

function go(next: Step, note: string | null = null): void {
  message.value = note
  step.value = next
}

// A step's heading takes the focus, so that the change is read out and the
// keyboard starts at the top; the code step's field takes it itself.
watch(step, async (now) => {
  if (now.kind === 'code' || now.kind === 'loading') return
  await nextTick()
  root.value?.querySelector<HTMLElement>('h1')?.focus()
})

function flagged(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

function flag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FLAG, '1')
    else sessionStorage.removeItem(FLAG)
  } catch {
    // A browser without storage resumes nothing; voting works all the same.
  }
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  const key = pendingKey()
  if (key !== undefined) enqueue(key)
  else if (flagged()) inLane(resume)
  else go({ kind: 'code' })
})

// Leaving the page ends its session's say: an answer still on its way
// changes nothing, and a page mounted again starts after it in the lane.
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  nextSession()
})

/**
 * Another card scanned into this tab: the browser changed the fragment
 * without loading the page again, take-key.ts took the key out of it
 * before this runs, and the router, which heard the navigation first, is
 * told the address is /v again. The page forgets the session so far at
 * once, whatever step it was on, and starts over with the new key once
 * the lane is free.
 */
function onHashChange(): void {
  const key = pendingKey()
  if (key === undefined) return
  void router.replace('/v')
  nextSession()
  election.value = null
  flag(false)
  go({ kind: 'loading' })
  enqueue(key)
}

/** A code to redeem, from the fragment or typed: the latest one waiting is redeemed when the lane is free. */
function enqueue(key: string): void {
  queueKey(key)
  inLane(async () => {
    const next = takeQueuedKey()
    if (next !== undefined) await redeemKey(next)
  })
}

/** A code, checked here first, so a malformed one is never sent. */
async function redeemKey(key: string): Promise<void> {
  const hint = keyHint(key)
  if (hint !== null) {
    go({ kind: 'code' }, hint)
    return
  }
  const mine = currentSession()
  message.value = null
  busy.value = true
  try {
    const known = await redeem(key)
    if (stale(mine) || keyQueued()) return
    flag(true)
    arrived(known)
  } catch (err) {
    if (stale(mine) || keyQueued()) return
    go({ kind: 'code' }, messageFor(err))
  } finally {
    busy.value = false
  }
}

async function resume(): Promise<void> {
  const mine = currentSession()
  try {
    const known = await contests()
    if (stale(mine)) return
    arrived(known)
  } catch (err) {
    if (stale(mine)) return
    flag(false)
    go({ kind: 'code' }, messageFor(err))
  }
}

function arrived(known: VoterElection): void {
  election.value = known
  go({ kind: 'list' })
}

function open(contest: VoterContest): void {
  go({ kind: 'ballot', contest })
}

function toList(): void {
  go({ kind: 'list' })
}

function toReview(ballot: VoterBallot): void {
  if (step.value.kind === 'ballot') go({ kind: 'review', contest: step.value.contest, ballot })
}

function correct(): void {
  if (step.value.kind === 'review') go({ kind: 'ballot', contest: step.value.contest, initial: step.value.ballot })
}

function markDone(contest: VoterContest, remaining?: number): void {
  if (!election.value) return
  const known = election.value.contests.find((entry) => entry.id === contest.id)
  if (known) known.done = true
  election.value.remaining = remaining ?? election.value.contests.filter((entry) => !entry.done).length
}

function submit(confirmInvalid: boolean): void {
  if (step.value.kind !== 'review') return
  const { contest, ballot } = step.value
  inLane(() => cast(contest, ballot, confirmInvalid))
}

async function cast(contest: VoterContest, ballot: VoterBallot, confirmInvalid: boolean): Promise<void> {
  const mine = currentSession()
  message.value = null
  busy.value = true
  try {
    const answer = await castBallot(contest.roundContestId, toSend(ballot, confirmInvalid))
    if (stale(mine)) return
    markDone(contest, answer.remaining)
    if (answer.done) {
      flag(false)
      go({ kind: 'done' })
    } else {
      go({ kind: 'list' })
    }
  } catch (err) {
    if (stale(mine)) return
    if (err instanceof VoterError && err.code === 'already_voted') {
      markDone(contest)
      go({ kind: 'list' }, messageFor(err))
    } else if (err instanceof VoterError && err.code === 'no_session') {
      flag(false)
      election.value = null
      go({ kind: 'code' }, messageFor(err))
    } else {
      message.value = messageFor(err)
    }
  } finally {
    busy.value = false
  }
}

/**
 * The way out, for a second person at the same phone: the answer takes the
 * cookie with it, and the page forgets everything. When the request fails
 * the cookie is still there, so the page stays as it is and says so,
 * rather than showing the next person a page that looks handed over.
 */
function end(): void {
  inLane(async () => {
    const mine = currentSession()
    message.value = null
    busy.value = true
    try {
      await endSession()
    } catch (err) {
      if (!stale(mine)) message.value = messageFor(err)
      return
    } finally {
      busy.value = false
    }
    if (stale(mine)) return
    flag(false)
    election.value = null
    go({ kind: 'code' })
  })
}
</script>

<template>
  <main
    ref="root"
    class="voter"
  >
    <output
      v-if="step.kind === 'loading'"
      class="status muted"
    >
      Einen Moment …
    </output>
    <KeyEntry
      v-else-if="step.kind === 'code'"
      :message="message"
      :busy="busy"
      @submit="enqueue"
    />
    <ContestList
      v-else-if="step.kind === 'list' && election"
      :election="election"
      :message="message"
      :busy="busy"
      @open="open"
      @end="end"
    />
    <SlotBallot
      v-else-if="step.kind === 'ballot'"
      :key="step.contest.id"
      :contest="step.contest"
      :initial="step.initial"
      @review="toReview"
      @back="toList"
    />
    <ReviewStep
      v-else-if="step.kind === 'review'"
      :contest="step.contest"
      :ballot="step.ballot"
      :busy="busy"
      :message="message"
      @submit="submit"
      @correct="correct"
    />
    <section
      v-else-if="step.kind === 'done'"
      aria-labelledby="voter-heading"
    >
      <h1
        id="voter-heading"
        tabindex="-1"
      >
        Danke!
      </h1>
      <p>Ihre Stimme ist abgegeben. Sie können diese Seite jetzt schließen.</p>
    </section>
  </main>
</template>

<style scoped>
.voter {
  max-width: 36rem;
  margin: 0 auto;
  padding: 16px;
}

.status {
  display: block;
  margin: 0 0 10px;
}

.voter :deep(h1:focus) {
  outline: none;
}

.voter :deep(h1:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}

.voter :deep(button) {
  min-height: 44px;
}
</style>
