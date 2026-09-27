/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/**
 * @file network_edu.h EduCraft wallet mode (network.edu_wallet_mode), server side only.
 *
 * Paid cosmetics and money transfers are dropped when a client sends them; only the
 * GameScript (which never passes ReceiveClientCommand) applies them after the pupil paid
 * in the wallet. Company membership is decided by the bridge through `edu_admit`.
 */

#ifndef NETWORK_EDU_H
#define NETWORK_EDU_H

#include "../command_type.h"
#include "../company_type.h"
#include "network_type.h"

/** What a client may join, set by the `edu_admit` console command. */
struct EduAdmission {
	enum class Kind : uint8_t { Spectator, New, Company };
	Kind kind = Kind::Spectator;
	CompanyID company = CompanyID::Invalid(); ///< Only for Kind::Company.
};

/** Chat line sent to a client whose gated command was dropped. */
static constexpr std::string_view EDU_GATED_MESSAGE = "Tuto úpravu kupuješ v peněžence EduMise (#/penezenka).";

bool EduIsGatedCommand(Commands cmd, const CommandDataBuffer &data);
bool EduMayMove(const EduAdmission *admission, CompanyID target);

void EduSetAdmission(ClientID client_id, EduAdmission admission);
const EduAdmission *EduGetAdmission(ClientID client_id);
bool EduConsumeNewCompany(ClientID client_id);
void EduForgetClient(ClientID client_id);

#endif /* NETWORK_EDU_H */
