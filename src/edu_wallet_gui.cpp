/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/**
 * @file edu_wallet_gui.cpp EduMise Doprava: in-game wallet window.
 *
 * The pupil deposits wallet diamonds into their company without leaving the game. The game never
 * sees the pupil's token: the window asks the gate page (educraft/brana.js) through
 * os/emscripten/pre.js and postMessage, the gate calls the wallet (GET /me, POST /me/deposits) and
 * posts the result back. The money itself reaches the company only through the wallet op and the
 * GameScript (contract §2.3, §4.4), like every other deposit. Texts are raw Czech strings, so the
 * language files stay untouched (the web build is Czech only).
 */

#include "stdafx.h"
#include "edu_wallet_gui.h"
#include "window_func.h"
#include "window_gui.h"
#include "gfx_func.h"
#include "string_func.h"
#include "core/format.hpp"

#include "table/strings.h"

#ifdef __EMSCRIPTEN__
#	include <emscripten.h>
#endif

#include "safeguards.h"

/** Contract §7.2: one tenth of a diamond is exactly £610 in game (1 💎 = 250 100 Kč), no remainder. */
static constexpr int64_t EDU_POUNDS_PER_TENTH = 610;
/** OpenTTD's CZK multiplier; Kč is what the game shows. */
static constexpr int64_t EDU_CZK_PER_POUND = 41;
/** A deposit without an answer for this long gets a "still working" note (it stays locked). */
static constexpr uint EDU_SLOW_DEPOSIT_MS = 20000;
/** The open window asks for a fresh state this often: a new company, diamonds from the teacher. */
static constexpr uint EDU_REFRESH_MS = 10000;

/**
 * Last wallet state the gate reported. Global, not per window: a deposit stays pending when the
 * window is closed and reopened, so the pupil cannot send the same deposit twice. Only the gate's
 * answer to that deposit ends it; the gate itself never runs two deposits at once.
 */
struct EduWalletState {
	int wallet_tenths = -1; ///< Diamonds in the wallet in tenths, -1 while unknown.
	bool has_company = false; ///< The pupil's team has a company bound in the wallet.
	bool deposit_pending = false; ///< A deposit is out and its answer has not come back.
	uint deposit_ms = 0; ///< How long the pending deposit has been out.
	std::string message; ///< Result of the last deposit, may be empty.
	std::string load_error; ///< Why the last state could not be read, empty when it could.
};

static EduWalletState _edu_wallet;

/** `123` → `"12,3"`: always one decimal, Czech comma. */
std::string EduFormatTenths(int64_t tenths)
{
	std::string s = fmt::format("{},{}", std::abs(tenths) / 10, std::abs(tenths) % 10);
	return tenths < 0 ? "-" + s : s;
}

/** Kč the company gets for a deposit, thousands separated by spaces: `50` → `"1 250 500"`. */
std::string EduDepositKc(int64_t tenths)
{
	std::string digits = fmt::format("{}", tenths * EDU_POUNDS_PER_TENTH * EDU_CZK_PER_POUND);
	std::string out;
	for (size_t i = 0; i < digits.size(); i++) {
		if (i > 0 && (digits.size() - i) % 3 == 0) out += ' ';
		out += digits[i];
	}
	return out;
}

/** Ask the gate for the wallet state (0) or to deposit this many tenths. */
static void EduWalletAsk([[maybe_unused]] int amount_tenths)
{
#ifdef __EMSCRIPTEN__
	EM_ASM({ if (Module.eduWallet) Module.eduWallet($0); }, amount_tenths);
#endif
}

/** True in a class game in the browser, where the gate can reach the wallet. */
bool EduWalletAvailable()
{
#ifdef __EMSCRIPTEN__
	return EM_ASM_INT({ return Module.eduWallet ? 1 : 0; }) != 0;
#else
	return false;
#endif
}

enum EduWalletWidgets : WidgetID {
	WID_EW_CAPTION, ///< Window caption.
	WID_EW_INFO, ///< Balance, chosen amount and its value in Kč.
	WID_EW_MINUS_10, ///< Ten diamonds less.
	WID_EW_MINUS_1, ///< One diamond less.
	WID_EW_PLUS_1, ///< One diamond more.
	WID_EW_PLUS_10, ///< Ten diamonds more.
	WID_EW_ALL, ///< Everything in the wallet.
	WID_EW_DEPOSIT, ///< Send the deposit.
	WID_EW_STATUS, ///< Result of the last request and a note.
};

struct EduWalletWindow : Window {
	int amount_tenths = 0; ///< Amount the pupil chose to deposit.
	uint refresh_ms = 0; ///< Time since the last state request.

	EduWalletWindow(WindowDesc &desc) : Window(desc)
	{
		this->InitNested(0);
		if (!_edu_wallet.deposit_pending) _edu_wallet.message.clear();
		EduWalletAsk(0);
		this->OnInvalidateData();
	}

