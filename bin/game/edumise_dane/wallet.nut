/**
 * Penezenka EduMise (setting `penezenka` = 1): the class plays on a dedicated server and
 * the pupils' money comes from the EduCraft wallet. Protocol and rules:
 * educraft-wallet/docs/CONTRACT.md, section 4.4.
 *
 * The bridge (admin port) sends ops in one ordered sequence; this script applies only
 * `last + 1` and keeps `last`, the last 64 results and the company -> slot bindings in
 * the savegame, so exactly-once survives restarts and save rollbacks.
 *
 * Rule of thumb: never issue a command while the game is paused. At command_pause_level 1
 * such a command waits for an unpause, the script waits with it, and only this script can
 * lift its own pause bit, so the game would stay frozen.
 */

const EDU_RING = 64;
const EDU_WATCHDOG_TICKS = 2000;   // ~54 s without any bridge message
const EDU_CZK = 41;                // OpenTTD CZK display multiplier
const EDU_MIN_BUFFER = 1000;       // rescue buffer floor, pounds
/* Largest loan-init top-up, pounds: one month of interest on £13,924 at 4 % (£47) plus the
 * monthly fee (Price::StationValue >> 2, £25), with headroom. */
const EDU_NATIVE_CHARGES = 100;
/* City treasury (D23): one-off start plus every tax actually paid; mayor grants come out of it. */
const EDU_START_POKLADNA = 20000;
const EDU_DUM = 1000;              // pounds per house a mayor's `expand` actually built (estimate)
const EDU_MAX_HOUSES = 20;
const EDU_MAX_TAX = 50;
/* The wallet caps news at 200 characters; Squirrel counts UTF-8 bytes (Czech: up to 2-3 each). */
const EDU_MAX_NEWS_BYTES = 800;

function EduMiseDane::F(m, k)
{
	return (k in m) ? m[k] : null;
}

function EduMiseDane::Send(data)
{
	if (!GSAdmin.Send(data)) GSLog.Error("GSAdmin.Send failed: " + data.t);
}

function EduMiseDane::MonthIndex()
{
	local d = GSDate.GetCurrentDate();
	return GSDate.GetYear(d) * 12 + GSDate.GetMonth(d) - 1;
}

function EduMiseDane::DateStr()
{
	local d = GSDate.GetCurrentDate();
	local m = GSDate.GetMonth(d), dd = GSDate.GetDayOfMonth(d);
	return GSDate.GetYear(d) + "-" + (m < 10 ? "0" : "") + m + "-" + (dd < 10 ? "0" : "") + dd;
}

/** Pounds as game korunas with thousands separated: 6962 -> "285 442". */
function EduMiseDane::Kc(pounds)
{
	local s = "" + abs(pounds * EDU_CZK), out = "";
	while (s.len() > 3) {
		out = " " + s.slice(s.len() - 3) + out;
		s = s.slice(0, s.len() - 3);
	}
	return (pounds < 0 ? "-" : "") + s + out;
}

function EduMiseDane::Exists(c)
{
	return typeof c == "integer" && GSCompany.ResolveCompanyID(c) != GSCompany.COMPANY_INVALID;
}

function EduMiseDane::Companies()
{
	local list = [];
	for (local c = GSCompany.COMPANY_FIRST; c < GSCompany.COMPANY_LAST; c++) {
		if (GSCompany.ResolveCompanyID(c) != GSCompany.COMPANY_INVALID) list.append(c);
	}
	return list;
}

/* Company reads happen in company mode: in deity mode GetLoanAmount() is -1 and
 * GetMaxLoanAmount() the global value. The mode ends when the function returns. */
function EduMiseDane::Money(c)
{
	local mode = GSCompanyMode(c);
	return {
		cash = GSCompany.GetBankBalance(GSCompany.COMPANY_SELF),
		loan = GSCompany.GetLoanAmount(),
		ml = GSCompany.GetMaxLoanAmount()
	};
}

