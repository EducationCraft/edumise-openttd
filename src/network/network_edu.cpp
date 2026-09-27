/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/** @file network_edu.cpp EduCraft wallet mode: command gate and company admission. */

#include "../stdafx.h"
#include "network_edu.h"
#include "../command_func.h"
#include "../town_cmd.h"

#include <map>

#include "../safeguards.h"

/** Admission per connected client; an absent entry means "deny" for moves and new companies. */
static std::map<ClientID, EduAdmission> _edu_admissions;

/**
 * Is this client command one that only the wallet may trigger?
 * @param cmd The command.
 * @param data The command's parameters as received from the client.
 * @return True when the command must be dropped.
 */
bool EduIsGatedCommand(Commands cmd, const CommandDataBuffer &data)
{
	switch (cmd) {
		case Commands::RenameCompany:
		case Commands::RenamePresident: // renames an unnamed company as a side effect
		case Commands::SetCompanyColour:
		case Commands::GiveMoney:
		case Commands::BuyCompany:
			return true;

		case Commands::TownAction: {
			TownAction action = std::get<1>(EndianBufferReader::ToValue<CommandTraits<Commands::TownAction>::Args>(data));
			switch (action) {
				case TownAction::AdvertiseSmall:
				case TownAction::AdvertiseMedium:
				case TownAction::AdvertiseLarge:
				case TownAction::BuildStatue:
					return true;
				default:
					return false;
			}
		}

		default:
			return false;
	}
}

/**
 * May a client with this admission move to the given company?
 * @param admission The client's admission, or nullptr when it has none.
 * @param target The company to move to, or COMPANY_SPECTATOR.
 * @return True when the move is allowed.
 */
bool EduMayMove(const EduAdmission *admission, CompanyID target)
{
	if (admission == nullptr) return false;
	if (target == COMPANY_SPECTATOR) return true;
	return admission->kind == EduAdmission::Kind::Company && admission->company == target;
}

void EduSetAdmission(ClientID client_id, EduAdmission admission)
{
	_edu_admissions[client_id] = admission;
}

const EduAdmission *EduGetAdmission(ClientID client_id)
{
	auto it = _edu_admissions.find(client_id);
	return it == _edu_admissions.end() ? nullptr : &it->second;
}

/**
 * Use up a "new company" admission.
 * @param client_id The client that asks to found a company.
 * @return True when the client was admitted to found one; the admission is then gone.
 */
bool EduConsumeNewCompany(ClientID client_id)
{
	auto it = _edu_admissions.find(client_id);
	if (it == _edu_admissions.end() || it->second.kind != EduAdmission::Kind::New) return false;
	_edu_admissions.erase(it);
	return true;
}

void EduForgetClient(ClientID client_id)
{
	_edu_admissions.erase(client_id);
}
