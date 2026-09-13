/**
 * Dane pro EduMise.
 *
 * OpenTTD dan nezna — ma jen provozni naklady, pujcku a urok. Pro financni
 * gramotnost chybi presne ta cast, kde ze zisku neco odejde drive, nez si ho
 * firma nechá. Resi se to skriptem, ne zasahem do hry: GameScript umi
 * ChangeBankBalance a nic v C++ se menit nemusi.
 *
 * Zdani se provozni zisk za uplynule ctvrtleti. GetQuarterlyIncome a
 * GetQuarterlyExpenses zamerne pocitaji jen opakovane polozky — trzby vozidel,
 * provozni naklady, udrzbu a urok. Stavba a prodej majetku se do zakladu
 * nepocitaji, takze zak neni trestan za to, ze investoval.
 */
class EduMiseDane extends GSController
{
	sazba = 15;
	posledniCtvrtleti = null;

	function Start();
	function Save() { return { ctvrtleti = this.posledniCtvrtleti }; }
	function Load(version, data) {
		if ("ctvrtleti" in data) this.posledniCtvrtleti = data.ctvrtleti;
	}
}

/** Poradove cislo ctvrtleti, aby slo porovnat pres prelom roku. */
function EduMiseDane::Ctvrtleti()
{
	local datum = GSDate.GetCurrentDate();
	return GSDate.GetYear(datum) * 4 + (GSDate.GetMonth(datum) - 1) / 3;
}

function EduMiseDane::VyberDan(firma)
{
	local prijem = GSCompany.GetQuarterlyIncome(firma, 1);
	local vydaje = GSCompany.GetQuarterlyExpenses(firma, 1);

	// Vydaje si OpenTTD drzi jako zaporna cisla, ale nespolehame na to —
	// s abs() vyjde zisk spravne v obou pripadech.
	local zisk = prijem - abs(vydaje);
	if (zisk <= 0) return;

	local dan = zisk * this.sazba / 100;
	if (dan <= 0) return;

	GSCompany.ChangeBankBalance(firma, -dan, GSCompany.EXPENSES_OTHER, GSMap.TILE_INVALID);

	// ChangeBankBalance samo nic nehlasi, takze zpravu musime poslat sami —
	// jinak zakovi jen zmizi penize a nepochopi proc.
	GSNews.Create(GSNews.NT_ECONOMY,
		"Daň z provozního zisku za minulé čtvrtletí: " + dan
			+ " (" + this.sazba + " % ze zisku " + zisk + ")",
		firma, GSNews.NR_NONE, 0);
}

function EduMiseDane::Start()
{
	this.sazba = GSController.GetSetting("sazba");
	if (this.posledniCtvrtleti == null) this.posledniCtvrtleti = this.Ctvrtleti();

	while (true) {
		local ted = this.Ctvrtleti();
		if (ted > this.posledniCtvrtleti) {
			for (local c = GSCompany.COMPANY_FIRST; c < GSCompany.COMPANY_LAST; c++) {
				local firma = GSCompany.ResolveCompanyID(c);
				if (firma != GSCompany.COMPANY_INVALID) this.VyberDan(firma);
			}
			this.posledniCtvrtleti = ted;
		}
		this.Sleep(74); // ~jeden herni den
	}
}
