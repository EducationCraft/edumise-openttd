(function () {
  'use strict';

  var AUTH_BASE = 'https://api.educraft.cz';
  var WALLET = AUTH_BASE + '/wallet';
  var LOGIN = 'https://login.educraft.cz/';
  var UCITELSKE_SKUPINY = ['TEACHER', 'ASSISTANT', 'ADMIN', 'superadmin'];
  var HRA = 'openttd.html';
  // Listek je jednorazovy a plati 120 s; ramecek dostane cerstvy pred kazdym pripojenim.
  var OBNOVA_LISTKU_MS = 90 * 1000;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var titulekEl = document.getElementById('titulek');
  var zpravaEl  = document.getElementById('zprava');
  var chybaEl   = document.getElementById('chyba');
  var odkazEl   = document.getElementById('odkaz');
  var tridyEl   = document.getElementById('tridy');
  var hraEl     = document.getElementById('hra');

  var idToken = null;

  // ponytail: brana je jen na strane klienta. Samotna hra pro jednoho hrace je verejny GPL
  // software bez dat zaka. Tridni server pusti jen s listkem z penezenky (overuje ho gateway,
  // contract §6.3), takze zamek pro spolecnou hru je na serveru, ne tady.
  function odmitni(duvod) {
    titulekEl.textContent = 'Nejste přihlášeni';
    zpravaEl.textContent = 'Přihlaste se svým účtem EduCraft.';
    if (duvod) { chybaEl.textContent = duvod; chybaEl.hidden = false; }
    odkazEl.hidden = false;
  }

  function oznam(titulek, zprava) {
    titulekEl.textContent = titulek;
    zpravaEl.textContent = zprava;
  }

  // Jen cteni claimu pro rozhodnuti brany, podpis overuje API.
  function claimy(token) {
    try {
      var cast = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(cast))));
    } catch (e) {
      return {};
    }
  }

  async function obnovToken() {
    var odpoved = await fetch(AUTH_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}'
    });
    if (!odpoved.ok) throw new Error('refresh ' + odpoved.status);
    var data = await odpoved.json();
    idToken = data.idToken || null;
    return idToken;
  }

  // Token v pameti; obnovit 10 minut pred expiraci (jako ensureFreshToken v ostatnich appkach).
  async function token() {
    var exp = idToken ? claimy(idToken).exp : 0;
    if (!idToken || !exp || exp * 1000 - Date.now() < 10 * 60 * 1000) await obnovToken();
    return idToken;
  }

  async function penezenka(metoda, cesta, telo) {
    var odpoved = await fetch(WALLET + cesta, {
      method: metoda,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) },
      body: telo === undefined ? undefined : JSON.stringify(telo)
    });
    var json = await odpoved.json().catch(function () { return {}; });
    return { status: odpoved.status, data: json.data, error: json.error };
  }

  function spust(hash) {
    document.body.classList.add('hraje');
    hraEl.src = HRA + (hash || '');
  }

  // Spolecna hra: ramecek se pripoji na listek z hashe, dalsi listky dostava zpravou.
  function hrajSListkem(ziskejListek, prvni) {
    spust('#w=' + encodeURIComponent(prvni.url));
    setInterval(async function () {
      try {
        var r = await ziskejListek();
        if (r.status === 200 && hraEl.contentWindow) {
          hraEl.contentWindow.postMessage({ t: 'edumise-ticket', url: r.data.url }, location.origin);
        }
      } catch (e) { /* dalsi pokus za 90 s */ }
    }, OBNOVA_LISTKU_MS);
  }

  async function zak() {
    oznam('Moment…', 'Připojuji se ke hře třídy.');
    var listek = function () { return penezenka('POST', '/me/game-ticket', {}); };
    var r;
    try {
      r = await listek();
    } catch (e) {
      oznam('Chyba spojení', 'Nepodařilo se spojit se serverem.');
      return;
    }
    if (r.status === 200) { hrajSListkem(listek, r.data); return; }
    if (r.error === 'no_session') { oznam('Hodina Dopravy teď neběží.', 'Počkej, až ji učitel spustí.'); return; }
    if (r.error === 'wallet_not_found') { oznam('Nejsi v pilotu Dopravy.', 'Požádej učitele o přiřazení do hry.'); return; }
    oznam('Hru teď nejde spustit.', 'Zkus to prosím za chvíli znovu.');
  }

  function tlacitko(text, akce) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tlacitko';
    b.textContent = text;
    b.addEventListener('click', akce);
    return b;
  }

  async function ucitel(tokenClaims) {
    oznam('Doprava', 'Hraj sám, nebo sleduj hru své třídy.');
    tridyEl.hidden = false;
    tridyEl.appendChild(tlacitko('Hrát samostatně', function () { spust(); }));
    // ponytail: skolu bereme z claimu schools:<id>; dnes tam byva i ICO, ktere penezenka
    // neprijme — takove skoly se preskoci. Az identity vrati UUID, zobrazi se samy.
    var skoly = Object.keys(tokenClaims)
      .filter(function (k) { return k.indexOf('schools:') === 0; })
      .map(function (k) { return k.slice(8); })
      .filter(function (id) { return UUID.test(id); });
    for (var i = 0; i < skoly.length; i++) {
      var schoolId = skoly[i];
      var r;
      try {
        r = await penezenka('GET', '/classes?schoolId=' + encodeURIComponent(schoolId));
      } catch (e) {
        continue;
      }
      if (r.status !== 200) continue;
      r.data.classes
        .filter(function (c) { return c.canManage && (c.session === 'running' || c.session === 'limit'); })
        .forEach(function (c) {
          var sid = schoolId;
          var listek = function () {
            return penezenka('POST', '/classes/' + encodeURIComponent(c.classId) + '/game-ticket', { schoolId: sid });
          };
          tridyEl.appendChild(tlacitko('Sledovat třídu ' + c.className, async function () {
            var t = await listek().catch(function () { return { status: 0 }; });
            if (t.status === 200) hrajSListkem(listek, t.data);
            else oznam('Třídu teď nejde sledovat.', 'Hodina možná právě skončila.');
          }));
        });
    }
  }

  (async function start() {
    try {
      await obnovToken();
    } catch (e) {
      odmitni(null);
      return;
    }
    var c = claimy(idToken || '');
    if (c['custom:student_id']) { zak(); return; }
    var skupiny = c['cognito:groups'] || [];
    if (skupiny.some(function (g) { return UCITELSKE_SKUPINY.indexOf(g) !== -1; })) { ucitel(c); return; }
    odmitni('Tento účet nemá do hry přístup.');
    odkazEl.textContent = 'Přihlásit se jiným účtem';
  })();

  // Login portal po prihlaseni vrati na ?redirect= (povoleno *.educraft.cz).
  odkazEl.href = LOGIN + '?redirect=' + encodeURIComponent(location.origin + '/');
})();
