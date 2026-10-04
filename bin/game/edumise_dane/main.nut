/**
 * Dane pro EduMise — dan z prijmu pravnickych osob podle ceskeho zakona
 * (ZDP 586/1992 Sb., danovy rad 280/2009 Sb.).
 *
 * OpenTTD dan nezna. Pro financni gramotnost chybi presne ta cast, kde ze zisku
 * neco odejde drive, nez si ho firma necha — a hlavne ta cast, kde se dan plati
 * zalohove dopredu, jeste nez je jasne, jaky rok bude. GameScript ji dopocita
 * a strhne pres ChangeBankBalance.
 *
 * Co je prevzate z CR (vse v Kc; hra pocita v librach, Kc = libry × EDU_CZK):
 *  - zdanovaci obdobi = kalendarni rok; priznani za rok Y se zuctuje 1. 4. Y+1
 *    (lhuta §136 DR) z presnych rocnich udaju financniho okna za rok Y
 *    (GSCompany.GetAnnualExpenseValue, rozsireni forku; rok se posouva 1. 1.),
 *  - zaklad dane = vynosy (trzby vozidel) − danove naklady: provoz vozidel, udrzba
 *    majetku a infrastruktury (EXPENSES_PROPERTY), uroky a danove odpisy,
 *  - rovnomerne odpisy (§31): vozidla skupina 2 (5 let, 11 % / 22,25 %), stavby
 *    skupina 5 (30 let, 1,4 % / 3,4 %), rocni odpis zaokrouhlen na Kc nahoru,
 *  - zaklad zaokrouhlen na tisice Kc dolu (§20 odst. 11), dan = sazba % z nej
 *    na cele Kc nahoru (§146 DR); sazba 21 % (§21), starosta ji muze menit 0–50 %,
 *    pro rok plati sazba platna 31. 12.,
 *  - danova ztrata (§34): nejdriv zpet do dvou predchozich let (dodatecne priznani,
 *    vratka dane, nejvys 30 mil. Kc), zbytek se odecita od zisku az 5 let dopredu,
 *  - zalohy (§38a) z posledni zname danove povinnosti: do 30 000 Kc zadne, do
 *    150 000 Kc 40 % pololetne (15. 6., 15. 12.), nad 150 000 Kc 25 % ctvrtletne
 *    (15. 3., 6., 9., 12.), zaokrouhlene na stokoruny nahoru; pri zuctovani se
 *    odectou, nedoplatek se doplati, preplatek se vraci.
 *
 * Penize se hybou v celych librach, zaokrouhleno ve prospech statu (platba nahoru,
 * vratka dolu, nejvys 40 Kc); zpravy a evidence jsou v Kc podle zakona.
 *
 * Co je vedome zjednoduseno: EXPENSES_OTHER se nepocita vubec — jsou v nem dary
 * (startovni kapital, vklady zaku, dotace, zachrany), dane, pokuty, ale i reklama
 * a mesicni poplatek banky. Majetek se odpisuje z cistych rocnich vydaju na nova
 * vozidla a stavby, zadne slevy ani DPH.
 */
const DAN_CTVRTLETNI_ZALOHY = 150000; // Kc, §38a odst. 1 pism. b)
const DAN_ZPET_MAX = 30000000;        // Kc, §34 odst. 1: zpetne uplatnena ztrata nejvyse

class EduMiseDane extends GSController
{
	/* null = not in the save yet: Start reads the setting. The mayor's `tax` op changes sazba. */
	sazba = null;
	hraniceZaloh = null; // Kc: do teto posledni zname dane se zalohy neplati

	/**
	 * Per firmu (Kc): { dan (posledni znama danova povinnost), zalohy (zaplacene od posledniho
	 * zuctovani), ztraty [{rok, castka}], majetek [{s (skupina 2|5), rok, cena, zbyva}],
	 * historie [{rok, zaklad, sazba, dan}] (posledni dva roky, pro zpetnou ztratu) }.
	 */
	stav = null;
	posledniRok = null;   // rok posledniho rocniho rozpoctu mesta
	zuctovano = null;     // posledni zuctovany rok
	termin = null;        // index posledniho terminu zaloh (rok * 4 + pocet uplynulych 15. 3./6./9./12.)
	sazby = null;         // {rok: sazba} — sazba na konci roku plati pro cely rok
	citadela = false;

