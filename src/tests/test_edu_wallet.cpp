/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/** @file test_edu_wallet.cpp EduCraft wallet mode: command gate, admission and loan step. */

#include "../stdafx.h"

#include "../3rdparty/catch2/catch.hpp"

#include "../network/network_edu.h"
#include "../command_func.h"
#include "../town_cmd.h"
#include "../economy_type.h"

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

TEST_CASE("LOAN_INTERVAL - the pilot max loan is exactly four steps")
{
	CHECK(LOAN_INTERVAL == 3481);
	CHECK(4 * LOAN_INTERVAL == 13924);
}
