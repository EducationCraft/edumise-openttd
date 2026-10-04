(function () {
  'use strict';

  var AUTH_BASE = 'https://api.educraft.cz';
  var WALLET = AUTH_BASE + '/wallet';
  var LOGIN = 'https://login.educraft.cz/';
  var UCITELSKE_SKUPINY = ['teacher', 'assistant', 'admin', 'superadmin'];
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
  var jeSuperadmin = false;

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
    zastavPrubeh();
    document.body.classList.add('hraje');
    hraEl.src = HRA + (hash || '');
  }

  // Spolecna hra: ramecek se pripoji na listek z hashe, dalsi listky dostava zpravou.
  // Jmeno hrace z listku (contract §3.2), jinak vychozi; prazdne jmeno hra odmitne.
  function hrajSListkem(ziskejListek, prvni, jmeno) {
    spust('#w=' + encodeURIComponent(prvni.url) + '&n=' + encodeURIComponent(prvni.playerName || jmeno));
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

  // Wallet hlasi running uz po hello serveru, load balancer ho ale zaradi az o ~10–20 s pozdeji (do te doby 503).
  // Sonda bez listku: otevreni = server je za balancerem (gateway pak zavre jako unauthorized); listek se nespotrebuje.
  // ponytail: max 60 s, pak se hra pusti stejne (horsi pripad = stara hlaska o timeoutu).
  async function serverOdpovida(url) {
    var konec = Date.now() + 60 * 1000;
    while (Date.now() < konec) {
      var ok = await new Promise(function (hotovo) {
        var ws;
        try { ws = new WebSocket(url.split('?')[0], 'binary'); } catch (e) { hotovo(true); return; }
        ws.onopen = function () { ws.close(); hotovo(true); };
        ws.onerror = function () { hotovo(false); };
      });
      if (ok) return;
      await new Promise(function (dal) { setTimeout(dal, 3000); });
    }
  }

  // Spolecny vstup: listek → hra; chyby cesky.
  // Zak ceka na ucitele: kazdych 10 s znovu, pripoji se sam, jakmile hodina bezi.
  function cekejNaHodinu(znovu) {
    zastavPrubeh();
    oznam('Hodina Dopravy teď neběží.', znovu ? 'Počkej, až ji učitel spustí – připojím tě sám.' : 'Počkej, až ji učitel spustí.');
    if (znovu) setTimeout(znovu, 10 * 1000);
  }

  async function vstup(ziskejListek, jmeno, znovu) {
    var r;
    try {
      r = await ziskejListek();
    } catch (e) {
      oznam('Chyba spojení', 'Nepodařilo se spojit se serverem.');
      return;
    }
    if (r.status === 200) {
      if (!prubehEl) oznam('Připojuji…', 'Čekám, až server odpoví.');
      await serverOdpovida(r.data.url);
      hrajSListkem(ziskejListek, r.data, jmeno);
      return;
    }
    if (r.error === 'no_session') { cekejNaHodinu(znovu); return; }
    if (r.error === 'wallet_not_found') { oznam('Nejsi v pilotu Dopravy.', 'Požádej učitele o přiřazení do hry.'); return; }
    if (r.status === 403) { oznam('Do této třídy nemáte přístup.', 'Vyberte jinou třídu.'); return; }
    if (r.status === 404) { oznam('Třída nebo žák nenalezen.', 'Hodina možná právě skončila.'); return; }
    oznam('Hru teď nejde spustit.', 'Zkus to prosím za chvíli znovu.');
  }

  function zakVeTride(classId) {
    return vstup(function () { return penezenka('POST', '/me/game-ticket', { classId: classId }); }, 'Hráč',
      function () { zakVeTride(classId); });
  }

  // D19: zak hraje jen ve sve tride, ostatni bezici tridy skoly sleduje.
  async function zak(tiche) {
    if (!tiche) oznam('Moment…', 'Hledám hodiny Dopravy.');
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
    if (!hodiny.length) { cekejNaHodinu(function () { zak(true); }); return; }
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
    }, studentId ? 'Hráč' : 'Starosta');
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

  var BEZI = ['running', 'limit'];
  var CEKANI_MS = 5 * 1000;
  var CEKANI_MAX_MS = 4 * 60 * 1000;

  function chyba(text) {
    chybaEl.textContent = text;
    chybaEl.hidden = !text;
  }

  // Odhad startu serveru tridy (zmereno 2026-10-04, 2.A + 6 startu z ECS udalosti): bezny start ze savu
  // 45–60 s (task 19–37 s + ALB health), po resetu 160 s (archiv 22 s, restart tasku 80 s, nova mapa 30 s).
  // Bezny start ~START_MS, po resetu se navic
  // archivuje stary svet, task se restartuje (ALB draining 30 s + ECS) a generuje nova mapa ~RESET_MS.
  // ponytail: pevne konstanty; az bude vic startu, pocitat median z walletu.
  var START_MS = 55 * 1000;
  var RESET_MS = 165 * 1000;
  var prubehEl = null;

  // Ukazatel podle casu: do odhadu linearne k 90 %, pak jen pomalu k 99 % (nikdy neskonci driv nez server).
  function ukazPrubeh(odhadMs) {
    zastavPrubeh();
    var start = Date.now();
    var box = document.createElement('div');
    box.className = 'prubeh';
    var bar = document.createElement('progress');
    bar.max = 100;
    var text = document.createElement('small');
    box.appendChild(bar);
    box.appendChild(text);
    tridyEl.replaceChildren(box);
    tridyEl.hidden = false;
    var tik = function () {
      var t = Date.now() - start;
      bar.value = t < odhadMs ? 90 * t / odhadMs : 90 + 9 * (1 - Math.exp(-(t - odhadMs) / odhadMs));
      text.textContent = Math.round(t / 1000) + ' s z obvyklých ~' + Math.round(odhadMs / 1000) + ' s';
    };
    tik();
    prubehEl = { box: box, timer: setInterval(tik, 500) };
  }

  function zastavPrubeh() {
    if (!prubehEl) return;
    clearInterval(prubehEl.timer);
    prubehEl.box.remove();
    prubehEl = null;
  }

  // Spusteni hry tridy (contract §3.3: POST …/session {action:"start"}), pak cekani na running.
  async function spustTridu(h) {
    chyba('');
    oznam('Spouštím server třídy…', h.resetPending ? 'Vytváří se nový svět, chvíli to potrvá.' : 'Načítá se uložený svět.');
    ukazPrubeh(h.resetPending ? RESET_MS : START_MS);
    var cesta = '/classes/' + encodeURIComponent(h.classId);
    try {
      var r = await penezenka('POST', cesta + '/session', { schoolId: h.schoolId, requestId: crypto.randomUUID(), action: 'start' });
      // invalid_state = uz se spousti (nekdo jiny klikl), staci cekat.
      if (r.status !== 200 && r.error !== 'invalid_state') {
        var duvod = r.error === 'game_server_not_provisioned' ? 'Server této třídy ještě není připravený.'
          : r.status === 403 ? 'Hru této třídy nemůžete spustit.' : 'Hru se nepodařilo spustit.';
        throw { duvod: duvod };
      }
      var konec = Date.now() + CEKANI_MAX_MS;
      for (;;) {
        await new Promise(function (ok) { setTimeout(ok, CEKANI_MS); });
        var s = await penezenka('GET', cesta + '?schoolId=' + encodeURIComponent(h.schoolId));
        var stav = s.status === 200 ? s.data.session : null;
        if (BEZI.indexOf(stav) !== -1) { tridniListek(h.schoolId, h.classId, null); return; }
        if (stav === 'stopped') throw { duvod: 'Server se nepodařilo spustit.' };
        if (Date.now() > konec) throw { duvod: 'Server se nespustil do 4 minut. Zkuste to prosím znovu.' };
      }
    } catch (e) {
      zastavPrubeh();
      vycisti();
      oznam('Hru teď nejde spustit.', 'Zkuste to prosím za chvíli znovu.');
      chyba((e && e.duvod) || 'Nepodařilo se spojit se serverem.');
      tridyEl.hidden = false;
      tridyEl.appendChild(tlacitko('Zpět', function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); }));
    }
  }

  // Konec hodiny (contract §3.3: POST …/session {action:"stop"}): server ulozi svet a vypne se.
  function ukonciTridu(h) {
    var zpet = function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); };
    oznam('Ukončit hru – ' + h.className + '?', 'Svět se uloží a server se vypne. Připojení žáci budou odpojeni.');
    vycisti();
    tridyEl.appendChild(tlacitko('Ano, ukončit hru', async function () {
      vycisti();
      var r = await penezenka('POST', '/classes/' + encodeURIComponent(h.classId) + '/session',
        { schoolId: h.schoolId, requestId: crypto.randomUUID(), action: 'stop' }).catch(function () { return { status: 0 }; });
      // invalid_state = uz se ukoncuje nebo nebezi.
      if (r.status === 200 || r.error === 'invalid_state') oznam('Hra se ukončuje.', 'Svět se ukládá, server se za chvíli vypne.');
      else chyba(r.status === 403 ? 'Hru této třídy nemůžete ukončit.' : 'Hru se nepodařilo ukončit.');
      tridyEl.appendChild(tlacitko('Zpět', zpet));
    }));
    tridyEl.appendChild(tlacitko('Zpět', zpet));
  }

  // Reset sveta (POST …/reset): jen zastavena trida. Dva kroky; druhy chce opsat nazev tridy.
  function resetujSvet(h) {
    var zpet = function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); };
    oznam('Resetovat svět – ' + h.className + '?', 'Starý svět se archivuje, firmy zmizí, žákům se vrátí vložené diamanty, '
      + 'týmy zůstanou. Nový svět se vytvoří při příštím spuštění.');
    vycisti();
    tridyEl.appendChild(tlacitko('Pokračovat', function () {
      oznam('Resetovat svět – ' + h.className, 'Pro potvrzení napište název třídy: ' + h.className);
      vycisti();
      var pole = document.createElement('input');
      pole.type = 'text';
      pole.placeholder = 'Název třídy';
      var potvrd = tlacitko('Resetovat svět', async function () {
        if (potvrd.disabled) return;
        vycisti();
        var r = await penezenka('POST', '/classes/' + encodeURIComponent(h.classId) + '/reset',
          { schoolId: h.schoolId, requestId: crypto.randomUUID() }).catch(function () { return { status: 0 }; });
        if (r.status === 200) oznam('Svět je resetován.', 'Nový svět se vytvoří při příštím spuštění hry.');
        else chyba(r.status === 403 ? 'Svět této třídy nemůžete resetovat.'
          : r.error === 'invalid_state' ? 'Nejdřív ukončete hru.' : 'Svět se nepodařilo resetovat.');
        tridyEl.appendChild(tlacitko('Zpět', zpet));
      });
      potvrd.disabled = true;
      pole.addEventListener('input', function () { potvrd.disabled = pole.value.trim() !== h.className; });
      tridyEl.appendChild(pole);
      tridyEl.appendChild(potvrd);
      tridyEl.appendChild(tlacitko('Zpět', zpet));
    }));
    tridyEl.appendChild(tlacitko('Zpět', zpet));
  }

  function nazevSkoly(s) {
    return s.name || 'Škola ' + s.schoolId.slice(0, 8);
  }

  // Tridy skoly z GET /classes; jen zapsane (gameKey). zpet = funkce zpet na vyber skol, nebo null.
  async function skola(schoolId, zpet, nazev) {
    oznam(nazev || 'Doprava', 'Hraj sám, nebo se připoj ke hře třídy.');
    vycisti();
    if (zpet) tridyEl.appendChild(tlacitko('Zpět na školy', zpet));
    tridyEl.appendChild(tlacitko('Hrát samostatně', function () { spust(); }));
    var r = await penezenka('GET', '/classes?schoolId=' + encodeURIComponent(schoolId)).catch(function () { return { status: 0 }; });
    if (r.status !== 200) { tridyEl.appendChild(popisek('Třídy se nepodařilo načíst.')); return; }
    var tridy = (r.data.classes || []).filter(function (t) { return t.gameKey; });
    if (!tridy.length) { tridyEl.appendChild(popisek('Žádná třída školy není zapsaná do Dopravy.')); return; }
    tridy.forEach(function (t) {
      var h = { schoolId: schoolId, classId: t.classId, className: t.className || 'Třída', zpet: zpet, skola: nazev, resetPending: !!t.resetPending };
      if (BEZI.indexOf(t.session) !== -1) {
        var role = t.canMayor ? 'Vstoupit jako starosta – ' : 'Sledovat – ';
        tridyEl.appendChild(tlacitko(role + h.className, function () { tridniListek(schoolId, t.classId, null); }));
        if (jeSuperadmin) tridyEl.appendChild(tlacitko('Hrát za žáka – ' + h.className, function () { vyberZaka(h); }));
        if (t.canManage) tridyEl.appendChild(tlacitko('Ukončit hru – ' + h.className, function () { ukonciTridu(h); }));
      } else if (t.session === 'starting' || t.session === 'stopping') {
        tridyEl.appendChild(popisek(h.className + (t.session === 'starting' ? ' – hra se spouští' : ' – hra se ukončuje')));
      } else if (t.canManage) {
        tridyEl.appendChild(tlacitko('Spustit hru – ' + h.className, function () { spustTridu(h); }));
        if (t.resetPending) tridyEl.appendChild(popisek(h.className + ' – nový svět čeká na spuštění'));
        else tridyEl.appendChild(tlacitko('Resetovat svět – ' + h.className, function () { resetujSvet(h); }));
      } else {
        tridyEl.appendChild(popisek(h.className + (t.resetPending ? ' – nový svět čeká na spuštění' : ' – hra neběží')));
      }
    });
  }

  async function ucitel(superadmin) {
    jeSuperadmin = superadmin;
    var odkaz = odkazZHashe();
    if (odkaz.s && odkaz.c) { tridniListek(odkaz.s, odkaz.c, odkaz.sid); return; }
    oznam('Moment…', 'Načítám školy.');
    // Skoly zna penezenka z identity (claim schools:<id> casto nese ICO, ne UUID skoly);
    // superadmin dostane i skoly z registru penezenky.
    var r = await penezenka('GET', '/my-schools').catch(function () { return { status: 0 }; });
    var skoly = r.status === 200 ? (r.data.schools || []) : [];
    if (skoly.length === 1) { skola(skoly[0].schoolId, null, nazevSkoly(skoly[0])); return; }
    if (!skoly.length) {
      oznam('Doprava', 'Hraj sám.');
      vycisti();
      tridyEl.appendChild(tlacitko('Hrát samostatně', function () { spust(); }));
      tridyEl.appendChild(popisek(r.status === 200 ? 'Nejste učitelem žádné školy v Dopravě.' : 'Školy se nepodařilo načíst.'));
      return;
    }
    skoly.sort(function (a, b) { return nazevSkoly(a).localeCompare(nazevSkoly(b), 'cs'); });
    (function vyber() {
      oznam('Doprava', 'Vyber školu.');
      vycisti();
      skoly.forEach(function (s) {
        tridyEl.appendChild(tlacitko(nazevSkoly(s), function () { skola(s.schoolId, vyber, nazevSkoly(s)); }));
      });
    })();
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
    // Skupiny bez ohledu na velikost pismen, stejne jako penezenka (contract §1.2).
    var skupiny = (c['cognito:groups'] || []).map(function (g) { return String(g).toLowerCase(); });
    if (skupiny.some(function (g) { return UCITELSKE_SKUPINY.indexOf(g) !== -1; })) { ucitel(skupiny.indexOf('superadmin') !== -1); return; }
    odmitni('Tento účet nemá do hry přístup.');
    odkazEl.textContent = 'Přihlásit se jiným účtem';
  })();

  // Login portal po prihlaseni vrati na ?redirect= (povoleno *.educraft.cz).
  odkazEl.href = LOGIN + '?redirect=' + encodeURIComponent(location.origin + '/');
})();