	/**
	 * Penezenka (setting `penezenka` = 1), see wallet.nut. Saved in the savegame:
	 * { game, last, ring, bind, inited, loanPending, run, sid, stopAt, months,
	 *   pokladna, rozpocet, citadela, kapital }.
	 */
	w = null;
	/* Not saved: a restart always goes through the bridge again. */
	held = false;
	lastMsgTick = 0;
	lastMonth = null;
	lastDay = null;
	needMonth = null;
	loanFailSent = null;
	ladeni = false;
	ackP = null; // amount a mayor op actually applied, for its ack

	function Start();
	function Save() {
		local data = {
			stav = this.stav,
			rok = this.posledniRok,
			zuctovano = this.zuctovano,
			termin = this.termin,
			sazby = this.sazby,
			citadela = this.citadela,
			sazba = this.sazba,
			hraniceZaloh = this.hraniceZaloh
		};
		if (this.w != null) data.w <- this.w;
		return data;
	}
	function Load(version, data) {
		if ("stav" in data) this.stav = data.stav;
		if ("rok" in data) this.posledniRok = data.rok;
		/* Starsi save zuctoval v lednu rok, ktery prave skoncil. */
		if ("zuctovano" in data) this.zuctovano = data.zuctovano;
		else if ("rok" in data) this.zuctovano = data.rok - 1;
		if ("termin" in data) this.termin = data.termin;
		if ("sazby" in data) this.sazby = data.sazby;
		if ("citadela" in data) this.citadela = data.citadela;
		if ("w" in data) this.w = data.w;
		if ("sazba" in data) this.sazba = data.sazba;
		if ("hraniceZaloh" in data) this.hraniceZaloh = data.hraniceZaloh;
	}
}

require("wallet.nut");

function EduMiseDane::Rok()
{
	return GSDate.GetYear(GSDate.GetCurrentDate());
}

/** Index posledniho terminu zaloh: 15. 3., 15. 6., 15. 9. a 15. 12. */
function EduMiseDane::Termin()
{
	local d = GSDate.GetCurrentDate();
	return GSDate.GetYear(d) * 4 + (GSDate.GetMonth(d) - (GSDate.GetDayOfMonth(d) >= 15 ? 0 : 1)) / 3;
}

/** Zaznam firmy; zaklada se pri prvnim dotazu, aby slo pridat firmu i behem hry. */
function EduMiseDane::Zaznam(firma)
{
	if (!(firma in this.stav)) this.stav[firma] <- { dan = 0, zalohy = 0, ztraty = [] };
	local z = this.stav[firma];
	if (!("majetek" in z)) {
		/* Starsi save drzel castky v librach, ztratu pod rokem zuctovani (Y+1) a nemel majetek ani historii. */
		z.dan *= EDU_CZK;
		z.zalohy *= EDU_CZK;
		foreach (ztrata in z.ztraty) { ztrata.castka *= EDU_CZK; ztrata.rok -= 1; }
		z.majetek <- [];
		z.historie <- [];
	}
	return z;
}

/** Kc na libry pro pohyb penez, ve prospech statu: platba nahoru, vratka (zaporna) dolu. */
function EduMiseDane::Libry(kc)
{
	return kc >= 0 ? (kc + EDU_CZK - 1) / EDU_CZK : -(-kc / EDU_CZK);
}

/** castka v librach (zaporna = vratka); zprava jde firme vzdy. */
function EduMiseDane::Uctuj(firma, castka, zprava)
{
	if (castka != 0) {
		if (this.w != null) this.DoPokladny(firma, castka);
		GSCompany.ChangeBankBalance(firma, -castka, GSCompany.EXPENSES_OTHER, GSMap.TILE_INVALID);
	}
	// ChangeBankBalance samo nic nehlasi, takze zpravu musime poslat sami —
	// jinak zakovi jen zmizi penize a nepochopi proc.
	GSNews.Create(GSNews.NT_ECONOMY, zprava, firma, GSNews.NR_NONE, 0);
}

/** Dan z nezaokrouhleneho zakladu: zaklad na tisice dolu, dan na Kc nahoru. */
function EduMiseDane::DanZ(zaklad, sazba)
{
	return (max(0, zaklad) / 1000 * 1000 * sazba + 99) / 100;
}

/**
 * Rocni udaje z financniho okna (Kc) za rok `zpet` let nazpet (1 = loni). Kazdy typ
 * ExpensesType je zarazen vyslovne; EXPENSES_OTHER zamerne chybi (viz hlavicka).
 */
