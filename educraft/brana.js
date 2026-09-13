(function () {
  'use strict';

  var AUTH_BASE = 'https://api.educraft.cz';
  var HUB = 'https://student.educraft.cz';
  var HRA = 'openttd.html';

  var titulekEl = document.getElementById('titulek');
  var zpravaEl  = document.getElementById('zprava');
  var chybaEl   = document.getElementById('chyba');
  var odkazEl   = document.getElementById('odkaz');
  var hraEl     = document.getElementById('hra');

  // ponytail: brana je jen na strane klienta. Hra je verejny GPL software bez dat zaka,
  // takze tady nic tajneho nestrezime — chrani to pred zabloudenim, ne pred odhodlanym
  // zakem. Skutecny zamek by znamenal Lambda@Edge, a cookie `educraft_session` ma
  // Path=/auth, takze by ji CloudFront na teto domene stejne nevidel.
  function odmitni(duvod) {
    titulekEl.textContent = 'Nejsi přihlášený';
    zpravaEl.textContent = 'Naskenuj svůj QR kód a zkus to znovu.';
    if (duvod) { chybaEl.textContent = duvod; chybaEl.hidden = false; }
    odkazEl.hidden = false;
  }

  function spust() {
    document.body.classList.add('hraje');
    hraEl.src = HRA;
  }

  (async function start() {
    var odpoved;
    try {
      odpoved = await fetch(AUTH_BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}'
      });
    } catch (e) {
      odmitni('Nepodařilo se spojit se serverem.');
      return;
    }
    if (!odpoved.ok) { odmitni(null); return; }
    spust();
  })();

  // Odkaz na hub si nese navrat, aby zak po prihlaseni skoncil zpatky ve hre.
  odkazEl.href = HUB;
})();