function EduMiseDane::FinOf(c)
{
	local mode = GSCompanyMode(c);
	local self = GSCompany.COMPANY_SELF, cur = GSCompany.CURRENT_QUARTER;
	return {
		c = c,
		cash = GSCompany.GetBankBalance(self),
		loan = GSCompany.GetLoanAmount(),
		ml = GSCompany.GetMaxLoanAmount(),
		val = GSCompany.GetQuarterlyCompanyValue(self, cur),
		col = GSCompany.GetPrimaryLiveryColour(GSCompany.LS_DEFAULT),
		i0 = GSCompany.GetQuarterlyIncome(self, cur),
		e0 = GSCompany.GetQuarterlyExpenses(self, cur),
		i1 = GSCompany.GetQuarterlyIncome(self, 1),
		e1 = GSCompany.GetQuarterlyExpenses(self, 1)
	};
}

function EduMiseDane::RepayLoan(c)
{
	local mode = GSCompanyMode(c);
	return GSCompany.SetLoanAmount(0);
}

function EduMiseDane::SetColourAs(c, colour)
{
	local mode = GSCompanyMode(c);
	return GSCompany.SetPrimaryLiveryColour(GSCompany.LS_DEFAULT, colour);
}

/** @return null on success, else the ack reason. */
function EduMiseDane::SetNameAs(c, name)
{
	local mode = GSCompanyMode(c);
	if (GSCompany.SetName(name)) return null;
	return GSError.GetLastError() == GSError.ERR_NAME_IS_NOT_UNIQUE ? "name_taken" : "invalid";
}

function EduMiseDane::TownActionAs(c, town, action)
{
	local mode = GSCompanyMode(c);
	return GSTown.IsActionAvailable(town, action) && GSTown.PerformTownAction(town, action);
}

function EduMiseDane::Give(c, pounds)
{
	return GSCompany.ChangeBankBalance(c, pounds, GSCompany.EXPENSES_OTHER, GSMap.TILE_INVALID);
}

/* ---------------------------------------------------------------- start */

function EduMiseDane::PenezenkaStart()
{
	this.ladeni = GSController.GetSetting("ladeni") == 1;
	if (this.w == null) {
		this.w = { game = null, last = 0, ring = [], bind = {}, inited = {}, loanPending = {},
			run = false, sid = null, stopAt = 0, months = 18 };
	}
	/* Older saves get the treasury filled in (D23). */
	if (!("pokladna" in this.w)) this.w.pokladna <- EDU_START_POKLADNA;
	if (!("rozpocet" in this.w)) this.w.rozpocet <- { dane = 0, dotace = 0, pokuty = 0, stavby = 0 };
	/* Companies that got the start capital; older saves give it to every existing company once. */
	if (!("kapital" in this.w)) this.w.kapital <- {};
	this.needMonth = {};
	this.loanFailSent = {};

	/* After a load the session restarts only through the bridge. */
	this.w.run = false;
	foreach (c, s in clone this.w.bind) {
		if (!this.Exists(c)) delete this.w.bind[c];
	}
	foreach (c, _ in clone this.w.inited) {
		if (!this.Exists(c)) delete this.w.inited[c];
	}
	foreach (c, _ in clone this.w.loanPending) {
		if (!this.Exists(c)) delete this.w.loanPending[c];
	}
	foreach (c, _ in clone this.w.kapital) {
		if (!this.Exists(c)) delete this.w.kapital[c];
	}
	foreach (c in this.Companies()) {
		if (!(c in this.w.inited) && this.Money(c).loan != 0) this.w.loanPending[c] <- true;
	}

	if (!GSGame.IsPaused()) {
		if (!this.citadela) {
			this.PojmenujCitadelu();
			this.citadela = true;
		}
		GSGame.Pause();
	}
	this.Citadela();
	this.lastMsgTick = GSController.GetTick();
	this.PenezenkaLoop();
}

function EduMiseDane::PenezenkaLoop()
{
	while (true) {
		this.HandleEvents();

		if (this.w.run && !GSGame.IsPaused()) {
			if (GSController.GetTick() - this.lastMsgTick > EDU_WATCHDOG_TICKS) {
				/* Bridge gone: stop the clock; the next session{run:true} resumes. */
				GSLog.Warning("Bridge watchdog: no message for " + EDU_WATCHDOG_TICKS + " ticks, pausing.");
				GSGame.Pause();
			} else if (!this.held) {
				/* A hold is handled only between two Running() calls, so a tax or loan-init
				 * pass in flight is complete before `held`, and nothing starts until resume. */
				this.Running();
			}
		}
		this.Sleep(5);
	}
}

