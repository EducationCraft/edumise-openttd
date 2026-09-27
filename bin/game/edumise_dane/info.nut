class EduMiseDane extends GSInfo {
	function GetAuthor()      { return "EduCraft"; }
	function GetName()        { return "EduMise — daně"; }
	function GetShortName()   { return "EMDA"; }
	function GetDescription() { return "Daň z příjmů podle českého modelu: 21 % ze zisku, roční zúčtování, čtvrtletní zálohy a odpočet ztráty z minulých let."; }
	function GetVersion()     { return 4; }
	function GetAPIVersion()  { return "16"; }
	function GetDate()        { return "2026-09-27"; }
	function CreateInstance() { return "EduMiseDane"; }
	function UseAsRandomAI()  { return false; }

	function GetSettings() {
		AddSetting({
			name = "sazba",
			description = "Sazba daně z příjmů (%) — v ČR 21 %",
			min_value = 0,
			max_value = 50,
			default_value = 21,
			step_size = 1,
			flags = GSInfo.CONFIG_INGAME
		});
		AddSetting({
			name = "hranice_zaloh",
			description = "Zálohy se platí, když loňská daň přesáhla tuto částku",
			min_value = 0,
			max_value = 1000000,
			default_value = 30000,
			step_size = 10000,
			flags = GSInfo.CONFIG_INGAME
		});
		AddSetting({
			name = "penezenka",
			description = "Peněženka EduMise: třída hraje na serveru, peníze firem jdou z peněženky (jen pro server)",
			min_value = 0,
			max_value = 1,
			default_value = 0,
			flags = GSInfo.CONFIG_BOOLEAN
		});
		AddSetting({
			name = "ladeni",
			description = "Ladění: testovací zprávy z admin portu (jen pro lokální testy)",
			min_value = 0,
			max_value = 1,
			default_value = 0,
			flags = GSInfo.CONFIG_BOOLEAN
		});
	}
}

RegisterGS(EduMiseDane());
