#include "btga/btga_lobby.h"
#include "btga/btga_relay_client.h"
#include "btga/btga_transport.h"

#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static int bind_relay_client(BtgaRelayClient* client, BtgaRelayRole role,
                             uint64_t session_id, uint16_t slot) {
    static const uint8_t token[] = "signed.token";
    BtgaRelayEnvelope bound;
    uint8_t packet[BTGA_RELAY_HEADER_SIZE];
    if (!btga_relay_client_begin(client, role, session_id, token,
                                 sizeof(token) - 1U)) return 0;
    memset(&bound, 0, sizeof(bound));
    bound.message_type = BTGA_RELAY_MSG_BOUND;
    bound.session_id = session_id;
    bound.source_slot = slot;
    bound.destination_slot = slot;
    return btga_relay_encode(packet, sizeof(packet), &bound) == sizeof(packet) &&
           btga_relay_client_accept_bound(client, packet, sizeof(packet));
}

int main(void) {
    const uint64_t session_id = UINT64_C(0x1020304050607080);
    BtgaRelayClient host_relay, guest_relay;
    BtgaNetEndpoint host_endpoint, guest_endpoint;
    BtgaLobbyState host_lobby, guest_lobby;
    BtgaLobbyCommand command = {0}, decoded_command;
    BtgaNetPacketView view;
    const uint8_t* inner_view;
    size_t inner_view_size;
    uint16_t relay_source;
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    uint8_t inner[BTGA_NET_MAX_DATAGRAM_SIZE];
    uint8_t relayed[BTGA_RELAY_MAX_DATAGRAM_SIZE];
    size_t payload_size, inner_size, relay_size;

    CHECK(bind_relay_client(&host_relay, BTGA_RELAY_ROLE_HOST,
                            session_id, 0U));
    CHECK(bind_relay_client(&guest_relay, BTGA_RELAY_ROLE_CLIENT,
                            session_id, 1U));
    CHECK(btga_net_endpoint_init(&host_endpoint, session_id, 0U, 100U));
    CHECK(btga_net_endpoint_init(&guest_endpoint, session_id, 1U, 200U));
    btga_lobby_init(&host_lobby, 4U);
    CHECK(btga_lobby_admit(&host_lobby, 0U));
    CHECK(btga_lobby_admit(&host_lobby, 1U));
    CHECK(btga_lobby_begin_selection(&host_lobby, 5U, 2U));

    /* Guest chooses a tank. No peer ID exists in the command payload. */
    command.command_type = BTGA_LOBBY_CMD_SELECT;
    command.vehicle_id = 11U;
    command.team_id = 1U;
    payload_size = btga_lobby_encode_command(payload, sizeof(payload), &command);
    CHECK(payload_size == BTGA_LOBBY_COMMAND_SIZE);
    inner_size = btga_net_endpoint_encode(
        &guest_endpoint, inner, sizeof(inner), BTGA_NET_MSG_EVENT,
        BTGA_NET_FLAG_RELIABLE | BTGA_NET_FLAG_RELAYED, 0U,
        payload, payload_size);
    CHECK(inner_size != 0U);
    relay_size = btga_relay_client_wrap(&guest_relay, 0U, inner, inner_size,
                                         relayed, sizeof(relayed));
    CHECK(relay_size != 0U);
    CHECK(btga_relay_client_unwrap(&host_relay, relayed, relay_size,
                                    &inner_view, &inner_view_size,
                                    &relay_source));
    CHECK(relay_source == 1U);
    CHECK(btga_net_endpoint_decode(&host_endpoint, &view, inner_view,
                                    inner_view_size) == BTGA_NET_PACKET_NEW);
    CHECK(view.header.peer_id == relay_source);
    CHECK(btga_lobby_decode_command(&decoded_command, view.payload,
                                    view.payload_size));
    CHECK(btga_lobby_apply_command(&host_lobby, relay_source,
                                    &decoded_command));
    CHECK(host_lobby.players[1].vehicle_id == 11U);
    CHECK(host_lobby.players[0].selected == 0U);

    /* Host selects locally, then both players become ready. */
    command.vehicle_id = 3U;
    command.team_id = 0U;
    CHECK(btga_lobby_apply_command(&host_lobby, 0U, &command));
    command.command_type = BTGA_LOBBY_CMD_READY;
    command.value = 1U;
    CHECK(btga_lobby_apply_command(&host_lobby, 0U, &command));
    CHECK(btga_lobby_apply_command(&host_lobby, 1U, &command));
    CHECK(btga_lobby_lock_and_load(&host_lobby, UINT32_C(0xaabbccdd),
                                   1200U));

    /* Host broadcasts the authoritative selection/load snapshot to guest. */
    payload_size = btga_lobby_encode_snapshot(payload, sizeof(payload),
                                               &host_lobby);
    CHECK(payload_size == BTGA_LOBBY_SNAPSHOT_SIZE);
    inner_size = btga_net_endpoint_encode(
        &host_endpoint, inner, sizeof(inner), BTGA_NET_MSG_EVENT,
        BTGA_NET_FLAG_RELIABLE | BTGA_NET_FLAG_RELAYED, 1U,
        payload, payload_size);
    CHECK(inner_size != 0U);
    relay_size = btga_relay_client_wrap(&host_relay, 1U, inner, inner_size,
                                         relayed, sizeof(relayed));
    CHECK(relay_size != 0U);
    CHECK(btga_relay_client_unwrap(&guest_relay, relayed, relay_size,
                                    &inner_view, &inner_view_size,
                                    &relay_source));
    CHECK(relay_source == 0U);
    CHECK(btga_net_endpoint_decode(&guest_endpoint, &view, inner_view,
                                    inner_view_size) == BTGA_NET_PACKET_NEW);
    CHECK(btga_lobby_decode_snapshot(&guest_lobby, view.payload,
                                     view.payload_size));
    CHECK(guest_lobby.phase == BTGA_LOBBY_LOADING);
    CHECK(guest_lobby.players[0].vehicle_id == 3U);
    CHECK(guest_lobby.players[1].vehicle_id == 11U);
    CHECK(guest_lobby.random_seed == UINT32_C(0xaabbccdd));
    CHECK(guest_lobby.start_tick == 1200U);
    return 0;
}