/** Work that is only safe while the session runs and the game is not paused. */
function EduMiseDane::Running()
{
	this.LoanInit();
	this.Kapital();

	local month = this.MonthIndex();
	if (month != this.lastMonth) {
		if (this.lastMonth != null) this.SendFin();
		this.lastMonth = month;
	}
	if (month >= this.w.stopAt) {
		this.Limit();
		return;
	}

	local day = GSDate.GetCurrentDate();
	if (day != this.lastDay) {
		this.lastDay = day;
		this.CheckNeeds(month);
	}
	this.Dane();
}

/* --------------------------------------------------------------- events */

function EduMiseDane::HandleEvents()
{
	while (GSEventController.IsEventWaiting()) {
		local e = GSEventController.GetNextEvent();
		switch (e.GetEventType()) {
			case GSEvent.ET_ADMIN_PORT: {
				local m = GSEventAdminPort.Convert(e).GetObject();
				if (typeof m == "table" && "t" in m) this.OnAdmin(m);
				break;
			}
			case GSEvent.ET_COMPANY_NEW: {
				local c = GSEventCompanyNew.Convert(e).GetCompanyID();
				this.ForgetCompany(c);
				if (c in this.stav) delete this.stav[c]; // a reused id starts with clean taxes
				this.w.loanPending[c] <- true;
				this.Send({ t = "company", c = c, ev = "new" });
				break;
			}
			case GSEvent.ET_COMPANY_BANKRUPT: {
				local c = GSEventCompanyBankrupt.Convert(e).GetCompanyID();
				this.ForgetCompany(c);
				this.Send({ t = "company", c = c, ev = "removed" });
				break;
			}
			case GSEvent.ET_COMPANY_MERGER: {
				local c = GSEventCompanyMerger.Convert(e).GetOldCompanyID();
				this.ForgetCompany(c);
				this.Send({ t = "company", c = c, ev = "merged" });
				break;
			}
			case GSEvent.ET_COMPANY_IN_TROUBLE:
				this.Send({ t = "company", c = GSEventCompanyInTrouble.Convert(e).GetCompanyID(), ev = "bankrupt" });
				break;
		}
	}
}

function EduMiseDane::ForgetCompany(c)
{
	if (c in this.w.bind) delete this.w.bind[c];
	if (c in this.w.inited) delete this.w.inited[c];
	if (c in this.w.loanPending) delete this.w.loanPending[c];
	if (c in this.w.kapital) delete this.w.kapital[c];
	if (c in this.needMonth) delete this.needMonth[c];
	if (c in this.loanFailSent) delete this.loanFailSent[c];
}

function EduMiseDane::OnAdmin(m)
{
	this.lastMsgTick = GSController.GetTick();
	switch (m.t) {
		case "hello":
			this.held = false;
			this.SendState();
			break;
		case "adopt":
			if (this.w.game == null && typeof this.F(m, "game") == "string") {
				this.w.game = m.game;
				/* A world reset keeps the wallet's seq numbering: the new map continues from its base. */
				local base = this.F(m, "last");
				if (this.w.last == 0 && typeof base == "integer" && base > 0) this.w.last = base;
			}
			this.SendState();
			break;
		case "bind": {
			local c = this.F(m, "c"), s = this.F(m, "s");
			if (typeof c != "integer") break;
			if (s == null) {
				if (c in this.w.bind) delete this.w.bind[c];
			} else if (typeof s == "integer") {
				this.w.bind[c] <- s;
			} else {
				break;
			}
			this.Send({ t = "bound", c = c, s = s });
			break;
		}
		case "ping":
			this.Send({ t = "pong", last = this.w.last });
			break;
		case "hold":
			/* Messages are handled one at a time, so no op is mid-apply here. */
			this.held = true;
			this.Send({ t = "held", last = this.w.last });
			break;
		case "session":
			if (this.F(m, "run") == true) this.SessionStart(m); else this.SessionStop();
			break;
		case "report":
			if (this.F(m, "what") == "fin") this.SendFin();
			else if (this.F(m, "what") == "towns") this.SendTowns();
			break;
		case "op":
			this.OnOp(m);
			break;
		case "debug":
			if (this.ladeni) this.OnDebug(m);
			break;
		default:
			GSLog.Warning("Unknown admin message: " + m.t);
	}
}

