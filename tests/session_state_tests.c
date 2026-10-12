#include "btga/btga_gameplay.h"
#include "btga/btga_session.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

int main(void) {
    static const uint8_t token[] = "eyJsb2JieSI6ImUxZSJ9.signature";
    static const uint64_t session_id = UINT64_C(0x9A7B6C5D4E3F2011);
    BtgaNetClientSession client;
    BtgaNetHostPending pending;
    BtgaNetEndpoint host_endpoint, client_endpoint;
    BtgaNetWelcome welcome;
    BtgaNetInputBatch input = {0}, decoded_input;
    BtgaNetPacketView view;
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t host_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t packet[BTGA_NET_MAX_DATAGRAM_SIZE];
    uint8_t tampered[BTGA_NET_MAX_DATAGRAM_SIZE];
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    size_t packet_size, payload_size, i;

    for (i = 0U; i < BTGA_NET_NONCE_SIZE; ++i) {
        client_nonce[i] = (uint8_t)(0x20U + i);
        host_nonce[i] = (uint8_t)(0xD0U + i);
    }
    CHECK(btga_net_client_session_init(&client, session_id,
                                       BTGA_NET_PLATFORM_PC,
                                       BTGA_NET_CAP_DIRECT_UDP,
                                       token, (uint16_t)(sizeof(token) - 1U),
                                       client_nonce, 100U));
    CHECK(client.state == BTGA_NET_CLIENT_READY);
    packet_size = btga_net_client_build_hello(&client, packet, sizeof(packet));
    CHECK(packet_size != 0U && client.state == BTGA_NET_CLIENT_HELLO_SENT);
    CHECK(btga_net_host_accept_hello(&pending, session_id, host_nonce, 900U,
                                     packet, packet_size));
    CHECK(pending.state == BTGA_NET_HOST_PENDING_HELLO);
    CHECK(pending.token_size == sizeof(token) - 1U);
    CHECK(memcmp(pending.token, token, sizeof(token) - 1U) == 0);

    packet_size = btga_net_host_build_challenge(&pending, packet, sizeof(packet));
    CHECK(packet_size != 0U);
    memcpy(tampered, packet, packet_size);
    tampered[BTGA_NET_HEADER_SIZE] ^= 1U;
    CHECK(!btga_net_client_accept_challenge(&client, tampered, packet_size));
    CHECK(client.state == BTGA_NET_CLIENT_HELLO_SENT);
    CHECK(btga_net_client_accept_challenge(&client, packet, packet_size));

    packet_size = btga_net_client_build_authenticate(&client, packet, sizeof(packet));
    CHECK(packet_size != 0U && client.state == BTGA_NET_CLIENT_AUTH_SENT);
    memcpy(tampered, packet, packet_size);
    tampered[BTGA_NET_HEADER_SIZE + BTGA_NET_NONCE_SIZE] ^= 1U;
    CHECK(!btga_net_host_accept_authenticate(&pending, tampered, packet_size));
    CHECK(btga_net_host_accept_authenticate(&pending, packet, packet_size));

    /* The platform host validates pending.token over HTTPS at this point. */
    packet_size = btga_net_host_build_welcome(&pending, 1U, 4U, 30U, 700U,
                                               packet, sizeof(packet));
    CHECK(packet_size != 0U);
    CHECK(btga_net_client_accept_welcome(&client, &welcome, &client_endpoint,
                                         packet, packet_size));
    CHECK(welcome.assigned_peer_id == 1U && welcome.initial_tick == 700U);
    CHECK(client_endpoint.local_peer_id == 1U);
    CHECK(btga_net_endpoint_init(&host_endpoint, session_id, 0U, 1000U));

    input.first_tick = welcome.initial_tick;
    input.player_id = 1U;
    input.frame_count = 2U;
    input.frames[0].buttons = UINT16_C(0x2000);
    input.frames[0].stick_x = 50;
    input.frames[0].stick_y = -20;
    input.frames[1].buttons = UINT16_C(0x2000);
    input.frames[1].stick_x = 48;
    input.frames[1].stick_y = -22;
    payload_size = btga_net_encode_input_batch(payload, sizeof(payload), &input);
    packet_size = btga_net_endpoint_encode(&client_endpoint, packet, sizeof(packet),
                                           BTGA_NET_MSG_INPUT, 0U, 0U,
                                           payload, payload_size);
    CHECK(packet_size != 0U);
    CHECK(btga_net_endpoint_decode(&host_endpoint, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);
    CHECK(btga_net_decode_input_batch(&decoded_input, view.payload,
                                      view.payload_size));
    CHECK(decoded_input.first_tick == 700U && decoded_input.frame_count == 2U);
    CHECK(decoded_input.frames[1].stick_x == 48);
    return 0;
}
