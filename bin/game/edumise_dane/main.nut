/**
 * Dane pro EduMise — podle ceskeho modelu dane z prijmu pravnickych osob.
 *
 * OpenTTD dan nezna. Pro financni gramotnost chybi presne ta cast, kde ze zisku
 * neco odejde drive, nez si ho firma necha — a hlavne ta cast, kde se dan plati
 * zalohove dopredu, jeste nez je jasne, jaky rok bude. Resi se to skriptem, ne
 * zasahem do hry: GameScript umi ChangeBankBalance a nic v C++ se menit nemusi.
 *
 * Co je prevzate z CR:
 *  - sazba 21 % ze zakladu dane (od 2024),
 *  - zuctovani jednou rocne, ne po ctvrtletich,
 *  - ctvrtletni zalohy ve vysi ctvrtiny posledni znamé dane, pokud prekrocila
 *    hranici; pri zuctovani se odectou a preplatek se vraci,
 *  - danova ztrata se odecita od zisku nasledujicich let, nejvyse pet let zpet.
 *
 * Co je vedome zjednoduseno: zaklad dane = provozni zisk, zadne odcitatelne
 * polozky, slevy, odpisy ani DPH. Zaklad stoji na GetQuarterlyIncome a
 * GetQuarterlyExpenses, ktere zamerne pocitaji jen opakovane polozky — trzby
 * vozidel, provozni naklady, udrzbu a urok. Stavba a prodej majetku se do
 * zakladu nepocitaji, takze zak neni trestan za to, ze investoval.
 */
class EduMiseDane extends GSController
{
	sazba = 21;
	hraniceZaloh = 30000;

	/** Per firmu: { dan (posledni znama), zalohy (zaplacene letos), ztraty [{rok, castka}] }. */
	stav = null;
	posledniCtvrtleti = null;
	posledniRok = null;

	function Start();
	function Save() {
		return {
			stav = this.stav,
			ctvrtleti = this.posledniCtvrtleti,
			rok = this.posledniRok
		};
	}
	function Load(version, data) {
		if ("stav" in data) this.stav = data.stav;
		if ("ctvrtleti" in data) this.posledniCtvrtleti = data.ctvrtleti;
		if ("rok" in data) this.posledniRok = data.rok;
	}
}

function EduMiseDane::Ctvrtleti()
{
	local datum = GSDate.GetCurrentDate();
	return GSDate.GetYear(datum) * 4 + (GSDate.GetMonth(datum) - 1) / 3;
}

function EduMiseDane::Rok()
{
	return GSDate.GetYear(GSDate.GetCurrentDate());
}

/** Zaznam firmy; zaklada se pri prvnim dotazu, aby slo pridat firmu i behem hry. */
function EduMiseDane::Zaznam(firma)
{
	if (!(firma in this.stav)) {
		this.stav[firma] <- { dan = 0, zalohy = 0, ztraty = [] };
	}
	return this.stav[firma];
}

function EduMiseDane::Uctuj(firma, castka, zprava)
{
	if (castka == 0) return;
	GSCompany.ChangeBankBalance(firma, -castka, GSCompany.EXPENSES_OTHER, GSMap.TILE_INVALID);
	// ChangeBankBalance samo nic nehlasi, takze zpravu musime poslat sami —
	// jinak zakovi jen zmizi penize a nepochopi proc.
	GSNews.Create(GSNews.NT_ECONOMY, zprava, firma, GSNews.NR_NONE, 0);
}

