/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/** @file test_edu_wallet.cpp EduCraft wallet mode: command gate, admission, loan step and in-game deposit amounts. */

#include "../stdafx.h"

#include "../3rdparty/catch2/catch.hpp"

#include "../network/network_edu.h"
#include "../command_func.h"
#include "../town_cmd.h"
#include "../economy_type.h"
#include "../edu_wallet_gui.h"
#include "../settings_internal.h"
#include "../map_type.h"

#include "../safeguards.h"

static CommandDataBuffer TownActionData(TownAction action)
{
	return EndianBufferWriter<CommandDataBuffer>::FromValue(CommandTraits<Commands::TownAction>::Args{TownID{3}, action});
}

TEST_CASE("EduIsGatedCommand - paid cosmetics and money transfers")
{
	CHECK(EduIsGatedCommand(Commands::RenameCompany, {}));
	CHECK(EduIsGatedCommand(Commands::RenamePresident, {}));
	CHECK(EduIsGatedCommand(Commands::SetCompanyColour, {}));
	CHECK(EduIsGatedCommand(Commands::SetGroupLivery, {}));
	CHECK(EduIsGatedCommand(Commands::GiveMoney, {}));
	CHECK(EduIsGatedCommand(Commands::BuyCompany, {}));

	CHECK(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::AdvertiseSmall)));
	CHECK(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::AdvertiseMedium)));
	CHECK(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::AdvertiseLarge)));
	CHECK(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::BuildStatue)));
}

TEST_CASE("EduIsGatedCommand - ordinary play is untouched")
{
	CHECK_FALSE(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::RoadRebuild)));
	CHECK_FALSE(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::FundBuildings)));
	CHECK_FALSE(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::BuyRights)));
	CHECK_FALSE(EduIsGatedCommand(Commands::TownAction, TownActionData(TownAction::Bribe)));
	CHECK_FALSE(EduIsGatedCommand(Commands::SetCompanyManagerFace, {}));
	CHECK_FALSE(EduIsGatedCommand(Commands::IncreaseLoan, {}));
	CHECK_FALSE(EduIsGatedCommand(Commands::CompanyControl, {}));
}

TEST_CASE("EduMayMove - only to the admitted company or to spectators")
{
	const CompanyID own{2};
	const CompanyID foreign{5};

	CHECK_FALSE(EduMayMove(nullptr, own));
	CHECK_FALSE(EduMayMove(nullptr, COMPANY_SPECTATOR));

	EduAdmission company{EduAdmission::Kind::Company, own};
	CHECK(EduMayMove(&company, own));
	CHECK(EduMayMove(&company, COMPANY_SPECTATOR));
	CHECK_FALSE(EduMayMove(&company, foreign));

	EduAdmission spectator{EduAdmission::Kind::Spectator, CompanyID::Invalid()};
	CHECK(EduMayMove(&spectator, COMPANY_SPECTATOR));
	CHECK_FALSE(EduMayMove(&spectator, own));

	EduAdmission fresh{EduAdmission::Kind::New, CompanyID::Invalid()};
	CHECK(EduMayMove(&fresh, COMPANY_SPECTATOR));
	CHECK_FALSE(EduMayMove(&fresh, own));
}

TEST_CASE("EduConsumeNewCompany - one company per 'new' admission, none without one")
{
	const ClientID pupil{1001};
	const ClientID stranger{1002};

	CHECK_FALSE(EduConsumeNewCompany(stranger));

	EduSetAdmission(pupil, {EduAdmission::Kind::New, CompanyID::Invalid()});
	CHECK(EduConsumeNewCompany(pupil));
	CHECK_FALSE(EduConsumeNewCompany(pupil));
	CHECK(EduGetAdmission(pupil) == nullptr);

	EduSetAdmission(pupil, {EduAdmission::Kind::Company, CompanyID{1}});
	CHECK_FALSE(EduConsumeNewCompany(pupil));
	REQUIRE(EduGetAdmission(pupil) != nullptr);

	EduForgetClient(pupil);
	CHECK(EduGetAdmission(pupil) == nullptr);
}

