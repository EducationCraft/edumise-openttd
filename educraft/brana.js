(function () {
  'use strict';

  var AUTH_BASE = 'https://api.educraft.cz';
  var LOGIN = 'https://login.educraft.cz/';
  // Zatim jen pro ucitele; zaci (QR) prijdou pozdeji.
  var POVOLENE_SKUPINY = ['TEACHER', 'ASSISTANT', 'ADMIN', 'superadmin'];
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
    titulekEl.textContent = 'Nejste přihlášeni';
    zpravaEl.textContent = 'Hra je zatím jen pro učitele. Přihlaste se svým učitelským účtem.';
    if (duvod) { chybaEl.textContent = duvod; chybaEl.hidden = false; }
    odkazEl.hidden = false;
  }

  // Jen cteni claimu pro rozhodnuti brany, podpis overuje API (viz ponytail vyse).
  function skupiny(idToken) {
    try {
      var cast = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(escape(atob(cast)));
      return JSON.parse(json)['cognito:groups'] || [];
    } catch (e) {
      return [];
    }
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
    var data = await odpoved.json().catch(function () { return {}; });
    var ucitel = skupiny(data.idToken || '').some(function (g) {
      return POVOLENE_SKUPINY.indexOf(g) !== -1;
    });
    if (!ucitel) {
      odmitni('Tento účet nemá učitelský přístup.');
      odkazEl.textContent = 'Přihlásit se jiným účtem';
      return;
    }
    spust();
  })();

  // Login portal po prihlaseni vrati na ?redirect= (povoleno *.educraft.cz).
  odkazEl.href = LOGIN + '?redirect=' + encodeURIComponent(location.origin + '/');
})();