/** Provozni zisk za posledni ctyri ctvrtleti. */
function EduMiseDane::ZiskZaRok(firma)
{
	local zisk = 0;
	for (local q = 1; q <= 4; q++) {
		// Vydaje si OpenTTD drzi jako zaporna cisla, ale nespolehame na to —
		// s abs() vyjde zisk spravne v obou pripadech.
		zisk += GSCompany.GetQuarterlyIncome(firma, q) - abs(GSCompany.GetQuarterlyExpenses(firma, q));
	}
	return zisk;
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

function EduMiseDane::RocniZuctovani(firma, rok)
{
	local zaznam = this.Zaznam(firma);
	local zisk = this.ZiskZaRok(firma);
	local dan = 0;

	if (zisk > 0) {
		local odecet = this.OdectiZtraty(zaznam, zisk, rok);
		local zaklad = zisk - odecet;
		dan = zaklad * this.sazba / 100;
		if (odecet > 0) {
			GSNews.Create(GSNews.NT_ECONOMY,
				"Od zisku " + zisk + " jsme odečetli ztrátu z minulých let " + odecet
					+ ". Základ daně: " + zaklad + ".",
				firma, GSNews.NR_NONE, 0);
		}
	} else if (zisk < 0) {
		zaznam.ztraty.append({ rok = rok, castka = -zisk });
		GSNews.Create(GSNews.NT_ECONOMY,
			"Loni jsme byli ve ztrátě " + (-zisk) + ". Daň se neplatí a ztrátu si "
				+ "odečteme od zisku v příštích pěti letech.",
			firma, GSNews.NR_NONE, 0);
	}

	local rozdil = dan - zaznam.zalohy;
	if (rozdil > 0) {
		this.Uctuj(firma, rozdil, "Roční zúčtování daně: daň " + dan + ", zaplacené zálohy "
			+ zaznam.zalohy + ", doplácíme " + rozdil + ".");
	} else if (rozdil < 0) {
		this.Uctuj(firma, rozdil, "Roční zúčtování daně: daň " + dan + ", zaplacené zálohy "
			+ zaznam.zalohy + ", vrací se nám přeplatek " + (-rozdil) + ".");
	} else if (dan > 0) {
		GSNews.Create(GSNews.NT_ECONOMY,
			"Roční zúčtování daně: daň " + dan + " je přesně pokrytá zálohami.",
			firma, GSNews.NR_NONE, 0);
	}

	zaznam.dan = dan;
	zaznam.zalohy = 0;
}

/**
 * Ctvrtletni zaloha: ctvrtina posledni znamé dane. Firma, ktera loni na dani
 * nic vetsiho nezaplatila, zalohy neplati — stejne jako v CR.
 */
function EduMiseDane::Zaloha(firma)
{
	local zaznam = this.Zaznam(firma);
	if (zaznam.dan <= this.hraniceZaloh) return;

	local zaloha = zaznam.dan / 4;
	if (zaloha <= 0) return;

	zaznam.zalohy += zaloha;
	this.Uctuj(firma, zaloha, "Čtvrtletní záloha na daň: " + zaloha
		+ " (čtvrtina loňské daně " + zaznam.dan + ").");
}

function EduMiseDane::ProKazdouFirmu(akce, rok)
{
	for (local c = GSCompany.COMPANY_FIRST; c < GSCompany.COMPANY_LAST; c++) {
		local firma = GSCompany.ResolveCompanyID(c);
		if (firma == GSCompany.COMPANY_INVALID) continue;
		if (akce == "zuctovani") this.RocniZuctovani(firma, rok);
		else this.Zaloha(firma);
	}
}

function EduMiseDane::Start()
{
	this.sazba = GSController.GetSetting("sazba");
	this.hraniceZaloh = GSController.GetSetting("hranice_zaloh");
	if (this.stav == null) this.stav = {};
	if (this.posledniCtvrtleti == null) this.posledniCtvrtleti = this.Ctvrtleti();
	if (this.posledniRok == null) this.posledniRok = this.Rok();

	while (true) {
		local ctvrtleti = this.Ctvrtleti();
		if (ctvrtleti > this.posledniCtvrtleti) {
			local rok = this.Rok();
			// Prvni ctvrtleti noveho roku je zuctovaci, ostatni jsou zalohova.
			if (rok > this.posledniRok) {
				this.ProKazdouFirmu("zuctovani", rok);
				this.posledniRok = rok;
			} else {
				this.ProKazdouFirmu("zaloha", rok);
			}
			this.posledniCtvrtleti = ctvrtleti;
		}
		this.Sleep(74); // ~jeden herni den
	}
}