TEST_CASE("EduForgetCompany - a removed company's id gives no way into its successor")
{
	const ClientID holder{1003};
	const ClientID other{1004};
	const CompanyID removed{3};
	const CompanyID kept{4};

	EduSetAdmission(holder, {EduAdmission::Kind::Company, removed});
	EduSetAdmission(other, {EduAdmission::Kind::Company, kept});
	EduForgetCompany(removed);

	CHECK_FALSE(EduMayMove(EduGetAdmission(holder), removed));
	CHECK(EduMayMove(EduGetAdmission(holder), COMPANY_SPECTATOR));
	CHECK(EduMayMove(EduGetAdmission(other), kept));

	EduForgetClient(holder);
	EduForgetClient(other);
}

TEST_CASE("LOAN_INTERVAL - the pilot max loan is exactly four steps")
{
	CHECK(LOAN_INTERVAL == 75000);
	CHECK(4 * LOAN_INTERVAL == 300000);
}

TEST_CASE("EduDepositKc - one diamond is 250 100 Kč, tenths exact")
{
	CHECK(EduDepositKc(0) == "0");
	CHECK(EduDepositKc(1) == "25 010");
	CHECK(EduDepositKc(10) == "250 100");
	CHECK(EduDepositKc(2000) == "50 020 000"); /* 200 diamonds */
	CHECK(EduFormatTenths(0) == "0,0");
	CHECK(EduFormatTenths(123) == "12,3");
	CHECK(EduFormatTenths(-5) == "-0,5");
}

TEST_CASE("EduDepositKc - large deposits keep exact Kč and digit groups")
{
	CHECK(EduDepositKc(5) == "125 050"); /* half a diamond */
	CHECK(EduDepositKc(50) == "1 250 500");
	CHECK(EduDepositKc(492) == "12 304 920"); /* ~49,2 diamonds = the 12 300 000 Kč max loan */
	CHECK(EduDepositKc(4000) == "100 040 000");
	CHECK(EduDepositKc(1000000) == "25 010 000 000"); /* beyond int32 Kč: no overflow */
	CHECK(EduDepositKc(39999) == "1 000 374 990"); /* every tenth adds exactly 25 010 Kč */
}

TEST_CASE("EduFormatTenths - one decimal, Czech comma, no rounding")
{
	CHECK(EduFormatTenths(1) == "0,1");
	CHECK(EduFormatTenths(9) == "0,9");
	CHECK(EduFormatTenths(10) == "1,0");
	CHECK(EduFormatTenths(19) == "1,9");
	CHECK(EduFormatTenths(-123) == "-12,3");
	CHECK(EduFormatTenths(1000000) == "100000,0");
}

TEST_CASE("Edu settings - the class server config fits the setting ranges")
{
	/* educraft/server/openttd.cfg: map_x = map_y = 12, max_join_time = max_download_time = 4000. */
	const SettingDesc *map_x = GetSettingFromName("game_creation.map_x");
	REQUIRE(map_x != nullptr);
	CHECK(std::get<1>(map_x->AsIntSetting()->GetRange()) >= 12);
	CHECK(MAX_MAP_SIZE == 4096);
	for (const char *name : {"network.max_join_time", "network.max_download_time"}) {
		const SettingDesc *sd = GetSettingFromName(name);
		REQUIRE(sd != nullptr);
		CHECK(std::get<1>(sd->AsIntSetting()->GetRange()) >= 4000);
	}
}

TEST_CASE("Edu settings - prefer_sprite_font defaults to the sprite font")
{
#if defined(WITH_FREETYPE) || defined(_WIN32) || defined(WITH_COCOA)
	const SettingDesc *sd = GetSettingFromName("prefer_sprite_font");
	REQUIRE(sd != nullptr);
	REQUIRE(sd->IsIntSetting());
	CHECK(sd->AsIntSetting()->IsBoolSetting());
	CHECK(sd->AsIntSetting()->GetDefaultValue() == 1);
#else
	/* Builds without TrueType (the dedicated server) have no font setting; the web client has. */
	CHECK(GetSettingFromName("prefer_sprite_font") == nullptr);
#endif
}
