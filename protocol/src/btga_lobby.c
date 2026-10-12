#include "btga/btga_lobby.h"

#include <string.h>

static void put_u16(uint8_t* output, uint16_t value) {
    output[0] = (uint8_t)(value >> 8);
    output[1] = (uint8_t)value;
}

static void put_u32(uint8_t* output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24);
    output[1] = (uint8_t)(value >> 16);
    output[2] = (uint8_t)(value >> 8);
    output[3] = (uint8_t)value;
}

static uint16_t get_u16(const uint8_t* input) {
    return (uint16_t)(((uint16_t)input[0] << 8) | input[1]);
}

static uint32_t get_u32(const uint8_t* input) {
    return ((uint32_t)input[0] << 24) | ((uint32_t)input[1] << 16) |
           ((uint32_t)input[2] << 8) | input[3];
}

static uint16_t player_mask(uint8_t max_players) {
    return (uint16_t)((UINT16_C(1) << max_players) - 1U);
}

static int valid_peer(const BtgaLobbyState* lobby, uint16_t peer_id) {
    return lobby != NULL && peer_id < lobby->max_players &&
           peer_id < BTGA_LOBBY_RETAIL_MAX_PLAYERS;
}

static unsigned int bit_count(uint16_t value) {
    unsigned int count = 0U;
    while (value != 0U) {
        count += value & 1U;
        value >>= 1;
    }
    return count;
}

static int valid_state(const BtgaLobbyState* lobby) {
    uint16_t allowed;
    uint16_t index;
    if (lobby == NULL || lobby->max_players == 0U ||
        lobby->max_players > BTGA_LOBBY_RETAIL_MAX_PLAYERS ||
        lobby->phase > BTGA_LOBBY_RUNNING) {
        return 0;
    }
    allowed = player_mask(lobby->max_players);
    if ((lobby->connected_mask & ~allowed) != 0U ||
        (lobby->ready_mask & ~lobby->connected_mask) != 0U ||
        (lobby->loaded_mask & ~lobby->connected_mask) != 0U) {
        return 0;
    }
    for (index = 0U; index < BTGA_LOBBY_RETAIL_MAX_PLAYERS; ++index) {
        const int connected = (lobby->connected_mask & (UINT16_C(1) << index)) != 0U;
        if (lobby->players[index].selected > 1U ||
            (!connected && lobby->players[index].selected != 0U) ||
            (lobby->players[index].selected != 0U &&
             lobby->players[index].vehicle_id == BTGA_LOBBY_NO_VEHICLE)) {
            return 0;
        }
    }
    return 1;
}

void btga_lobby_init(BtgaLobbyState* lobby, uint8_t max_players) {
    uint16_t index;
    if (lobby == NULL) return;
    memset(lobby, 0, sizeof(*lobby));
    lobby->max_players = max_players <= BTGA_LOBBY_RETAIL_MAX_PLAYERS
        ? max_players : BTGA_LOBBY_RETAIL_MAX_PLAYERS;
    for (index = 0U; index < BTGA_LOBBY_RETAIL_MAX_PLAYERS; ++index) {
        lobby->players[index].vehicle_id = BTGA_LOBBY_NO_VEHICLE;
    }
}

int btga_lobby_admit(BtgaLobbyState* lobby, uint16_t peer_id) {
    uint16_t bit;
    if (!valid_peer(lobby, peer_id) || lobby->phase != BTGA_LOBBY_ASSEMBLING ||
        (lobby->connected_mask & (UINT16_C(1) << peer_id)) != 0U) return 0;
    bit = (uint16_t)(UINT16_C(1) << peer_id);
    lobby->connected_mask |= bit;
    return 1;
}