/* -------------------------------------------------------------- session */

function EduMiseDane::SessionStart(m)
{
	local sid = this.F(m, "sid"), months = this.F(m, "months");
	if (sid != this.w.sid) {
		this.w.sid = sid;
		this.w.months = (typeof months == "integer" && months > 0) ? months : 18;
		this.w.stopAt = this.MonthIndex() + this.w.months;
	}
	this.held = false;
	if (this.MonthIndex() >= this.w.stopAt) {
		this.Limit();
		return;
	}
	this.w.run = true;
	GSGame.Unpause();
	this.LoanInit();
}

function EduMiseDane::SessionStop()
{
	this.w.run = false;
	GSGame.Pause();
}

function EduMiseDane::Limit()
{
	this.w.run = false;
	GSGame.Pause();
	this.Send({ t = "limit", months = this.w.months });
}

/* ------------------------------------------------------------------ ops */

function EduMiseDane::OnOp(m)
{
	local seq = this.F(m, "seq");
	if (typeof seq != "integer") return;

	if (seq <= this.w.last) {
		/* Already applied: repeat the answer. Older than the ring means long committed. */
		local ok = true;
		foreach (r in this.w.ring) {
			if (r[0] == seq) ok = r[1] == 1;
		}
		this.Send({ t = "ack", seq = seq, ok = ok });
		return;
	}

	local expect = this.w.last + 1;
	local why = null;
	if (this.w.game == null) why = "game_mismatch";
	else if (this.held) why = "held";
	else if (!this.w.run || GSGame.IsPaused()) why = "paused";
	else if (seq != expect) why = "gap";
	if (why != null) {
		this.Send({ t = "nack", seq = seq, expect = expect, r = why });
		return;
	}

	this.LoanInit();
	this.ackP = null;
	local failed = this.Apply(m);

	this.w.last = seq;
	this.w.ring.append([seq, failed == null ? 1 : 0]);
	if (this.w.ring.len() > EDU_RING) this.w.ring.remove(0);

	local ack = { t = "ack", seq = seq, ok = failed == null };
	if (failed != null) ack.r <- failed;
	else if (this.ackP != null) ack.p <- this.ackP; // mayor ops: what was actually applied
	this.Send(ack);
}

/** @return null when applied, else the failure reason (the seq is consumed either way). */
function EduMiseDane::Apply(m)
{
	local k = this.F(m, "k");
	if (k == "noop") return null;

	local p = this.F(m, "p"), v = this.F(m, "v");
	/* Mayor ops without a company run before the bind check (D21). */
	switch (k) {
		case "tax": return this.MayorTax(v);
		case "news": return this.MayorNews(v);
		case "expand": return this.MayorExpand(v, p);
	}

	local c = this.F(m, "c"), s = this.F(m, "s");
	/* Only the slot's own company: a stale or foreign binding never gets the money. */
	if (!this.Exists(c) || !(c in this.w.bind) || this.w.bind[c] != s) return "no_company";

	switch (k) {
		case "grant":
			return this.MayorGrant(c, p);

		case "fine":
			return this.MayorFine(c, p);

		case "deposit":
		case "rescue":
			/* A rescue leaves needMonth alone: it lands exactly on the trigger line, so the
			 * next day's costs would ask again. The next need comes in a later month. */
			if (typeof p != "integer" || p <= 0 || !this.Give(c, p)) return "invalid";
			GSNews.Create(GSNews.NT_ECONOMY,
				(k == "deposit" ? "Vklad z peněženky: " : "Záchranná půjčka: ") + this.Kc(p) + " Kč",
				c, GSNews.NR_NONE, 0);
			return null;

		case "colour":
			if (typeof v != "integer" || v < 0 || v > 15) return "invalid";
			return this.SetColourAs(c, v) ? null : "colour_taken";

		case "rename":
			if (typeof v != "string" || v.len() == 0) return "invalid";
			return this.SetNameAs(c, v);

		case "advert":
			return this.PaidTownAction(c, v, GSTown.TOWN_ACTION_ADVERTISE_LARGE);

		case "statue":
			return this.PaidTownAction(c, v, GSTown.TOWN_ACTION_BUILD_STATUE);
	}
	return "invalid";
}

