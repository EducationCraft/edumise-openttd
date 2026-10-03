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
			if (this.w.game == null && typeof this.F(m, "game") == "string") this.w.game = m.game;
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
	local failed = this.Apply(m);

	this.w.last = seq;
	this.w.ring.append([seq, failed == null ? 1 : 0]);
	if (this.w.ring.len() > EDU_RING) this.w.ring.remove(0);

	local ack = { t = "ack", seq = seq, ok = failed == null };
	if (failed != null) ack.r <- failed;
	this.Send(ack);
}

/** @return null when applied, else the failure reason (the seq is consumed either way). */
function EduMiseDane::Apply(m)
{
	local k = this.F(m, "k");
	if (k == "noop") return null;

	local c = this.F(m, "c"), s = this.F(m, "s");
	/* Only the slot's own company: a stale or foreign binding never gets the money. */
	if (!this.Exists(c) || !(c in this.w.bind) || this.w.bind[c] != s) return "no_company";

	local p = this.F(m, "p"), v = this.F(m, "v");
	switch (k) {
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
 * OpenTTD counts a company as insolvent when cash - loan < -maxLoan. Ask for a rescue
 * before that, with a buffer of one month of last quarter's expenses.
 */
function EduMiseDane::CheckNeeds(month)
{
	foreach (c in this.Companies()) {
		local f = this.Money(c);
		local spent = -GSCompany.GetQuarterlyExpenses(c, 1);
		local b = max(EDU_MIN_BUFFER, (spent + 2) / 3);
		if (f.cash - f.loan >= -f.ml + b) continue;
		if (c in this.needMonth && this.needMonth[c] == month) continue;

		this.needMonth[c] <- month;
		this.Send({ t = "need", c = c, cash = f.cash, loan = f.loan, ml = f.ml, p = f.loan - f.ml - f.cash + b });
	}
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
function EduMiseDane::SendPages(t, key, items, perPage, extra)
{
	local pgs = (items.len() + perPage - 1) / perPage;
	if (pgs == 0) pgs = 1;
	for (local pg = 0; pg < pgs; pg++) {
		local msg = { t = t, pg = pg, pgs = pgs };
		foreach (k, v in extra) msg[k] <- v;
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
	this.SendPages("fin", "co", fin, 10, { d = this.DateStr() });
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
 * {"t":"debug","what":"dump"} reports the unsent state.
 */
function EduMiseDane::OnDebug(m)
{
	if (this.F(m, "what") == "dump") {
		local inited = [], pending = [];
		foreach (c, _ in this.w.inited) inited.append(c);
		foreach (c, _ in this.w.loanPending) pending.append(c);
		this.Send({ t = "debug", inited = inited, pending = pending, held = this.held, run = this.w.run });
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
