#ifndef BTGA_LOBBY_H
#define BTGA_LOBBY_H

#include "btga/btga_net.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BTGA_LOBBY_VERSION 1U
#define BTGA_LOBBY_RETAIL_MAX_PLAYERS 4U
#define BTGA_LOBBY_NO_VEHICLE UINT16_MAX
#define BTGA_LOBBY_SNAPSHOT_SIZE 40U
#define BTGA_LOBBY_COMMAND_SIZE 8U

typedef enum BtgaLobbyPayloadType {
    BTGA_LOBBY_PAYLOAD_SNAPSHOT = 1,
    BTGA_LOBBY_PAYLOAD_COMMAND = 2
} BtgaLobbyPayloadType;

typedef enum BtgaLobbyPhase {
    BTGA_LOBBY_ASSEMBLING = 0,
    BTGA_LOBBY_SELECTING = 1,
    BTGA_LOBBY_LOADING = 2,
    BTGA_LOBBY_RUNNING = 3
} BtgaLobbyPhase;

typedef enum BtgaLobbyCommandType {
    BTGA_LOBBY_CMD_SELECT = 1,
    BTGA_LOBBY_CMD_READY = 2,
    BTGA_LOBBY_CMD_LOADED = 3
} BtgaLobbyCommandType;

typedef struct BtgaLobbySelection {
    uint16_t vehicle_id;
    uint8_t team_id;
    uint8_t selected;
} BtgaLobbySelection;

typedef struct BtgaLobbyState {
    uint8_t phase;
    uint8_t max_players;
    uint16_t connected_mask;
    uint16_t ready_mask;
    uint16_t loaded_mask;
    uint16_t map_id;
    uint16_t mode_id;
    uint32_t random_seed;
    uint32_t start_tick;
    BtgaLobbySelection players[BTGA_LOBBY_RETAIL_MAX_PLAYERS];
} BtgaLobbyState;

typedef struct BtgaLobbyCommand {
    uint8_t command_type;
    uint16_t vehicle_id;
    uint8_t team_id;
    uint8_t value;
} BtgaLobbyCommand;

void btga_lobby_init(BtgaLobbyState* lobby, uint8_t max_players);
int btga_lobby_admit(BtgaLobbyState* lobby, uint16_t peer_id);
int btga_lobby_remove(BtgaLobbyState* lobby, uint16_t peer_id);
int btga_lobby_begin_selection(BtgaLobbyState* lobby, uint16_t map_id,
                               uint16_t mode_id);
int btga_lobby_apply_command(BtgaLobbyState* lobby, uint16_t authenticated_peer,
                             const BtgaLobbyCommand* command);
int btga_lobby_lock_and_load(BtgaLobbyState* lobby, uint32_t random_seed,
                             uint32_t start_tick);
int btga_lobby_all_loaded(const BtgaLobbyState* lobby);

size_t btga_lobby_encode_snapshot(uint8_t* destination,
                                  size_t destination_size,
                                  const BtgaLobbyState* lobby);
int btga_lobby_decode_snapshot(BtgaLobbyState* lobby, const uint8_t* payload,
                               size_t payload_size);
size_t btga_lobby_encode_command(uint8_t* destination,
                                 size_t destination_size,
                                 const BtgaLobbyCommand* command);
int btga_lobby_decode_command(BtgaLobbyCommand* command,
                              const uint8_t* payload, size_t payload_size);

#ifdef __cplusplus
}
#endif

#endif
