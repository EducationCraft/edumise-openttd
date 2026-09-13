class EduMiseDane extends GSInfo {
	function GetAuthor()      { return "EduCraft"; }
	function GetName()        { return "EduMise — daně"; }
	function GetShortName()   { return "EMDA"; }
	function GetDescription() { return "Každé čtvrtletí odvede firma daň z provozního zisku. Ztráta se nedaní."; }
	function GetVersion()     { return 1; }
	function GetAPIVersion()  { return "16"; }
	function GetDate()        { return "2026-09-13"; }
	function CreateInstance() { return "EduMiseDane"; }
	function UseAsRandomAI()  { return false; }

	function GetSettings() {
		AddSetting({
			name = "sazba",
			description = "Sazba daně z provozního zisku (%)",
			min_value = 0,
			max_value = 50,
			default_value = 15,
			step_size = 1,
			flags = GSInfo.CONFIG_INGAME
		});
	}
}

RegisterGS(EduMiseDane());