/**
 * The pupil paid in diamonds, so the game money for the action is lent for the moment
 * and taken back: OpenTTD wants cash >= cost, hence d = max(cost, cost - cash). The take-back
 * is unconditional, so nothing the pupil does in between can keep the injected money.
 */
function EduMiseDane::PaidTownAction(c, town, action)
{
	if (typeof town != "integer" || !GSTown.IsValidTown(town)) return "action_unavailable";

	local cost = GSTown.GetTownActionCost(action);
	local cash = GSCompany.GetBankBalance(c);
	local d = max(cost, cost - cash);
	if (!this.Give(c, d)) return "action_unavailable";

	local ok = this.TownActionAs(c, town, action);
	local back = ok ? d - cost : d;
	if (back > 0) this.Give(c, -back);
	return ok ? null : "action_unavailable";
}

/* ------------------------------------------------------ loan and rescue */

/**
 * New companies start at 0 cash / 0 loan: top up to the loan, then repay it all.
 * The top-up absorbs only native charges; a bigger gap is pupil spending, which must
 * not come back as free money, so it goes to a human (ok:false).
 */
function EduMiseDane::LoanInit()
{
	foreach (c, _ in clone this.w.loanPending) {
		if (!this.Exists(c)) {
			delete this.w.loanPending[c];
			continue;
		}
		local f = this.Money(c);
		local delta = f.loan - f.cash;
		if (delta <= EDU_NATIVE_CHARGES && -delta <= GSCompany.GetLoanInterval()
				&& (delta == 0 || this.Give(c, delta)) && this.RepayLoan(c)) {
			f = this.Money(c);
			if (f.cash == 0 && f.loan == 0) {
				delete this.w.loanPending[c];
				this.w.inited[c] <- true;
				this.Send({ t = "loaninit", c = c, ok = true, cash = 0, loan = 0 });
				continue;
			}
		}
		if (!(c in this.loanFailSent)) {
			/* No partial repayment; a human looks at it. We retry every loop anyway. */
			this.loanFailSent[c] <- true;
			this.Send({ t = "loaninit", c = c, ok = false, cash = f.cash, loan = f.loan });
		}
	}
}

/**
 * Start capital (setting `kapital`, Kč, game money is pounds): a one-off gift to each company once its loan-init
 * is done, so a team can build its first line before any deposit. Not an op, not in the wallet.
 * ponytail: marked before the gift, so a save landing mid-command loses it rather than paying twice.
 */
function EduMiseDane::Kapital()
{
	local p = GSController.GetSetting("kapital") / EDU_CZK;
	foreach (c, _ in clone this.w.inited) {
		if (c in this.w.kapital) continue;
		this.w.kapital[c] <- true;
		if (p > 0 && this.Exists(c)) this.Give(c, p);
	}
}

/**
 * OpenTTD counts a company as insolvent when cash - loan < -maxLoan. Ask for a rescue
 * before that, with a buffer of one month of last quarter's expenses.
 */
function EduMiseDane::CheckNeeds(month)
{
	foreach (c in this.Companies()) {
		local f = this.Money(c);
		local b = this.NeedBuffer(c);
		if (f.cash - f.loan >= -f.ml + b) continue;
		if (c in this.needMonth && this.needMonth[c] == month) continue;

		this.needMonth[c] <- month;
		this.Send({ t = "need", c = c, cash = f.cash, loan = f.loan, ml = f.ml, p = f.loan - f.ml - f.cash + b });
	}
}

/** B: one month of last quarter's expenses, at least EDU_MIN_BUFFER (rescue need and fine clip). */
function EduMiseDane::NeedBuffer(c)
{
	local spent = -GSCompany.GetQuarterlyExpenses(c, 1);
	return max(EDU_MIN_BUFFER, (spent + 2) / 3);
}

/* ------------------------------------------------------- mayor and city */

/**
 * The mayor's town (news board): w.citadela when still valid, else the town named
 * "Citadela", else the largest. Null when the map has no town.
 */