	std::string GetWidgetString(WidgetID widget, StringID stringid) const override
	{
		switch (widget) {
			case WID_EW_CAPTION: return "Peněženka – vklad do firmy";
			case WID_EW_MINUS_10: return "-10";
			case WID_EW_MINUS_1: return "-1";
			case WID_EW_PLUS_1: return "+1";
			case WID_EW_PLUS_10: return "+10";
			case WID_EW_ALL: return "Vše";
			case WID_EW_DEPOSIT: return "Vložit do firmy";
			default: return this->Window::GetWidgetString(widget, stringid);
		}
	}

	/** The three lines of the info panel. */
	std::array<std::string, 3> InfoLines() const
	{
		const EduWalletState &s = _edu_wallet;
		return {
			s.wallet_tenths < 0 ? std::string{s.load_error.empty() ? "Diamanty v peněžence: načítám…" : "Diamanty v peněžence: nevím"}
				: "Diamanty v peněžence: " + EduFormatTenths(s.wallet_tenths),
			"Vložit do firmy: " + EduFormatTenths(this->amount_tenths),
			"Firma dostane: " + EduDepositKc(this->amount_tenths) + " Kč",
		};
	}

	static constexpr std::string_view NOTE = "Vklad se do peněženky nevrací – zpět přijde až prodej firmy na konci roku.";

	void UpdateWidgetSize(WidgetID widget, Dimension &size, [[maybe_unused]] const Dimension &padding, [[maybe_unused]] Dimension &fill, [[maybe_unused]] Dimension &resize) override
	{
		/* Widest realistic lines; the status wraps inside this width. */
		const int width = std::max(GetStringBoundingBox("Diamanty v peněžence: 99 999,9").width, GetStringBoundingBox("Firma dostane: 999 999 999 Kč").width) + WidgetDimensions::scaled.framerect.Horizontal();
		const int line = GetCharacterHeight(FontSize::Normal);
		switch (widget) {
			case WID_EW_INFO:
				size.width = std::max<uint>(size.width, width);
				size.height = 3 * line + 2 * WidgetDimensions::scaled.vsep_normal + WidgetDimensions::scaled.framerect.Vertical();
				break;
			case WID_EW_STATUS:
				size.width = std::max<uint>(size.width, width);
				size.height = 6 * line + WidgetDimensions::scaled.vsep_wide + WidgetDimensions::scaled.framerect.Vertical();
				break;
		}
	}

	void DrawWidget(const Rect &r, WidgetID widget) const override
	{
		Rect ir = r.Shrink(WidgetDimensions::scaled.framerect);
		switch (widget) {
			case WID_EW_INFO:
				for (const std::string &l : this->InfoLines()) {
					DrawString(ir, l, TextColour::Black);
					ir.top += GetCharacterHeight(FontSize::Normal) + WidgetDimensions::scaled.vsep_normal;
				}
				break;

			case WID_EW_STATUS: {
				const EduWalletState &s = _edu_wallet;
				std::string_view status = s.message;
				if (s.deposit_pending) {
					status = s.deposit_ms < EDU_SLOW_DEPOSIT_MS ? "Odesílám vklad…" : "Vklad se ještě zpracovává, chvíli počkej.";
				} else if (!s.load_error.empty()) {
					status = s.load_error;
				} else if (status.empty() && s.wallet_tenths >= 0 && !s.has_company) {
					status = "Nejdřív si ve hře založ firmu.";
				} else if (status.empty() && s.has_company && s.wallet_tenths > 0 && this->amount_tenths == 0) {
					/* The window opens at 0, so the deposit button is greyed out and pupils took it as broken.
					 * Deliberately no pre-filled amount: a deposit can't be undone. */
					status = "Vyber, kolik diamantů vložíš (+1, +10 nebo Vše).";
				}
				if (!status.empty()) {
					ir.top = DrawStringMultiLine(ir, status, TextColour::Black) + WidgetDimensions::scaled.vsep_wide;
				}
				DrawStringMultiLine(ir, NOTE, TextColour::Grey);
				break;
			}
		}
	}

	void OnClick([[maybe_unused]] Point pt, WidgetID widget, [[maybe_unused]] int click_count) override
	{
		const int max = std::max(_edu_wallet.wallet_tenths, 0);
		switch (widget) {
			case WID_EW_MINUS_10: this->amount_tenths -= 100; break;
			case WID_EW_MINUS_1: this->amount_tenths -= 10; break;
			case WID_EW_PLUS_1: this->amount_tenths += 10; break;
			case WID_EW_PLUS_10: this->amount_tenths += 100; break;
			case WID_EW_ALL: this->amount_tenths = max; break;
			case WID_EW_DEPOSIT:
				if (this->IsWidgetDisabled(WID_EW_DEPOSIT) || _edu_wallet.deposit_pending) return;
				_edu_wallet.deposit_pending = true;
				_edu_wallet.deposit_ms = 0;
				_edu_wallet.message.clear();
				EduWalletAsk(this->amount_tenths);
				this->amount_tenths = 0;
				break;
			default: return;
		}
		this->amount_tenths = Clamp(this->amount_tenths, 0, max);
		this->OnInvalidateData();
	}