function EduMiseDane::RocniUdaje(firma, zpet)
{
	local G = GSCompany;
	local u = { vynosy = 0, naklady = 0, vozidla = 0, stavby = 0 };
	foreach (t in [G.EXPENSES_TRAIN_INC, G.EXPENSES_ROADVEH_INC, G.EXPENSES_AIRCRAFT_INC, G.EXPENSES_SHIP_INC]) {
		u.vynosy += G.GetAnnualExpenseValue(firma, zpet, t);
	}
	foreach (t in [G.EXPENSES_TRAIN_RUN, G.EXPENSES_ROADVEH_RUN, G.EXPENSES_AIRCRAFT_RUN, G.EXPENSES_SHIP_RUN,
			G.EXPENSES_PROPERTY, G.EXPENSES_LOAN_INT]) {
		u.naklady -= G.GetAnnualExpenseValue(firma, zpet, t);
	}
	u.vozidla = -G.GetAnnualExpenseValue(firma, zpet, G.EXPENSES_NEW_VEHICLES);
	u.stavby = -G.GetAnnualExpenseValue(firma, zpet, G.EXPENSES_CONSTRUCTION);
	foreach (k, v in u) u[k] = v * EDU_CZK;
	return u;
}

/**
 * Zaradi letosni cisty vydaj na vozidla a stavby do majetku a vrati odpisy za rok.
 * ponytail: prodej vozidla jen snizi letosni vydaj (zaporny rok se neodpisuje) a majetek
 * se nevyrazuje; presne by to chtelo evidenci po kusech pres GSVehicle.
 */
function EduMiseDane::Odpisy(z, rok, vozidla, stavby)
{
	if (vozidla > 0) z.majetek.append({ s = 2, rok = rok, cena = vozidla, zbyva = vozidla });
	if (stavby > 0) z.majetek.append({ s = 5, rok = rok, cena = stavby, zbyva = stavby });
	local celkem = 0, dal = [];
	foreach (m in z.majetek) {
		// Sazby v setinach procenta: 1. rok / dalsi roky (§31 odst. 1).
		local sazba = m.s == 2 ? (m.rok == rok ? 1100 : 2225) : (m.rok == rok ? 140 : 340);
		local odpis = min(m.zbyva, (m.cena * sazba + 9999) / 10000);
		m.zbyva -= odpis;
		celkem += odpis;
		if (m.zbyva > 0) dal.append(m);
	}
	z.majetek = dal;
	return celkem;
}

/**
 * Odecte od zisku drive vykazane ztraty, od nejstarsi. Vraci, kolik se odecetlo;
 * spotrebovane a promlcene zaznamy z evidence mizi.
 */
function EduMiseDane::OdectiZtraty(zaznam, zisk, rok)
{
	local zbyva = zisk;
	local odecteno = 0;
	local dal = [];

	foreach (ztrata in zaznam.ztraty) {
		if (rok - ztrata.rok > 5) continue; // promlcena
		if (zbyva <= 0) { dal.append(ztrata); continue; }

		local pouzito = zbyva < ztrata.castka ? zbyva : ztrata.castka;
		odecteno += pouzito;
		zbyva -= pouzito;
		if (ztrata.castka > pouzito) {
			dal.append({ rok = ztrata.rok, castka = ztrata.castka - pouzito });
		}
	}

	zaznam.ztraty = dal;
	return odecteno;
}

/**
 * Cisty vypocet priznani za rok (vse v Kc); meni jen zaznam z. u = { vynosy, naklady,
 * vozidla, stavby }. Vraci vysledek pro zpravu a pohyb penez.
 */
function EduMiseDane::Priznani(z, rok, u, sazba)
{
	local r = { rok = rok, vynosy = u.vynosy, naklady = u.naklady, odpisy = this.Odpisy(z, rok, u.vozidla, u.stavby),
		zisk = 0, odecteno = 0, zaklad = 0, sazba = sazba, dan = 0, zpet = 0, vratka = 0, ztrata = 0,
		zalohy = z.zalohy, rozdil = 0 };
	r.zisk = r.vynosy - r.naklady - r.odpisy;
	local zaklad = 0;

	if (r.zisk > 0) {
		r.odecteno = this.OdectiZtraty(z, r.zisk, rok);
		zaklad = r.zisk - r.odecteno;
	} else if (r.zisk < 0) {
		// Ztrata nejdriv snizi zaklady dvou predchozich let (od starsiho), vratka = rozdil dani.
		local zbyva = -r.zisk;
		local zpet = min(zbyva, DAN_ZPET_MAX);
		foreach (h in z.historie) {
			if (rok - h.rok > 2 || h.rok >= rok) continue;
			local o = min(zpet, h.zaklad);
			if (o <= 0) continue;
			h.zaklad -= o;
			zpet -= o;
			zbyva -= o;
			r.zpet += o;
			local nova = this.DanZ(h.zaklad, h.sazba);
			r.vratka += h.dan - nova;
			h.dan = nova;
		}
		r.ztrata = zbyva;
		if (zbyva > 0) z.ztraty.append({ rok = rok, castka = zbyva });
	}

	r.zaklad = zaklad / 1000 * 1000;
	r.dan = this.DanZ(zaklad, sazba);
	r.rozdil = r.dan - z.zalohy;

	z.historie.append({ rok = rok, zaklad = zaklad, sazba = sazba, dan = r.dan });
	while (z.historie.len() > 2) z.historie.remove(0);
	z.dan = r.dan;
	z.zalohy = 0;
	return r;
}

