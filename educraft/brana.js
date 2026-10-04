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

  // Deep link #s=<schoolId>&c=<classId>[&as=pupil&sid=<studentId>] (contract §6.4); jen UUID.
  function odkazZHashe() {
    var q = {};
    (location.hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) {
        try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* vadne kodovani = jako bez parametru */ }
      }
    });
    var uuid = function (v) { return UUID.test(v || '') ? v : null; };
    return { s: uuid(q.s), c: uuid(q.c), sid: q.as === 'pupil' ? uuid(q.sid) : null };
  }

  function vycisti() {
    tridyEl.replaceChildren();
    tridyEl.hidden = false;
  }

  function popisek(text) {
    var p = document.createElement('p');
    p.textContent = text;
    return p;
  }

  // Spolecny vstup: listek → hra; chyby cesky.
  async function vstup(ziskejListek) {
    var r;
    try {
      r = await ziskejListek();
    } catch (e) {
      oznam('Chyba spojení', 'Nepodařilo se spojit se serverem.');
      return;
    }
    if (r.status === 200) { hrajSListkem(ziskejListek, r.data); return; }
    if (r.error === 'no_session') { oznam('Hodina Dopravy teď neběží.', 'Počkej, až ji učitel spustí.'); return; }
    if (r.error === 'wallet_not_found') { oznam('Nejsi v pilotu Dopravy.', 'Požádej učitele o přiřazení do hry.'); return; }
    if (r.status === 403) { oznam('Do této třídy nemáte přístup.', 'Vyberte jinou třídu.'); return; }
    if (r.status === 404) { oznam('Třída nebo žák nenalezen.', 'Hodina možná právě skončila.'); return; }
    oznam('Hru teď nejde spustit.', 'Zkus to prosím za chvíli znovu.');
  }

  function zakVeTride(classId) {
    return vstup(function () { return penezenka('POST', '/me/game-ticket', { classId: classId }); });
  }

  // D19: zak hraje jen ve sve tride, ostatni bezici tridy skoly sleduje.
  async function zak() {
    oznam('Moment…', 'Hledám hodiny Dopravy.');
    var odkaz = odkazZHashe();
    if (odkaz.c) { zakVeTride(odkaz.c); return; }
    var r;
    try {
      r = await penezenka('GET', '/me/sessions');
    } catch (e) {
      oznam('Chyba spojení', 'Nepodařilo se spojit se serverem.');
      return;
    }
    var hodiny = (r.status === 200 && r.data.sessions) || [];
    if (!hodiny.length) { oznam('Hodina Dopravy teď neběží.', 'Počkej, až ji učitel spustí.'); return; }
    if (hodiny.length === 1 && hodiny[0].own) { zakVeTride(hodiny[0].classId); return; }
    oznam('Doprava', 'Vyber hodinu.');
    vycisti();
    hodiny.forEach(function (h) {
      tridyEl.appendChild(tlacitko((h.own ? 'Hrát – ' : 'Dívat se – ') + h.className, function () { zakVeTride(h.classId); }));
    });
  }

  function tlacitko(text, akce) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tlacitko';
    b.textContent = text;
    b.addEventListener('click', akce);
    return b;
  }

  function tridniListek(schoolId, classId, studentId) {
    var telo = studentId ? { schoolId: schoolId, as: 'pupil', studentId: studentId } : { schoolId: schoolId };
    return vstup(function () {
      return penezenka('POST', '/classes/' + encodeURIComponent(classId) + '/game-ticket', telo);
    });
  }

  // Superadmin: konkretni zapsany zak tridy (D22); vstoupi presne jako on.
  async function vyberZaka(h) {
    var r = await penezenka('GET', '/classes/' + encodeURIComponent(h.classId) + '?schoolId=' + encodeURIComponent(h.schoolId))
      .catch(function () { return { status: 0 }; });
    var zaci = (r.status === 200 && r.data.pupils) || [];
    oznam('Hrát za žáka – ' + h.className, zaci.length ? 'Vyber žáka.' : 'Ve třídě není žádný zapsaný žák.');
    vycisti();
    zaci.forEach(function (z) {
      tridyEl.appendChild(tlacitko(z.name, function () { tridniListek(h.schoolId, h.classId, z.studentId); }));
    });
  }

  function vypisTridy(hodiny) {
    hodiny.forEach(function (h) {
      var role = h.role === 'mayor' ? 'Vstoupit jako starosta – ' : 'Sledovat – ';
      tridyEl.appendChild(tlacitko(role + h.className, function () { tridniListek(h.schoolId, h.classId, null); }));
      if (h.canPlayAsPupil) tridyEl.appendChild(tlacitko('Hrát za žáka – ' + h.className, function () { vyberZaka(h); }));
    });
  }

  async function ucitel(tokenClaims, superadmin) {
    var odkaz = odkazZHashe();
    if (odkaz.s && odkaz.c) { tridniListek(odkaz.s, odkaz.c, odkaz.sid); return; }
    oznam('Doprava', 'Hraj sám, nebo se připoj ke hře třídy.');
    vycisti();
    tridyEl.appendChild(tlacitko('Hrát samostatně', function () { spust(); }));
    // ponytail: skolu bereme z claimu schools:<id>; dnes tam byva i ICO, ktere penezenka
    // neprijme — takove skoly se preskoci. Az identity vrati UUID, zobrazi se samy.
    var dotazy = superadmin ? ['/sessions'] : Object.keys(tokenClaims)
      .filter(function (k) { return k.indexOf('schools:') === 0 && UUID.test(k.slice(8)); })
      .map(function (k) { return '/sessions?schoolId=' + encodeURIComponent(k.slice(8)); });
    var hodiny = [];
    for (var i = 0; i < dotazy.length; i++) {
      var r = await penezenka('GET', dotazy[i]).catch(function () { return { status: 0 }; });
      if (r.status === 200) hodiny = hodiny.concat(r.data.sessions || []);
    }
    if (!hodiny.length) { tridyEl.appendChild(popisek('Žádná třída teď Dopravu nehraje.')); return; }
    var skoly = {};
    hodiny.forEach(function (h) { (skoly[h.schoolId] = skoly[h.schoolId] || []).push(h); });
    var ids = Object.keys(skoly);
    if (!superadmin || ids.length === 1) { vypisTridy(hodiny); return; }
    // D9: superadmin vybira skolu → tridu → roli. Registr skol nema nazvy (spec §10 ot. 3).
    ids.forEach(function (id) {
      var tridy = skoly[id].map(function (h) { return h.className; }).join(', ');
      tridyEl.appendChild(tlacitko('Škola ' + id.slice(0, 8) + ' (' + tridy + ')', function () {
        oznam('Doprava', 'Vyber třídu a roli.');
        vycisti();
        vypisTridy(skoly[id]);
      }));
    });
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
    if (skupiny.some(function (g) { return UCITELSKE_SKUPINY.indexOf(g) !== -1; })) { ucitel(c, skupiny.indexOf('superadmin') !== -1); return; }
    odmitni('Tento účet nemá do hry přístup.');
    odkazEl.textContent = 'Přihlásit se jiným účtem';
  })();

  // Login portal po prihlaseni vrati na ?redirect= (povoleno *.educraft.cz).
  odkazEl.href = LOGIN + '?redirect=' + encodeURIComponent(location.origin + '/');
})();