int btga_lobby_remove(BtgaLobbyState* lobby, uint16_t peer_id) {
    uint16_t bit;
    if (!valid_peer(lobby, peer_id) ||
        (lobby->connected_mask & (UINT16_C(1) << peer_id)) == 0U ||
        lobby->phase == BTGA_LOBBY_RUNNING) return 0;
    bit = (uint16_t)(UINT16_C(1) << peer_id);
    lobby->connected_mask &= (uint16_t)~bit;
    lobby->ready_mask &= (uint16_t)~bit;
    lobby->loaded_mask &= (uint16_t)~bit;
    lobby->players[peer_id].vehicle_id = BTGA_LOBBY_NO_VEHICLE;
    lobby->players[peer_id].team_id = 0U;
    lobby->players[peer_id].selected = 0U;
    if (lobby->phase == BTGA_LOBBY_LOADING) {
        lobby->phase = BTGA_LOBBY_SELECTING;
        lobby->loaded_mask = 0U;
    }
    return 1;
}

int btga_lobby_begin_selection(BtgaLobbyState* lobby, uint16_t map_id,
                               uint16_t mode_id) {
    if (!valid_state(lobby) || lobby->phase != BTGA_LOBBY_ASSEMBLING ||
        bit_count(lobby->connected_mask) < 2U) return 0;
    lobby->map_id = map_id;
    lobby->mode_id = mode_id;
    lobby->ready_mask = 0U;
    lobby->loaded_mask = 0U;
    lobby->phase = BTGA_LOBBY_SELECTING;
    return 1;
}

int btga_lobby_apply_command(BtgaLobbyState* lobby, uint16_t authenticated_peer,
                             const BtgaLobbyCommand* command) {
    uint16_t bit;
    if (!valid_peer(lobby, authenticated_peer) || command == NULL) return 0;
    bit = (uint16_t)(UINT16_C(1) << authenticated_peer);
    if ((lobby->connected_mask & bit) == 0U) return 0;
    if (command->command_type == BTGA_LOBBY_CMD_SELECT) {
        if (lobby->phase != BTGA_LOBBY_SELECTING ||
            command->vehicle_id == BTGA_LOBBY_NO_VEHICLE) return 0;
        lobby->players[authenticated_peer].vehicle_id = command->vehicle_id;
        lobby->players[authenticated_peer].team_id = command->team_id;
        lobby->players[authenticated_peer].selected = 1U;
        lobby->ready_mask &= (uint16_t)~bit;
        return 1;
    }
    if (command->command_type == BTGA_LOBBY_CMD_READY) {
        if (lobby->phase != BTGA_LOBBY_SELECTING ||
            lobby->players[authenticated_peer].selected == 0U ||
            command->value > 1U) return 0;
        if (command->value != 0U) lobby->ready_mask |= bit;
        else lobby->ready_mask &= (uint16_t)~bit;
        return 1;
    }
    if (command->command_type == BTGA_LOBBY_CMD_LOADED) {
        if (lobby->phase != BTGA_LOBBY_LOADING || command->value != 1U) return 0;
        lobby->loaded_mask |= bit;
        if (btga_lobby_all_loaded(lobby)) lobby->phase = BTGA_LOBBY_RUNNING;
        return 1;
    }
    return 0;
}

int btga_lobby_lock_and_load(BtgaLobbyState* lobby, uint32_t random_seed,
                             uint32_t start_tick) {
    if (!valid_state(lobby) || lobby->phase != BTGA_LOBBY_SELECTING ||
        bit_count(lobby->connected_mask) < 2U ||
        lobby->ready_mask != lobby->connected_mask) return 0;
    lobby->random_seed = random_seed;
    lobby->start_tick = start_tick;
    lobby->loaded_mask = 0U;
    lobby->phase = BTGA_LOBBY_LOADING;
    return 1;
}

int btga_lobby_all_loaded(const BtgaLobbyState* lobby) {
    return valid_state(lobby) && lobby->phase == BTGA_LOBBY_LOADING &&
           lobby->connected_mask != 0U &&
           lobby->loaded_mask == lobby->connected_mask;
}

