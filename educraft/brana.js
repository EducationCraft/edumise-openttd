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
  var BEZI = ['running', 'limit'];

  // Druha mapa (educraft-wallet#1): trida, ktera se nevejde do 15 firem, ma i mapu B; kazda akce tridy
  // (start, stop, prodlouzeni, reset) bezi nad obema. Bez maps[] (starsi penezenka) nebo s jednou mapou
  // se brana chova presne jako driv.
  function mapy(t) { return (t && t.maps) || []; }

  function sMapou(text, mapa, dve) { return dve ? text + ' (mapa ' + mapa + ')' : text; }

  // Stav tridy pro tlacitka: s jednou mapou session; se dvema bezi, kdyz bezi aspon jedna.
  function stavTridy(t) {
    var m = mapy(t);
    if (m.length < 2) return t.session;
    var s = m.map(function (x) { return x.session; });
    return ['limit', 'running', 'starting', 'stopping'].filter(function (x) { return s.indexOf(x) !== -1; })[0] || 'stopped';
  }

  // Po startu: 'bezi' az bezi vsechny mapy, 'chyba' kdyz nektera spadla zpet na stopped, jinak null (cekat).
  function vysledekStartu(stavy) {
    if (stavy.indexOf('stopped') !== -1) return 'chyba';
    return stavy.every(function (s) { return BEZI.indexOf(s) !== -1; }) ? 'bezi' : null;
  }

  // Zak se pripoji sam, kdyz ma prave jednu vlastni hodinu a krome ni bezi nanejvys sesterska mapa jeho tridy
  // (own:false, jen ke sledovani). Jinak vybira.
  function hodinaZaka(hodiny) {
    var moje = hodiny.filter(function (h) { return h.own; });
    if (moje.length !== 1) return null;
    return hodiny.every(function (h) { return h === moje[0] || h.classId === moje[0].classId; }) ? moje[0] : null;
  }

  // Dve mapy jedne tridy se lisi v popisku, aby zak nevidel dve stejna tlacitka.
  function popisHodiny(h, hodiny) {
    var dve = hodiny.some(function (x) { return x !== h && x.classId === h.classId; });
    return sMapou((h.own ? 'Hrát – ' : 'Dívat se – ') + h.className, h.map, dve);
  }

  var POPIS_STAVU = { running: 'běží', limit: 'čeká na pokračování', starting: 'spouští se', stopping: 'ukončuje se' };
  function stavMapy(nazev, m) {
    return nazev + ' – mapa ' + m.map + ': ' + (POPIS_STAVU[m.session] || 'neběží') + ', žáků ' + m.pupils
      + (m.resetPending ? ', nový svět čeká na spuštění' : '');
  }

  // Chyba akce nad dvema mapami nese mapu, na ktere selhala (wallet {error, map, done}).
  function uMapy(r, text) { return r.info && r.info.map ? 'Mapa ' + r.info.map + ': ' + text : text; }

  var CHYBY_PRESUNU = {
    pupil_has_company: 'Žák je v týmu, který už má firmu – přesunout ho nejde.',
    pupil_has_deposits: 'Žák vložil diamanty do firmy na této mapě – přesunout ho nejde.',
    game_resetting: 'Svět se právě resetuje, zkuste to za chvíli.',
    game_closed: 'Hra je uzavřená.',
    invalid_state: 'Hra se právě vyúčtovává.',
    map_not_found: 'Druhá mapa neexistuje.',
    wallet_not_found: 'Žák už není ve hře. Otevřete týmy znovu.',
    not_found: 'Žák už není v této třídě. Otevřete týmy znovu.'
  };
  function textPresunu(r) {
    return CHYBY_PRESUNU[r.error] || (r.status === 403 ? 'Žáky této třídy nemůžete přesouvat.' : 'Žáka se nepodařilo přesunout.');
  }

  // Ciste pomocne funkce pro node test (educraft/brana.test.js); v prohlizeci se nic neexportuje.
  if (typeof module === 'object' && module.exports) {
    module.exports = { stavTridy: stavTridy, vysledekStartu: vysledekStartu, hodinaZaka: hodinaZaka, popisHodiny: popisHodiny,
      stavMapy: stavMapy, textPresunu: textPresunu, uMapy: uMapy };
    return;
  }

  var titulekEl = document.getElementById('titulek');
  var zpravaEl  = document.getElementById('zprava');
  var chybaEl   = document.getElementById('chyba');
  var odkazEl   = document.getElementById('odkaz');
  var tridyEl   = document.getElementById('tridy');
  var hraEl     = document.getElementById('hra');

  var idToken = null;
  var jeSuperadmin = false;
  var jeZak = false;
  var hraZaka = false; // hraje za svou firmu (role pupil), ne jako divak cizi tridy

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
    return { status: odpoved.status, data: json.data, error: json.error, info: json };
  }

  function spust(hash) {
    zastavPrubeh();
    zastavOdpocty();
    document.body.classList.add('hraje');
    hraEl.src = HRA + (hash || '');
  }

  // Spolecna hra: ramecek se pripoji na listek z hashe, dalsi listky dostava zpravou.
  // Jmeno hrace z listku (contract §3.2), jinak vychozi; prazdne jmeno hra odmitne.
  function hrajSListkem(ziskejListek, prvni, jmeno) {
    // p=1: hra ukaze okno penezenky (vklad diamantu), jen zakovi ve vlastni tride (divak cizi tridy ne, D19).
    hraZaka = jeZak && prvni.role === 'pupil';
    spust('#w=' + encodeURIComponent(prvni.url) + '&n=' + encodeURIComponent(prvni.playerName || jmeno) + (hraZaka ? '&p=1' : ''));
    setInterval(async function () {
      try {
        var r = await ziskejListek();
        if (r.status === 200 && hraEl.contentWindow) {
          hraEl.contentWindow.postMessage({ t: 'edumise-ticket', url: r.data.url }, location.origin);
        }
      } catch (e) { /* dalsi pokus za 90 s */ }
    }, OBNOVA_LISTKU_MS);
  }

  // Penezenka ve hre (src/edu_wallet_gui.cpp, menu Finance): hra se pta postMessage, token zustava
  // v brane. Odpoved edumise-wallet = stav z GET /me + zprava pro zaka (contract §3.2).
  var CHYBY_PENEZENKY = {
    insufficient_funds: 'Nemáš dost diamantů.',
    no_company: 'Nejdřív si ve hře založ firmu.',
    game_closed: 'Hra je uzavřená.',
    game_resetting: 'Svět se právě resetuje.',
    wallet_not_found: 'Nejsi v pilotu Dopravy.',
    busy: 'Server je vytížený. Zkus to za chvíli.'
  };

  function textChyby(r, vychozi) {
    return CHYBY_PENEZENKY[r.error] || (r.status === 0 ? 'Nepodařilo se spojit se serverem.' : vychozi);
  }

  // zprava: text, nebo funkce (game z GET /me) → text. vklad = odpoved na vklad, jen ta ve hre vklad odemkne.
  async function posliStav(vklad, zprava) {
    var r = await penezenka('GET', '/me').catch(function () { return { status: 0 }; });
    var ok = r.status === 200 && !!r.data;
    if (typeof zprava === 'function') zprava = zprava(ok ? r.data.game : null);
    if (!hraEl.contentWindow) return;
    hraEl.contentWindow.postMessage({
      t: 'edumise-wallet',
      walletTenths: ok ? r.data.walletTenths : -1,
      hasCompany: ok && !!r.data.game && r.data.game.company !== null,
      deposit: vklad,
      message: zprava || (ok ? '' : textChyby(r, 'Peněženku se nepodařilo načíst.'))
    }, location.origin);
  }

  // Jeden requestId na jeden zamer (contract §2.3, jako vytvorZamer v EduMise): po chybe site nebo 5xx
  // zustava, takze opakovani tehoz vkladu ho neprovede dvakrat. Konecna je az odpoved 2xx/4xx.
  var zamerVkladu = null;
  var vkladBezi = false;

  async function vlozDiamanty(desetiny) {
    // Hra drzi vklad zamceny, dokud neprijde odpoved; tohle je pojistka proti druhemu soubeznemu.
    if (vkladBezi) return;
    vkladBezi = true;
    var r = { status: 0 };
    try {
      if (!zamerVkladu || zamerVkladu.amountTenths !== desetiny) zamerVkladu = { requestId: crypto.randomUUID(), amountTenths: desetiny };
      for (var pokus = 0; ; pokus++) {
        r = await penezenka('POST', '/me/deposits', zamerVkladu).catch(function () { return { status: 0 }; });
        if ((r.status !== 503 && r.status !== 0) || pokus >= 3) break;
        await new Promise(function (dal) { setTimeout(dal, 1000 + Math.random() * 2000); });
      }
      if (r.status !== 0 && r.status < 500) zamerVkladu = null;
    } finally {
      vkladBezi = false;
    }
    if (r.status !== 200) { await posliStav(true, textChyby(r, 'Vklad se nepodařil. Zkus to znovu.')); return; }
    var kc = (r.data.pounds * 41).toLocaleString('cs-CZ').replace(/\s/g, ' ');
    await posliStav(true, function (hra) {
      var bezi = hra && (hra.session === 'running' || hra.session === 'limit');
      return 'Vklad ' + kc + (bezi ? ' Kč odeslán, ve hře se objeví za chvilku.' : ' Kč čeká na hodinu.');
    });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== hraEl.contentWindow || !hraZaka) return;
    var d = e.data;
    if (d && d.t === 'edumise-wallet-get') posliStav(false, '');
    if (d && d.t === 'edumise-deposit' && Number.isInteger(d.amountTenths) && d.amountTenths > 0) vlozDiamanty(d.amountTenths);
  });

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
    zastavOdpocty();
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

  // gameKey jen pro cizi mapu (sesterska mapa sve tridy nebo jina trida = divak); vlastni mapu vybere penezenka.
  function zakVeTride(classId, gameKey) {
    var telo = gameKey ? { classId: classId, gameKey: gameKey } : { classId: classId };
    return vstup(function () { return penezenka('POST', '/me/game-ticket', telo); }, 'Hráč',
      function () { zakVeTride(classId, gameKey); });
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
    var moje = hodinaZaka(hodiny);
    if (moje) { zakVeTride(moje.classId); return; }
    oznam('Doprava', 'Vyber hodinu.');
    vycisti();
    hodiny.forEach(function (h) {
      tridyEl.appendChild(tlacitko(popisHodiny(h, hodiny), function () { zakVeTride(h.classId, h.own ? null : h.gameKey); }));
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

  // mapa jen u tridy se dvema mapami (starosta/divak na mape B); jako zak vzdy jeho vlastni mapa.
  function tridniListek(schoolId, classId, studentId, mapa) {
    var telo = studentId ? { schoolId: schoolId, as: 'pupil', studentId: studentId } : { schoolId: schoolId };
    if (mapa && !studentId) telo.map = mapa;
    return vstup(function () {
      return penezenka('POST', '/classes/' + encodeURIComponent(classId) + '/game-ticket', telo);
    }, studentId ? 'Hráč' : 'Starosta');
  }

  // Superadmin: konkretni zapsany zak tridy (D22); vstoupi presne jako on.
  async function vyberZaka(h) {
    var zaci = [];
    for (var m of (h.mapy.length ? h.mapy : [null])) {
      var r = await penezenka('GET', '/classes/' + encodeURIComponent(h.classId) + '?schoolId=' + encodeURIComponent(h.schoolId)
        + (m ? '&map=' + m : '')).catch(function () { return { status: 0 }; });
      ((r.status === 200 && r.data.pupils) || []).forEach(function (z) { zaci.push({ name: sMapou(z.name, m, !!m), studentId: z.studentId }); });
    }
    oznam('Hrát za žáka – ' + h.className, zaci.length ? 'Vyber žáka.' : 'Ve třídě není žádný zapsaný žák.');
    vycisti();
    zaci.forEach(function (z) {
      tridyEl.appendChild(tlacitko(z.name, function () { tridniListek(h.schoolId, h.classId, z.studentId); }));
    });
  }

  var CEKANI_MS = 5 * 1000;
  // Nova mapa 4096 x 4096 se generuje nekolik minut (2026-10-17), proto 15 min.
  var CEKANI_MAX_MS = 15 * 60 * 1000;

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
  // 2026-10-17, mapa 4096 x 4096: archiv 30 s + restart tasku ~2 min + generovani < 30 s = ~3 min do prvniho joinu.
  var RESET_MS = 180 * 1000;
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

  // Pred spustenim ucitel vybere, jak dlouho server pobezi (wallet: minutes 15–240, strop 4 h od startu).
  var DELKY = [[45, '45 minut'], [90, '1,5 hodiny'], [120, '2 hodiny'], [180, '3 hodiny'], [240, '4 hodiny']];
  function delkaHry(h) {
    chyba('');
    oznam('Spustit hru – ' + h.className, 'Jak dlouho má server běžet? Pak se sám uloží a vypne.');
    vycisti();
    DELKY.forEach(function (d) {
      tridyEl.appendChild(tlacitko(d[1], function () { spustTridu(h, d[0]); }));
    });
    tridyEl.appendChild(tlacitko('Zpět', function () { skola(h.schoolId, h.zpet, h.skola); }));
  }

  // Spusteni hry tridy (contract §3.3: POST …/session {action:"start"}), pak cekani na running.
  async function spustTridu(h, minuty) {
    chyba('');
    oznam('Spouštím server třídy…', h.resetPending ? 'Vytváří se nový svět, chvíli to potrvá.' : 'Načítá se uložený svět.');
    ukazPrubeh(h.resetPending ? RESET_MS : START_MS);
    var cesta = '/classes/' + encodeURIComponent(h.classId);
    try {
      var r = await penezenka('POST', cesta + '/session', { schoolId: h.schoolId, requestId: crypto.randomUUID(), action: 'start', minutes: minuty });
      // invalid_state = uz se spousti (nekdo jiny klikl), staci cekat.
      if (r.status !== 200 && r.error !== 'invalid_state') {
        var duvod = r.error === 'game_server_not_provisioned' ? 'Server této třídy ještě není připravený.'
          : r.error === 'game_resetting' ? 'Svět se právě resetuje, zkuste to za chvíli.'
          : r.error === 'game_closed' ? 'Hra je uzavřená.'
          : r.status === 403 ? 'Hru této třídy nemůžete spustit.' : 'Hru se nepodařilo spustit.';
        throw { duvod: uMapy(r, duvod) };
      }
      // Se dvema mapami se ceka na oba servery (kazda mapa svym dotazem, ?map=).
      var konec = Date.now() + CEKANI_MAX_MS;
      for (;;) {
        await new Promise(function (ok) { setTimeout(ok, CEKANI_MS); });
        var stavy = [];
        for (var m of (h.mapy.length ? h.mapy : [null])) {
          var s = await penezenka('GET', cesta + '?schoolId=' + encodeURIComponent(h.schoolId) + (m ? '&map=' + m : ''));
          stavy.push(s.status === 200 ? s.data.session : null);
        }
        var vysledek = vysledekStartu(stavy);
        if (vysledek === 'bezi') { tridniListek(h.schoolId, h.classId, null); return; }
        if (vysledek === 'chyba') throw { duvod: 'Server se nepodařilo spustit.' };
        if (Date.now() > konec) throw { duvod: 'Server se nespustil do 15 minut. Zkuste to prosím znovu.' };
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
    oznam('Ukončit hru – ' + h.className + '?', (h.mapy.length ? 'Týká se obou map. ' : '') + 'Svět se uloží a server se vypne. Připojení žáci budou odpojeni.');
    vycisti();
    tridyEl.appendChild(tlacitko('Ano, ukončit hru', async function () {
      vycisti();
      var r = await penezenka('POST', '/classes/' + encodeURIComponent(h.classId) + '/session',
        { schoolId: h.schoolId, requestId: crypto.randomUUID(), action: 'stop' }).catch(function () { return { status: 0 }; });
      // invalid_state = uz se ukoncuje nebo nebezi.
      if (r.status === 200 || r.error === 'invalid_state') oznam('Hra se ukončuje.', 'Svět se ukládá, server se za chvíli vypne.');
      else chyba(uMapy(r, r.status === 403 ? 'Hru této třídy nemůžete ukončit.' : 'Hru se nepodařilo ukončit.'));
      tridyEl.appendChild(tlacitko('Zpět', zpet));
    }));
    tridyEl.appendChild(tlacitko('Zpět', zpet));
  }

  // Server tridy se sam vypne v stopDeadline (2 h od spusteni nebo posledniho prodlouzeni, nejdele 4 h od spusteni; wallet job).
  var odpocty = [];

  function zastavOdpocty() {
    odpocty.forEach(clearInterval);
    odpocty = [];
  }

  function hms(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var dve = function (n) { return ('0' + n).slice(-2); };
    return Math.floor(s / 3600) + ':' + dve(Math.floor(s / 60) % 60) + ':' + dve(s % 60);
  }

  // serverNow = hodiny walletu; skolni PC muze mit hodiny posunute, pocitame zbytek od odpovedi.
  function odpocet(nazev, stopDeadline, serverNow) {
    var konec = Date.now() + Date.parse(stopDeadline) - (Date.parse(serverNow) || Date.now());
    var p = popisek('');
    var tik = function () {
      var zbyva = konec - Date.now();
      p.textContent = nazev + ': ' + (zbyva > 0 ? 'Server se vypne za ' + hms(zbyva) : 'Server se vypíná.');
    };
    tik();
    odpocty.push(setInterval(tik, 1000));
    return p;
  }

  // Prodlouzeni (action extend: vzdy na 2 h od ted) a pokracovani po limitu 18 mesicu (action resume).
  async function akceTridy(h, akce, chyby) {
    chyba('');
    var r = await penezenka('POST', '/classes/' + encodeURIComponent(h.classId) + '/session',
      { schoolId: h.schoolId, requestId: crypto.randomUUID(), action: akce }).catch(function () { return { status: 0 }; });
    await skola(h.schoolId, h.zpet, h.skola);
    if (r.status !== 200) chyba(uMapy(r, r.status === 403 ? chyby.zakaz : r.error === 'invalid_state' ? chyby.stav : chyby.jine));
  }

  // Reset sveta (POST …/reset): jen zastavena trida. Dva kroky; druhy chce opsat nazev tridy.
  function resetujSvet(h) {
    var zpet = function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); };
    oznam('Resetovat svět – ' + h.className + '?', (h.mapy.length ? 'Týká se obou map. ' : '') + 'Starý svět se archivuje, firmy zmizí, žákům se vrátí vložené diamanty, '
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
        else chyba(uMapy(r, r.status === 403 ? 'Svět této třídy nemůžete resetovat.'
          : r.error === 'invalid_state' ? 'Nejdřív ukončete hru.' : 'Svět se nepodařilo resetovat.'));
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

  // Tymy tridy (D20, PUT …/slots nahrazuje cely seznam): kazdy zapsany zak prave jednou, 1–3 na tym,
  // cisla 1–15 (= max_companies). Stejna pravidla jako editor v EduMise (slotyZPrirazeni).
  var MAX_TYMU = 15;
  var MAX_V_TYMU = 3;

  // Tymy patri jedne mape (mapa = 'A'|'B'; bez ni dotaz bez ?map= = mapa A, jako driv).
  async function tymy(h, mapa) {
    var zpet = function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); };
    chyba('');
    oznam('Týmy – ' + h.className, 'Načítám žáky…');
    vycisti();
    var r = await penezenka('GET', '/classes/' + encodeURIComponent(h.classId) + '?schoolId=' + encodeURIComponent(h.schoolId)
      + (mapa ? '&map=' + mapa : '')).catch(function () { return { status: 0 }; });
    if (r.status !== 200) {
      oznam('Týmy – ' + h.className, '');
      chyba(r.status === 403 ? 'Týmy této třídy nemůžete upravit.' : 'Žáky se nepodařilo načíst.');
      tridyEl.appendChild(tlacitko('Zpět', zpet));
      return;
    }
    var d = r.data;
    var vsechny = d.maps || [];
    var dve = vsechny.length > 1;
    var tato = d.map || 'A';
    var jina = tato === 'A' ? 'B' : 'A';
    var nadpis = sMapou('Týmy – ' + h.className, tato, dve);
    // Zaklad jsou slots (obsahuji i zaky mimo ucitelův seznam), pupils jen doplni ty bez tymu.
    var prirazeni = {};
    (d.slots || []).forEach(function (s) { (s.studentIds || []).forEach(function (id) { prirazeni[id] = String(s.slot); }); });
    var zaci = (d.pupils || []).slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'cs'); });
    zaci.forEach(function (z) { if (!(z.studentId in prirazeni)) prirazeni[z.studentId] = ''; });
    var skryti = Object.keys(prirazeni).length - zaci.length;
    var bezTymu = zaci.filter(function (z) { return !prirazeni[z.studentId]; }).length;

    oznam(nadpis, (dve ? 'Mapa A: ' + vsechny[0].pupils + ' žáků, mapa B: ' + vsechny[1].pupils + ' žáků. ' : '') + 'Žáci se stejným číslem týmu (1–' + MAX_TYMU + ') hrají spolu jednu firmu, nejvýš '
      + MAX_V_TYMU + ' v týmu.' + (bezTymu ? ' Bez týmu: ' + bezTymu + ' – ti se můžou jen dívat.' : ''));
    vycisti();
    if (dve) tridyEl.appendChild(tlacitko('Týmy mapy ' + jina, function () { tymy(h, jina); }));
    if (BEZI.indexOf(d.session) !== -1) tridyEl.appendChild(popisek('Hra běží: přesunutý žák se musí znovu připojit. Jeho vklady zůstávají u původní firmy.'));
    if (dve) tridyEl.appendChild(popisek('Tlačítkem „→ ' + jina + '“ přesunete žáka na mapu ' + jina + ' (jen bez firmy a vkladů). Neuložené týmy se tím zahodí.'));
    zaci.forEach(function (z) {
      var radek = document.createElement('label');
      radek.className = 'radek-tymu';
      var jmeno = document.createElement('span');
      jmeno.textContent = z.name || 'Žák';
      var pole = document.createElement('input');
      pole.type = 'number';
      pole.inputMode = 'numeric';
      pole.min = '1';
      pole.max = String(MAX_TYMU);
      pole.placeholder = '–';
      pole.value = prirazeni[z.studentId];
      pole.addEventListener('input', function () { prirazeni[z.studentId] = pole.value.trim(); });
      radek.appendChild(jmeno);
      radek.appendChild(pole);
      if (dve) {
        var presun = tlacitko('→ ' + jina, function (e) { e.preventDefault(); presunZaka(h, tato, jina, z); });
        presun.classList.add('presun');
        presun.title = 'Přesunout na mapu ' + jina;
        radek.appendChild(presun);
      }
      tridyEl.appendChild(radek);
    });
    (d.slots || []).filter(function (s) { return s.company !== null && !(s.studentIds || []).length; }).forEach(function (s) {
      tridyEl.appendChild(popisek('Tým ' + s.slot + ': ' + (s.companyName || 'firma bez jména') + ' (bez členů) – žák s tímto číslem firmu převezme.'));
    });
    if (skryti > 0) tridyEl.appendChild(popisek('Další žáci mimo váš seznam (' + skryti + ') zůstávají ve svých týmech.'));
    var requestId = crypto.randomUUID();
    var uloz = tlacitko('Uložit týmy', async function () {
      chyba('');
      var podleTymu = {};
      for (var id in prirazeni) {
        var n = Number(prirazeni[id]);
        if (!Number.isInteger(n) || n < 1 || n > MAX_TYMU) { chyba('Každý žák musí mít číslo týmu 1 až ' + MAX_TYMU + '.'); return; }
        (podleTymu[n] = podleTymu[n] || []).push(id);
      }
      for (var t in podleTymu) {
        if (podleTymu[t].length > MAX_V_TYMU) { chyba('V týmu ' + t + ' jsou víc než ' + MAX_V_TYMU + ' žáci.'); return; }
      }
      var slots = Object.keys(podleTymu).map(function (t) { return { slot: Number(t), studentIds: podleTymu[t].sort() }; });
      uloz.disabled = true;
      // Jeden requestId na zamer: opakovani po vypadku site se neprovede dvakrat (contract §2.3).
      var telo = { schoolId: h.schoolId, requestId: requestId, slots: slots };
      if (mapa) telo.map = mapa;
      var o = await penezenka('PUT', '/classes/' + encodeURIComponent(h.classId) + '/slots', telo).catch(function () { return { status: 0 }; });
      uloz.disabled = false;
      if (o.status === 200) { await tymy(h, mapa); zpravaEl.textContent = 'Týmy uloženy.'; return; }
      if (o.status !== 0 && o.status < 500) requestId = crypto.randomUUID();
      chyba(o.status === 403 ? 'Týmy této třídy nemůžete upravit.'
        : o.error === 'game_resetting' ? 'Svět se právě resetuje, zkuste to za chvíli.'
        : o.error === 'invalid_state' ? 'Tým, jehož firma už skončila, nejde měnit.'
        : o.status === 400 ? 'Seznam žáků se mezitím změnil. Otevřete týmy znovu.'
        : 'Týmy se nepodařilo uložit.');
    });
    tridyEl.appendChild(uloz);
    // Druha mapa jen pro tridu, ktera se nevejde do 15 firem (wallet jinak 409 class_fits_one_map).
    if (vsechny.length === 1 && vsechny[0].pupils > MAX_TYMU) {
      tridyEl.appendChild(tlacitko('Založit druhou mapu', function () { zalozMapu(h); }));
    }
    tridyEl.appendChild(tlacitko('Zpět', zpet));
  }

  // PUT …/pupils/{id}/map: zak bez firmy a vkladu prejde na druhou mapu bez tymu; tym mu da ucitel tam.
  async function presunZaka(h, tato, jina, z) {
    chyba('');
    var r = await penezenka('PUT', '/classes/' + encodeURIComponent(h.classId) + '/pupils/' + encodeURIComponent(z.studentId) + '/map',
      { schoolId: h.schoolId, requestId: crypto.randomUUID(), map: jina }).catch(function () { return { status: 0 }; });
    if (r.status !== 200) { chyba(textPresunu(r)); return; }
    await tymy(h, tato);
    zpravaEl.textContent = (z.name || 'Žák') + ' je na mapě ' + jina + '. Přidělte mu tým v Týmech mapy ' + jina + '.';
  }

  // POST …/maps: wallet zalozi mapu B, server mapy (SSM klice, games.json, cdk deploy) pripravi provoz rucne.
  function zalozMapu(h) {
    var zpet = function () { chyba(''); tymy(h); };
    chyba('');
    oznam('Založit druhou mapu – ' + h.className + '?', 'Třída se nevejde do ' + MAX_TYMU + ' firem. Vznikne mapa B a spouští se spolu '
      + 's mapou A. Dokud správce nepřipraví její server, hru třídy nepůjde spustit.');
    vycisti();
    var requestId = crypto.randomUUID();
    var ano = tlacitko('Ano, založit druhou mapu', async function () {
      ano.disabled = true;
      var r = await penezenka('POST', '/classes/' + encodeURIComponent(h.classId) + '/maps',
        { schoolId: h.schoolId, requestId: requestId }).catch(function () { return { status: 0 }; });
      ano.disabled = false;
      if (r.status !== 200) {
        if (r.status !== 0 && r.status < 500) requestId = crypto.randomUUID();
        chyba(r.error === 'class_fits_one_map' ? 'Třída se vejde na jednu mapu (' + r.info.pupils + ' žáků).'
          : r.error === 'game_key_collision' ? 'Druhou mapu nejde založit (kolize klíče hry). Ozvěte se správci.'
          : r.error === 'game_closed' ? 'Hra je uzavřená.'
          : r.status === 403 ? 'Druhou mapu této třídy nemůžete založit.' : 'Druhou mapu se nepodařilo založit.');
        return;
      }
      h.mapy = ['A', 'B'];
      oznam('Druhá mapa – ' + h.className, (r.data.created ? 'Mapa B je založená.' : 'Mapa B už existuje.')
        + ' Pošlete správci tyto kroky; dokud je neprovede, hru třídy nepůjde spustit. Pak v Týmech přesuňte žáky na mapu B.');
      vycisti();
      r.data.provisioning.forEach(function (krok, i) {
        var p = popisek((i + 1) + '. ' + krok);
        p.className = 'krok';
        tridyEl.appendChild(p);
      });
      tridyEl.appendChild(tlacitko('Týmy – ' + h.className, function () { tymy(h); }));
      tridyEl.appendChild(tlacitko('Zpět', function () { chyba(''); skola(h.schoolId, h.zpet, h.skola); }));
    });
    tridyEl.appendChild(ano);
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
      var dve = mapy(t).length > 1;
      // mapy: jen u tridy se dvema mapami (jinak [] = dotazy bez ?map=, jako driv).
      var h = { schoolId: schoolId, classId: t.classId, className: t.className || 'Třída', zpet: zpet, skola: nazev,
        resetPending: dve ? t.maps.some(function (m) { return m.resetPending; }) : !!t.resetPending,
        mapy: dve ? t.maps.map(function (m) { return m.map; }) : [] };
      var stav = stavTridy(t);
      if (dve) t.maps.forEach(function (m) { tridyEl.appendChild(popisek(stavMapy(h.className, m))); });
      if (BEZI.indexOf(stav) !== -1) {
        var zive = dve ? t.maps.filter(function (m) { return BEZI.indexOf(m.session) !== -1; }) : [t];
        var role = t.canMayor ? 'Vstoupit jako starosta – ' : 'Sledovat – ';
        zive.forEach(function (m) {
          tridyEl.appendChild(tlacitko(sMapou(role + h.className, m.map, dve), function () { tridniListek(schoolId, t.classId, null, dve ? m.map : null); }));
        });
        if (jeSuperadmin) tridyEl.appendChild(tlacitko('Hrát za žáka – ' + h.className, function () { vyberZaka(h); }));
        if (t.canManage) {
          zive.forEach(function (m) {
            if (m.stopDeadline) tridyEl.appendChild(odpocet(sMapou(h.className, m.map, dve), m.stopDeadline, r.data.serverNow));
          });
          // Tvrdy strop 4 h od spusteni: dal prodlouzit nejde, pak se trida musi spustit znovu rucne.
          if (zive.every(function (m) { return m.hardStopAt && m.stopDeadline === m.hardStopAt; })) tridyEl.appendChild(popisek(h.className + ': Server už nejde prodloužit (limit 4 hodiny). Pak ho spusťte znovu.'));
          else tridyEl.appendChild(tlacitko('Prodloužit na 2 hodiny – ' + h.className, function () {
            akceTridy(h, 'extend', { zakaz: 'Hru této třídy nemůžete prodloužit.', stav: 'Hra už neběží.', jine: 'Hru se nepodařilo prodloužit.' });
          }));
          if (stav === 'limit') tridyEl.appendChild(tlacitko('Pokračovat ve hře – ' + h.className, function () {
            akceTridy(h, 'resume', { zakaz: 'Hru této třídy nemůžete pustit dál.', stav: 'Hra už nečeká na pokračování.', jine: 'Hru se nepodařilo pustit dál.' });
          }));
          // Jedna mapa bezi, druha ne (napr. selhal jeji start): „Spustit hru“ spusti jen zbyvajici.
          if (dve && t.maps.some(function (m) { return m.session === 'stopped'; })) tridyEl.appendChild(tlacitko('Spustit hru – ' + h.className, function () { delkaHry(h); }));
          tridyEl.appendChild(tlacitko('Ukončit hru – ' + h.className, function () { ukonciTridu(h); }));
          tridyEl.appendChild(tlacitko('Týmy – ' + h.className, function () { tymy(h); }));
        }
      } else if (stav === 'starting' || stav === 'stopping') {
        tridyEl.appendChild(popisek(h.className + (stav === 'starting' ? ' – hra se spouští' : ' – hra se ukončuje')));
      } else if (t.canManage) {
        tridyEl.appendChild(tlacitko('Spustit hru – ' + h.className, function () { delkaHry(h); }));
        // Se dvema mapami jde reset zopakovat, dokud nove svety nečekají na obou.
        var vseReset = dve ? t.maps.every(function (m) { return m.resetPending; }) : h.resetPending;
        if (h.resetPending && !dve) tridyEl.appendChild(popisek(h.className + ' – nový svět čeká na spuštění'));
        if (!vseReset) tridyEl.appendChild(tlacitko('Resetovat svět – ' + h.className, function () { resetujSvet(h); }));
        tridyEl.appendChild(tlacitko('Týmy – ' + h.className, function () { tymy(h); }));
      } else {
        tridyEl.appendChild(popisek(h.className + (h.resetPending ? ' – nový svět čeká na spuštění' : ' – hra neběží')));
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
    if (c['custom:student_id']) { jeZak = true; zak(); return; }
    // Skupiny bez ohledu na velikost pismen, stejne jako penezenka (contract §1.2).
    var skupiny = (c['cognito:groups'] || []).map(function (g) { return String(g).toLowerCase(); });
    if (skupiny.some(function (g) { return UCITELSKE_SKUPINY.indexOf(g) !== -1; })) { ucitel(skupiny.indexOf('superadmin') !== -1); return; }
    odmitni('Tento účet nemá do hry přístup.');
    odkazEl.textContent = 'Přihlásit se jiným účtem';
  })();

  // Login portal po prihlaseni vrati na ?redirect= (povoleno *.educraft.cz).
  odkazEl.href = LOGIN + '?redirect=' + encodeURIComponent(location.origin + '/');
})();