function EduMiseDane::Citadela()
{
	local t = ("citadela" in this.w) ? this.w.citadela : null;
	if (typeof t == "integer" && GSTown.IsValidTown(t)) return t;
	t = null;
	foreach (id, _ in GSTownList()) {
		if (GSTown.GetName(id) == "Citadela") { t = id; break; }
	}
	if (t == null) {
		local best = -1;
		foreach (id, _ in GSTownList()) {
			local pop = GSTown.GetPopulation(id);
			if (pop > best) { best = pop; t = id; }
		}
	}
	this.w.citadela <- t;
	return t;
}

/**
 * Tax bookkeeping (D23): only the part the company could actually pay out of positive
 * cash goes to the treasury; a refund (castka < 0) comes out of it in full, may go negative.
 */
function EduMiseDane::DoPokladny(firma, castka)
{
	local zaplaceno = castka < 0 ? castka : min(castka, max(0, this.Money(firma).cash));
	this.w.pokladna += zaplaceno;
	this.w.rozpocet.dane += zaplaceno;
}

function EduMiseDane::RocniRozpocet(rok)
{
	local r = this.w.rozpocet;
	GSNews.Create(GSNews.NT_GENERAL, "Městský rozpočet " + rok + ": daně " + this.Kc(r.dane) + " Kč, dotace "
		+ this.Kc(r.dotace) + " Kč, pokuty " + this.Kc(r.pokuty) + " Kč, stavby " + this.Kc(r.stavby)
		+ " Kč, pokladna " + this.Kc(this.w.pokladna) + " Kč.", GSCompany.COMPANY_INVALID, GSNews.NR_NONE, 0);
	this.w.rozpocet = { dane = 0, dotace = 0, pokuty = 0, stavby = 0 };
}

function EduMiseDane::MayorTax(v)
{
	if (typeof v != "integer" || v < 0 || v > EDU_MAX_TAX) return "invalid";
	this.sazba = v;
	GSNews.Create(GSNews.NT_GENERAL, "Starosta nastavil daň na " + v + " %.", GSCompany.COMPANY_INVALID, GSNews.NR_NONE, 0);
	return null;
}

function EduMiseDane::MayorNews(v)
{
	if (typeof v != "string" || v.len() == 0 || v.len() > EDU_MAX_NEWS_BYTES) return "invalid";
	GSNews.Create(GSNews.NT_GENERAL, v, GSCompany.COMPANY_INVALID, GSNews.NR_NONE, 0);
	local t = this.Citadela();
	if (t != null) GSTown.SetText(t, v);
	return null;
}

/** ExpandTown reports success even when nothing was built: charge only built houses. */
function EduMiseDane::MayorExpand(town, houses)
{
	if (typeof town != "integer" || !GSTown.IsValidTown(town)) return "invalid";
	if (typeof houses != "integer" || houses < 1 || houses > EDU_MAX_HOUSES) return "invalid";
	if (houses * EDU_DUM > this.w.pokladna) return "treasury_empty";
	local h0 = GSTown.GetHouseCount(town);
	GSTown.ExpandTown(town, houses);
	local n = max(0, GSTown.GetHouseCount(town) - h0);
	if (n == 0) return "action_unavailable";
	this.w.pokladna -= n * EDU_DUM;
	this.w.rozpocet.stavby += n * EDU_DUM;
	this.ackP = n;
	return null;
}

function EduMiseDane::MayorGrant(c, p)
{
	if (typeof p != "integer" || p < 1) return "invalid";
	if (this.w.pokladna < p) return "treasury_empty";
	if (!this.Give(c, p)) return "invalid";
	this.w.pokladna -= p;
	this.w.rozpocet.dotace += p;
	GSNews.Create(GSNews.NT_ECONOMY, "Dotace od starosty: " + this.Kc(p) + " Kč", c, GSNews.NR_NONE, 0);
	this.ackP = p;
	return null;
}

/**
 * Clipped so the company stays on/above the rescue line (no `need` next day) and its
 * cash never goes below 0.
 */
function EduMiseDane::MayorFine(c, p)
{
	if (typeof p != "integer" || p < 1) return "invalid";
	local f = this.Money(c);
	local room = f.cash - f.loan + f.ml - this.NeedBuffer(c);
	local pp = min(p, min(max(0, room), max(0, f.cash)));
	if (pp == 0) return "nothing_to_fine";
	if (!this.Give(c, -pp)) return "invalid";
	this.w.pokladna += pp;
	this.w.rozpocet.pokuty += pp;
	GSNews.Create(GSNews.NT_ECONOMY, "Pokuta od starosty: " + this.Kc(pp) + " Kč", c, GSNews.NR_NONE, 0);
	this.ackP = pp;
	return null;
}

