<script setup lang="ts">
// Ablauf am Wahltag: a checklist for the teacher, in the order of the
// day, and what to do when something goes wrong. Words only; the pages
// themselves say what each step does when it is taken.

import { usePageTitle } from '../lib/page-title.ts'

usePageTitle(() => 'Ablauf am Wahltag')
</script>

<template>
  <h1>Ablauf am Wahltag</h1>
  <p class="muted">
    Was die Wahlleitung vor, während und nach dem Wahltermin tut, und was bei Zwischenfällen zu tun ist. Jeder Schritt steht auf der Seite des Wahltermins im Abschnitt „Wahltag“.
  </p>

  <h2>Vor dem Wahltag</h2>
  <ol>
    <li>Den Wahltermin mit seinen Wahlen anlegen, Kandidat:innen mit Foto eintragen, Klassen oder Gruppen anlegen und den Wahlen zuordnen.</li>
    <li>Einen Co-Admin und zwei Zeug:innen einladen; sie melden sich einmal an.</li>
    <li>Vorbereiten. Danach Stimmkarten je Klasse erzeugen und drucken, sechs je A4-Seite; für eine mögliche Stichwahl gleich Stichwahl-Stimmkarten mit.</li>
    <li>Einen Probelauf machen: mit echten Stimmkarten am Handy wählen, den Zwischenstand ansehen, den Probelauf beenden. Nichts davon bleibt.</li>
  </ol>

  <h2>Am Wahltag</h2>
  <ol>
    <li>Den 1. Wahlgang öffnen. Ab jetzt ändern sich Kandidat:innen und die Stimmkarten des 1. Wahlgangs nicht mehr.</li>
    <li>Stimmkarten ausgeben, eine je wahlberechtigte Person, nach Ausweiskontrolle durch die Wahlkommission. Die Karte wählt; wer sie hat, wählt.</li>
    <li>Die Beteiligung mitlesen: sie zählt verwendete Stimmkarten, nie Stimmen für jemanden.</li>
    <li>Den 1. Wahlgang beenden und auszählen, sobald alle gewählt haben. Die Stimmzettel werden versiegelt und ausgezählt; das Ergebnis mit Herleitung erscheint.</li>
    <li>Braucht eine Wahl ein Los, zieht es die Wahlkommission; die Wahlleitung trägt die Reihenfolge mit Begründung ein.</li>
    <li>Braucht eine Wahl eine Stichwahl: die Stichwahl-Stimmkarten ausgeben, die Stichwahl aktivieren, wählen lassen, beenden und auszählen. Die Stimmkarten des 1. Wahlgangs gelten nicht mehr.</li>
    <li>Das Ergebnis endgültig feststellen, mit Begründung. Damit ist der Wahltermin abgeschlossen; danach ändert sich nichts mehr.</li>
    <li>Den Export herunterladen und der Wahlkommission übergeben; die Prüfsumme steht im Protokoll.</li>
  </ol>

  <h2>Zwischenfälle</h2>
  <dl>
    <dt>Stimmkarten sind verloren gegangen oder unbrauchbar</dt>
    <dd>Vor dem Öffnen: unter „Stimmkarten“ den Stapel der Klasse ersetzen; die alten Codes gelten nicht mehr, die neuen werden gedruckt. Nach dem Öffnen gibt es für den 1. Wahlgang keine neuen Stimmkarten mehr.</dd>
    <dt>Eine Klasse braucht mehr Stimmkarten</dt>
    <dd>Vor dem Öffnen weitere erzeugen: ein zweiter Stapel für dieselbe Klasse, der eigene Seiten druckt; die bisherigen bleiben gültig.</dd>
    <dt>Ein Wahlgang wurde zu früh beendet</dt>
    <dd>Ein beendeter Wahlgang öffnet nicht wieder. Das Ergebnis mit einer Begründung feststellen, die das festhält, und einen neuen Wahltermin anlegen.</dd>
    <dt>Jemand hat eine Stimmkarte fotografiert</dt>
    <dd>Eine Stimmkarte wählt einmal je Wahl. Wer sie zuerst verwendet, wählt; danach ist sie verbraucht. Vor dem Öffnen den Stapel ersetzen, wenn der Vorfall bekannt wird.</dd>
    <dt>Das Handy zeigt „Die Stimmabgabe hat noch nicht begonnen“</dt>
    <dd>Der 1. Wahlgang ist noch nicht geöffnet, oder die Stichwahl noch nicht aktiviert. Die Stimmkarten des 1. Wahlgangs gelten in der Stichwahl nicht.</dd>
  </dl>

  <h2>Was Zeug:innen sehen</h2>
  <p>
    Dieselben Seiten ohne die Knöpfe: die Einrichtung, die Mitglieder, die Anzahl der Stimmkarten, die Beteiligung, nach dem Auszählen das Ergebnis mit seiner Herleitung und die verwendeten Codes, und jederzeit das Protokoll. Solange ein Wahlgang läuft, sieht niemand ein Ergebnis.
  </p>
</template>

<style scoped>
dt {
  font-weight: 600;
  margin-top: 10px;
}

dd {
  margin: 2px 0 0;
}
</style>