/** Priznani firmy za rok `rok`, ktery je `zpet` let nazpet; strhne/vrati penize a posle zpravy. */
function EduMiseDane::RocniZuctovani(firma, rok, zpet)
{
	local sazba = rok in this.sazby ? this.sazby[rok] : this.sazba;
	local r = this.Priznani(this.Zaznam(firma), rok, this.RocniUdaje(firma, zpet), sazba);
	local K = this.Cislo;

	local t = "Daňové přiznání za rok " + rok + ": výnosy " + K(r.vynosy) + " Kč, náklady " + K(r.naklady)
		+ " Kč, odpisy " + K(r.odpisy) + " Kč";
	if (r.zisk >= 0) {
		t += ", zisk " + K(r.zisk) + " Kč";
		if (r.odecteno > 0) t += ", odečtená ztráta z minulých let " + K(r.odecteno) + " Kč";
		t += ", základ daně " + K(r.zaklad) + " Kč, daň " + r.sazba + " % = " + K(r.dan) + " Kč";
	} else {
		t += ", ztráta " + K(-r.zisk) + " Kč, daň se neplatí";
		if (r.ztrata > 0) t += "; " + K(r.ztrata) + " Kč odečteme od zisku v příštích 5 letech";
	}
	t += ". Zaplacené zálohy " + K(r.zalohy) + " Kč, ";
	if (r.rozdil > 0) t += "doplácíme " + K(r.rozdil) + " Kč.";
	else if (r.rozdil < 0) t += "přeplatek " + K(-r.rozdil) + " Kč se nám vrací.";
	else t += "nic nedoplácíme.";
	this.Uctuj(firma, this.Libry(r.rozdil), t);

	if (r.vratka > 0) {
		this.Uctuj(firma, this.Libry(-r.vratka), "Dodatečné přiznání: ztrátou za rok " + rok
			+ " jsme snížili základ daně za předchozí dva roky o " + K(r.zpet) + " Kč, vrací se nám daň "
			+ K(r.vratka) + " Kč.");
	}
	if (this.ladeni) this.Send({ t = "dan", c = firma, r = r });
	return r;
}

/** Zaloha (Kc) splatna 15. dne mesice `mesic` (3, 6, 9, 12) z posledni zname dane, na stokoruny nahoru. */
function EduMiseDane::ZalohaKc(dan, mesic)
{
	if (dan <= this.hraniceZaloh) return 0;
	if (dan <= DAN_CTVRTLETNI_ZALOHY) return mesic % 6 == 0 ? (dan * 40 + 9999) / 10000 * 100 : 0;
	return (dan * 25 + 9999) / 10000 * 100;
}

function EduMiseDane::Zaloha(firma, mesic)
{
	local z = this.Zaznam(firma);
	local zaloha = this.ZalohaKc(z.dan, mesic);
	if (zaloha <= 0) return;

	z.zalohy += zaloha;
	this.Uctuj(firma, this.Libry(zaloha), "Záloha na daň splatná 15. " + mesic + ".: " + this.Cislo(zaloha)
		+ " Kč (" + (z.dan > DAN_CTVRTLETNI_ZALOHY ? "čtvrtletně 25 %" : "pololetně 40 %")
		+ " z poslední známé daně " + this.Cislo(z.dan) + " Kč).");
}

/** Nejvetsi mesto (sidlo starosty mapy) se jmenuje Citadela. Jen jednou za hru. */
function EduMiseDane::PojmenujCitadelu()
{
	local mesta = GSTownList();
	if (mesta.IsEmpty()) return;
	mesta.Valuate(GSTown.GetPopulation);
	mesta.Sort(GSList.SORT_BY_VALUE, GSList.SORT_DESCENDING);
	GSTown.SetName(mesta.Begin(), "Citadela");
}