size_t btga_lobby_encode_snapshot(uint8_t* destination,
                                  size_t destination_size,
                                  const BtgaLobbyState* lobby) {
    uint16_t index;
    if (destination == NULL || destination_size < BTGA_LOBBY_SNAPSHOT_SIZE ||
        !valid_state(lobby)) return 0U;
    memset(destination, 0, BTGA_LOBBY_SNAPSHOT_SIZE);
    destination[0] = BTGA_LOBBY_PAYLOAD_SNAPSHOT;
    destination[1] = BTGA_LOBBY_VERSION;
    destination[2] = lobby->phase;
    destination[3] = lobby->max_players;
    destination[4] = (uint8_t)bit_count(lobby->connected_mask);
    put_u16(destination + 6, lobby->connected_mask);
    put_u16(destination + 8, lobby->ready_mask);
    put_u16(destination + 10, lobby->loaded_mask);
    put_u16(destination + 12, lobby->map_id);
    put_u16(destination + 14, lobby->mode_id);
    put_u32(destination + 16, lobby->random_seed);
    put_u32(destination + 20, lobby->start_tick);
    for (index = 0U; index < BTGA_LOBBY_RETAIL_MAX_PLAYERS; ++index) {
        uint8_t* entry = destination + 24U + index * 4U;
        put_u16(entry, lobby->players[index].vehicle_id);
        entry[2] = lobby->players[index].team_id;
        entry[3] = lobby->players[index].selected;
    }
    return BTGA_LOBBY_SNAPSHOT_SIZE;
}

int btga_lobby_decode_snapshot(BtgaLobbyState* lobby, const uint8_t* payload,
                               size_t payload_size) {
    uint16_t index;
    BtgaLobbyState decoded;
    if (lobby == NULL || payload == NULL ||
        payload_size != BTGA_LOBBY_SNAPSHOT_SIZE ||
        payload[0] != BTGA_LOBBY_PAYLOAD_SNAPSHOT ||
        payload[1] != BTGA_LOBBY_VERSION || payload[5] != 0U) return 0;
    memset(&decoded, 0, sizeof(decoded));
    decoded.phase = payload[2];
    decoded.max_players = payload[3];
    decoded.connected_mask = get_u16(payload + 6);
    decoded.ready_mask = get_u16(payload + 8);
    decoded.loaded_mask = get_u16(payload + 10);
    decoded.map_id = get_u16(payload + 12);
    decoded.mode_id = get_u16(payload + 14);
    decoded.random_seed = get_u32(payload + 16);
    decoded.start_tick = get_u32(payload + 20);
    for (index = 0U; index < BTGA_LOBBY_RETAIL_MAX_PLAYERS; ++index) {
        const uint8_t* entry = payload + 24U + index * 4U;
        decoded.players[index].vehicle_id = get_u16(entry);
        decoded.players[index].team_id = entry[2];
        decoded.players[index].selected = entry[3];
    }
    if (payload[4] != bit_count(decoded.connected_mask) || !valid_state(&decoded)) {
        return 0;
    }
    *lobby = decoded;
    return 1;
}

size_t btga_lobby_encode_command(uint8_t* destination,
                                 size_t destination_size,
                                 const BtgaLobbyCommand* command) {
    if (destination == NULL || command == NULL ||
        destination_size < BTGA_LOBBY_COMMAND_SIZE ||
        command->command_type < BTGA_LOBBY_CMD_SELECT ||
        command->command_type > BTGA_LOBBY_CMD_LOADED) return 0U;
    destination[0] = BTGA_LOBBY_PAYLOAD_COMMAND;
    destination[1] = BTGA_LOBBY_VERSION;
    destination[2] = command->command_type;
    destination[3] = command->value;
    put_u16(destination + 4, command->vehicle_id);
    destination[6] = command->team_id;
    destination[7] = 0U;
    return BTGA_LOBBY_COMMAND_SIZE;
}

int btga_lobby_decode_command(BtgaLobbyCommand* command,
                              const uint8_t* payload, size_t payload_size) {
    if (command == NULL || payload == NULL ||
        payload_size != BTGA_LOBBY_COMMAND_SIZE ||
        payload[0] != BTGA_LOBBY_PAYLOAD_COMMAND ||
        payload[1] != BTGA_LOBBY_VERSION || payload[7] != 0U ||
        payload[2] < BTGA_LOBBY_CMD_SELECT ||
        payload[2] > BTGA_LOBBY_CMD_LOADED) return 0;
    command->command_type = payload[2];
    command->vehicle_id = get_u16(payload + 4);
    command->team_id = payload[6];
    command->value = payload[3];
    return 1;
}