	void OnRealtimeTick(uint delta_ms) override
	{
		EduWalletState &s = _edu_wallet;
		if (s.deposit_pending) {
			const bool was_slow = s.deposit_ms >= EDU_SLOW_DEPOSIT_MS;
			s.deposit_ms += delta_ms;
			if (!was_slow && s.deposit_ms >= EDU_SLOW_DEPOSIT_MS) this->SetDirty();
			return;
		}
		this->refresh_ms += delta_ms;
		if (this->refresh_ms < EDU_REFRESH_MS) return;
		this->refresh_ms = 0;
		EduWalletAsk(0);
	}

	void OnInvalidateData([[maybe_unused]] int data = 0, [[maybe_unused]] bool gui_scope = true) override
	{
		const EduWalletState &s = _edu_wallet;
		this->amount_tenths = Clamp(this->amount_tenths, 0, std::max(s.wallet_tenths, 0));
		const bool can_change = !s.deposit_pending && s.wallet_tenths > 0;
		this->SetWidgetsDisabledState(!can_change, WID_EW_MINUS_10, WID_EW_MINUS_1, WID_EW_PLUS_1, WID_EW_PLUS_10, WID_EW_ALL);
		this->SetWidgetDisabledState(WID_EW_DEPOSIT, !can_change || !s.has_company || this->amount_tenths <= 0);
		this->SetDirty();
	}
};

static constexpr std::initializer_list<NWidgetPart> _nested_edu_wallet_widgets = {
	NWidget(NWID_HORIZONTAL),
		NWidget(WWT_CLOSEBOX, Colours::Grey),
		NWidget(WWT_CAPTION, Colours::Grey, WID_EW_CAPTION),
		NWidget(WWT_STICKYBOX, Colours::Grey),
	EndContainer(),
	NWidget(WWT_PANEL, Colours::Grey),
		NWidget(NWID_VERTICAL), SetPadding(WidgetDimensions::unscaled.sparse), SetPIP(0, WidgetDimensions::unscaled.vsep_normal, 0),
			NWidget(WWT_EMPTY, Colours::Invalid, WID_EW_INFO), SetFill(1, 0),
			NWidget(NWID_HORIZONTAL, NWidContainerFlag::EqualSize),
				NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_MINUS_10), SetFill(1, 0),
				NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_MINUS_1), SetFill(1, 0),
				NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_PLUS_1), SetFill(1, 0),
				NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_PLUS_10), SetFill(1, 0),
				NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_ALL), SetFill(1, 0),
			EndContainer(),
			NWidget(WWT_PUSHTXTBTN, Colours::Grey, WID_EW_DEPOSIT), SetFill(1, 0), SetMinimalTextLines(2, 0),
			NWidget(WWT_EMPTY, Colours::Invalid, WID_EW_STATUS), SetFill(1, 0),
		EndContainer(),
	EndContainer(),
};

static WindowDesc _edu_wallet_desc(
	WindowPosition::Automatic, "edu_wallet", 0, 0,
	WindowClass::EduWallet, WindowClass::None,
	{},
	_nested_edu_wallet_widgets
);

void ShowEduWalletWindow()
{
	CloseWindowById(WindowClass::EduWallet, 0);
	new EduWalletWindow(_edu_wallet_desc);
}

#ifdef __EMSCRIPTEN__
extern "C" {

/**
 * Wallet state from the gate (os/emscripten/pre.js).
 * @param wallet_tenths Diamonds in the wallet in tenths, -1 when the gate could not read them.
 * @param flags Bit 0: the pupil's team has a company in the wallet. Bit 1: answer to a deposit.
 * @param message Deposit result, or why the state could not be read; empty when all is well.
 */
void CDECL em_openttd_edu_wallet(int wallet_tenths, int flags, const char *message)
{
	EduWalletState &s = _edu_wallet;
	if (wallet_tenths >= 0) {
		s.wallet_tenths = wallet_tenths;
		s.has_company = HasBit(flags, 0);
	}
	/* Only the gate writes it, but it is still text from outside: no control codes. */
	std::string text = message != nullptr ? StrMakeValid(std::string_view{message}) : std::string{};
	if (HasBit(flags, 1)) {
		s.deposit_pending = false;
		s.message = std::move(text);
	} else {
		s.load_error = std::move(text);
	}
	InvalidateWindowData(WindowClass::EduWallet, 0);
}

}
#endif
