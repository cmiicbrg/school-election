<script setup lang="ts">
// Ablauf am Wahltag: a checklist for the teacher, in the order of the
// day, and what to do when something goes wrong. Words only; the pages
// themselves say what each step does when it is taken.
</script>

<template>
  <h1>Ablauf am Wahltag</h1>
  <p class="muted">
    Was die Wahlleitung vor, während und nach der Wahl tut, und was bei Zwischenfällen zu tun ist. Jeder Schritt steht auf der Seite der Wahl im Abschnitt „Ablauf“.
  </p>

  <h2>Vor dem Wahltag</h2>
  <ol>
    <li>Die Wahl anlegen, Kandidat:innen mit Foto eintragen, Klassen oder Gruppen anlegen und zuordnen.</li>
    <li>Eine Co-Admin und zwei Zeug:innen einladen; sie melden sich einmal an.</li>
    <li>Vorbereiten. Danach Stimmkarten je Klasse erzeugen und drucken, sechs je A4-Seite; für eine mögliche Stichwahl gleich Stichwahl-Stimmkarten mit.</li>
    <li>Einen Probelauf machen: mit echten Stimmkarten am Handy wählen, den Zwischenstand ansehen, den Probelauf beenden. Nichts davon bleibt.</li>
  </ol>

  <h2>Am Wahltag</h2>
  <ol>
    <li>Die Wahl öffnen. Ab jetzt ändern sich Kandidat:innen und die Stimmkarten der ersten Runde nicht mehr.</li>
    <li>Stimmkarten ausgeben, eine je wahlberechtigte Person, nach Ausweiskontrolle durch die Wahlkommission. Die Karte wählt; wer sie hat, wählt.</li>
    <li>Die Beteiligung mitlesen: sie zählt verwendete Stimmkarten, nie Stimmen für jemanden.</li>
    <li>Die Wahl schließen, sobald alle gewählt haben. Die Stimmen werden versiegelt und ausgezählt; das Ergebnis mit Herleitung erscheint.</li>
    <li>Braucht ein Wahlgang ein Los, zieht es die Wahlkommission; die Wahlleitung trägt die Reihenfolge mit Begründung ein.</li>
    <li>Braucht ein Wahlgang eine Stichwahl: die Stichwahl-Stimmkarten ausgeben, die Stichwahl aktivieren, wählen lassen, schließen. Die Stimmkarten der ersten Runde gelten nicht mehr.</li>
    <li>Die Wahl abschließen, mit Begründung. Danach ändert sich nichts mehr.</li>
    <li>Den Export herunterladen und der Wahlkommission übergeben; die Prüfsumme steht im Protokoll.</li>
  </ol>

  <h2>Zwischenfälle</h2>
  <dl>
    <dt>Stimmkarten sind verloren gegangen oder unbrauchbar</dt>
    <dd>Vor dem Öffnen: unter „Stimmkarten“ den Stapel der Klasse ersetzen; die alten Codes gelten nicht mehr, die neuen werden gedruckt. Nach dem Öffnen gibt es für die erste Runde keine neuen Stimmkarten mehr.</dd>
    <dt>Eine Klasse braucht mehr Stimmkarten</dt>
    <dd>Vor dem Öffnen weitere erzeugen: ein zweiter Stapel für dieselbe Klasse, der eigene Seiten druckt; die bisherigen bleiben gültig.</dd>
    <dt>Die Wahl wurde zu früh geschlossen</dt>
    <dd>Eine geschlossene Runde öffnet nicht wieder. Die Wahl mit einer Begründung abschließen, die das festhält, und eine neue Wahl anlegen.</dd>
    <dt>Jemand hat eine Stimmkarte fotografiert</dt>
    <dd>Eine Stimmkarte wählt einmal je Wahlgang. Wer sie zuerst verwendet, wählt; danach ist sie verbraucht. Vor dem Öffnen den Stapel ersetzen, wenn der Vorfall bekannt wird.</dd>
    <dt>Das Handy zeigt „Die Wahl hat noch nicht begonnen“</dt>
    <dd>Die Wahl ist noch nicht geöffnet, oder die Stichwahl noch nicht aktiviert. Die Stimmkarten der ersten Runde gelten in der Stichwahl nicht.</dd>
  </dl>

  <h2>Was Zeug:innen sehen</h2>
  <p>
    Dieselben Seiten ohne die Knöpfe: die Einrichtung, die Mitglieder, die Anzahl der Stimmkarten, die Beteiligung, nach dem Schließen das Ergebnis mit seiner Herleitung und die verwendeten Codes, und jederzeit das Protokoll. Vor dem Schließen einer Runde sieht niemand ein Ergebnis.
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