/** Denni kontrola: rozpocet mesta k 1. 1., priznani k 1. 4., zalohy k 15. 3./6./9./12. */
function EduMiseDane::Dane()
{
	local d = GSDate.GetCurrentDate();
	local rok = GSDate.GetYear(d);
	this.sazby[rok] <- this.sazba;
	foreach (r, _ in clone this.sazby) {
		if (r < rok - 2) delete this.sazby[r];
	}

	if (rok > this.posledniRok) {
		if (this.w != null) this.RocniRozpocet(rok - 1);
		this.posledniRok = rok;
	}

	local zuctovat = GSDate.GetMonth(d) >= 4 ? rok - 1 : rok - 2;
	if (zuctovat > this.zuctovano) {
		this.zuctovano = zuctovat;
		foreach (c in this.Companies()) this.RocniZuctovani(c, zuctovat, rok - zuctovat);
	}

	local termin = this.Termin();
	if (termin > this.termin) {
		this.termin = termin;
		foreach (c in this.Companies()) this.Zaloha(c, ((termin - 1) % 4 + 1) * 3);
	}
}

/**
 * Ladeni (jen `ladeni` = 1); vraci true, kdyz zpravu zpracovalo:
 * {"what":"dan","roky":[{rok,vynosy,naklady,vozidla,stavby,sazba}]} pocita priznani nad novou firmou,
 * {"what":"zalohy","dan":X} vrati zalohy splatne 15. 3., 6., 9., 12. z posledni dane X Kc,
 * {"c":3,"dan":X,"mesic":6} nastavi posledni dan (Kc) a zaplati zalohu splatnou v tom mesici,
 * {"c":3,"zuctovani":true,"zpet":0} zuctuje rok `zpet` let nazpet (1. 4. se vola se zpet = 1).
 */
function EduMiseDane::DaneLadeni(m)
{
	local co = this.F(m, "what");
	if (co == "dan") {
		local z = { dan = 0, zalohy = 0, ztraty = [], majetek = [], historie = [] }, out = [];
		foreach (u in m.roky) {
			local r = this.Priznani(z, u.rok, u, u.sazba);
			out.append({ rok = r.rok, odpisy = r.odpisy, zisk = r.zisk, odecteno = r.odecteno, zaklad = r.zaklad,
				dan = r.dan, zpet = r.zpet, vratka = r.vratka, ztrata = r.ztrata });
		}
		this.Send({ t = "debug", roky = out, ztraty = z.ztraty });
		return true;
	}
	if (co == "zalohy") {
		local out = [];
		foreach (mesic in [3, 6, 9, 12]) out.append(this.ZalohaKc(m.dan, mesic));
		this.Send({ t = "debug", zalohy = out });
		return true;
	}
	if (typeof this.F(m, "mesic") == "integer" || this.F(m, "zuctovani") == true) {
		local ok = this.Exists(this.F(m, "c")) && !GSGame.IsPaused();
		local r = null;
		if (ok) {
			if ("mesic" in m) {
				this.Zaznam(m.c).dan = m.dan;
				this.Zaloha(m.c, m.mesic);
			} else {
				local zpet = this.F(m, "zpet") == null ? 1 : m.zpet;
				r = this.RocniZuctovani(m.c, this.Rok() - zpet, zpet);
			}
		}
		local z = ok ? this.Zaznam(m.c) : null;
		this.Send({ t = "debug", ok = ok, dan = ok ? z.dan : 0, zalohy = ok ? z.zalohy : 0, r = r });
		return true;
	}
	return false;
}

function EduMiseDane::Start()
{
	if (this.sazba == null) this.sazba = GSController.GetSetting("sazba");
	if (this.hraniceZaloh == null) this.hraniceZaloh = GSController.GetSetting("hranice_zaloh");
	if (this.stav == null) this.stav = {};
	if (this.sazby == null) this.sazby = {};
	if (this.posledniRok == null) this.posledniRok = this.Rok();
	if (this.zuctovano == null) this.zuctovano = this.Rok() - 1;
	if (this.termin == null) this.termin = this.Termin();

	if (GSController.GetSetting("penezenka") == 1) {
		this.PenezenkaStart();
		return;
	}

	if (!this.citadela) {
		this.PojmenujCitadelu();
		this.citadela = true;
	}

	while (true) {
		// Firma se znovu pouzitym id (zkrachovala AI) zacina s cistymi danemi, viz wallet.nut HandleEvents.
		while (GSEventController.IsEventWaiting()) {
			local e = GSEventController.GetNextEvent();
			if (e.GetEventType() != GSEvent.ET_COMPANY_NEW) continue;
			local c = GSEventCompanyNew.Convert(e).GetCompanyID();
			if (c in this.stav) delete this.stav[c];
		}
		this.Dane();
		this.Sleep(74); // ~jeden herni den
	}
}
