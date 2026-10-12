#include "btga/btga_lobby.h"

#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static BtgaLobbyCommand selection(uint16_t vehicle, uint8_t team) {
    BtgaLobbyCommand result = {0};
    result.command_type = BTGA_LOBBY_CMD_SELECT;
    result.vehicle_id = vehicle;
    result.team_id = team;
    return result;
}

static BtgaLobbyCommand signal(uint8_t type, uint8_t value) {
    BtgaLobbyCommand result = {0};
    result.command_type = type;
    result.value = value;
    return result;
}

int main(void) {
    BtgaLobbyState host;
    BtgaLobbyState client;
    BtgaLobbyCommand command;
    BtgaLobbyCommand decoded_command;
    uint8_t snapshot[BTGA_LOBBY_SNAPSHOT_SIZE];
    uint8_t command_bytes[BTGA_LOBBY_COMMAND_SIZE];

    btga_lobby_init(&host, BTGA_LOBBY_RETAIL_MAX_PLAYERS);
    CHECK(host.phase == BTGA_LOBBY_ASSEMBLING);
    CHECK(!btga_lobby_begin_selection(&host, 2U, 3U));
    CHECK(btga_lobby_admit(&host, 0U));
    CHECK(btga_lobby_admit(&host, 1U));
    CHECK(!btga_lobby_admit(&host, 1U));
    CHECK(!btga_lobby_admit(&host, 4U));
    CHECK(btga_lobby_begin_selection(&host, 2U, 3U));

    command = selection(7U, 0U);
    CHECK(btga_lobby_apply_command(&host, 0U, &command));
    command = selection(12U, 1U);
    CHECK(btga_lobby_apply_command(&host, 1U, &command));
    command = signal(BTGA_LOBBY_CMD_READY, 1U);
    CHECK(btga_lobby_apply_command(&host, 0U, &command));
    CHECK(!btga_lobby_lock_and_load(&host, UINT32_C(0x12345678), 900U));
    CHECK(btga_lobby_apply_command(&host, 1U, &command));
    CHECK(btga_lobby_lock_and_load(&host, UINT32_C(0x12345678), 900U));
    CHECK(host.phase == BTGA_LOBBY_LOADING);

    CHECK(btga_lobby_encode_snapshot(snapshot, sizeof(snapshot), &host) ==
          sizeof(snapshot));
    CHECK(btga_lobby_decode_snapshot(&client, snapshot, sizeof(snapshot)));
    CHECK(client.connected_mask == 3U && client.ready_mask == 3U);
    CHECK(client.players[1].vehicle_id == 12U);
    CHECK(client.players[1].team_id == 1U);
    CHECK(client.random_seed == UINT32_C(0x12345678));
    CHECK(client.start_tick == 900U);

    command = signal(BTGA_LOBBY_CMD_LOADED, 1U);
    CHECK(btga_lobby_encode_command(command_bytes, sizeof(command_bytes),
                                    &command) == sizeof(command_bytes));
    CHECK(btga_lobby_decode_command(&decoded_command, command_bytes,
                                    sizeof(command_bytes)));
    CHECK(btga_lobby_apply_command(&host, 1U, &decoded_command));
    CHECK(host.phase == BTGA_LOBBY_LOADING);
    CHECK(btga_lobby_apply_command(&host, 0U, &decoded_command));
    CHECK(host.phase == BTGA_LOBBY_RUNNING);

    /* A client cannot impersonate another peer: caller supplies peer 1. */
    btga_lobby_init(&host, 4U);
    CHECK(btga_lobby_admit(&host, 0U));
    CHECK(btga_lobby_admit(&host, 1U));
    CHECK(btga_lobby_begin_selection(&host, 0U, 0U));
    command = selection(4U, 1U);
    CHECK(btga_lobby_apply_command(&host, 1U, &command));
    CHECK(host.players[0].selected == 0U);
    CHECK(host.players[1].selected == 1U);

    snapshot[4] = 4U;
    CHECK(!btga_lobby_decode_snapshot(&client, snapshot, sizeof(snapshot)));
    memset(command_bytes, 0, sizeof(command_bytes));
    CHECK(!btga_lobby_decode_command(&decoded_command, command_bytes,
                                     sizeof(command_bytes)));
    return 0;
}