/* -------------------------------------------------------------- reports */

function EduMiseDane::SendState()
{
	local co = [];
	foreach (c, s in this.w.bind) co.append([c, s]);
	this.Send({ t = "state", v = 1, game = this.w.game, last = this.w.last, ring = this.w.ring, co = co,
		run = this.w.run, paused = GSGame.IsPaused(), date = this.DateStr(), sid = this.w.sid });
}

/** Pages keep every message under the 1450 byte admin limit. */
function EduMiseDane::SendPages(t, key, items, perPage, extra, first = null)
{
	local pgs = (items.len() + perPage - 1) / perPage;
	if (pgs == 0) pgs = 1;
	for (local pg = 0; pg < pgs; pg++) {
		local msg = { t = t, pg = pg, pgs = pgs };
		foreach (k, v in extra) msg[k] <- v;
		if (pg == 0 && first != null) foreach (k, v in first) msg[k] <- v;
		msg[key] <- items.slice(pg * perPage, min(items.len(), (pg + 1) * perPage));
		this.Send(msg);
	}
}

function EduMiseDane::SendFin()
{
	local fin = [], names = [];
	foreach (c in this.Companies()) {
		fin.append(this.FinOf(c));
		names.append([c, GSCompany.GetName(c)]);
	}
	this.SendPages("fin", "co", fin, 10, { d = this.DateStr() }, { pokl = this.w.pokladna });
	this.SendPages("names", "co", names, 5, {});
}

function EduMiseDane::SendTowns()
{
	local towns = [];
	foreach (t, _ in GSTownList()) towns.append([t, GSTown.GetName(t)]);
	this.SendPages("towns", "tw", towns, 10, {});
}

/* ---------------------------------------------------------------- tests */

/**
 * Only with setting `ladeni` = 1 (the local test harness, never the server config):
 * {"t":"debug","c":3,"p":-500,"reinit":true} changes cash and optionally re-arms loan-init,
 * {"t":"debug","what":"dump"} reports the unsent state, {"t":"debug","pokl":0} sets the treasury,
 * {"t":"debug","c":3,"tax":700} books a tax (negative = refund) like a quarterly/yearly settlement,
 * {"t":"debug","what":"legacy"} drops pokladna/rozpocet so the next save looks like an old one.
 */
function EduMiseDane::OnDebug(m)
{
	if (this.F(m, "what") == "dump") {
		local inited = [], pending = [];
		foreach (c, _ in this.w.inited) inited.append(c);
		foreach (c, _ in this.w.loanPending) pending.append(c);
		this.Send({ t = "debug", inited = inited, pending = pending, held = this.held, run = this.w.run,
			pokl = this.w.pokladna, sazba = this.sazba, citadela = this.w.citadela });
		return;
	}
	if (this.F(m, "what") == "legacy") {
		delete this.w.pokladna;
		delete this.w.rozpocet;
		this.Send({ t = "debug", ok = true });
		return;
	}
	if (typeof this.F(m, "tax") == "integer") {
		local ok = this.Exists(this.F(m, "c")) && !GSGame.IsPaused();
		if (ok) this.Uctuj(m.c, m.tax, "Test daně");
		this.Send({ t = "debug", ok = ok });
		return;
	}
	if (typeof this.F(m, "pokl") == "integer") {
		this.w.pokladna = m.pokl;
		this.Send({ t = "debug", ok = true });
		return;
	}
	local c = this.F(m, "c"), p = this.F(m, "p");
	local ok = this.Exists(c) && !GSGame.IsPaused();
	if (ok && typeof p == "integer" && p != 0) ok = this.Give(c, p);
	if (ok && this.F(m, "reinit") == true) {
		if (c in this.w.inited) delete this.w.inited[c];
		if (c in this.loanFailSent) delete this.loanFailSent[c];
		this.w.loanPending[c] <- true;
	}
	this.Send({ t = "debug", ok = ok });
}
