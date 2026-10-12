#include "btga/btga_delivery.h"
#include "btga/btga_gameplay.h"
#include "btga/btga_handshake.h"
#include "btga/btga_transport.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static size_t make_packet(uint8_t* packet, size_t capacity, uint64_t session,
                          uint8_t type, uint16_t peer, uint32_t sequence,
                          const uint8_t* payload, size_t payload_size) {
    BtgaNetHeader header = {BTGA_NET_PROTOCOL_VERSION, type, 0U, session,
                            sequence, 0U, 0U, (uint16_t)payload_size, peer};
    if (capacity < BTGA_NET_HEADER_SIZE + payload_size ||
        btga_net_encode_header(packet, capacity, &header) == 0U) return 0U;
    memcpy(packet + BTGA_NET_HEADER_SIZE, payload, payload_size);
    return BTGA_NET_HEADER_SIZE + payload_size;
}

int main(void) {
    static const uint8_t token[] = "eyJsb2JieSI6InRlc3QifQ.signature";
    const uint64_t session = UINT64_C(0x0123456789ABCDEF);
    BtgaNetHello hello = {0}, decoded_hello;
    BtgaNetChallenge challenge = {{0}, {0}}, decoded_challenge;
    BtgaNetWelcome welcome = {{0}, 1U, 4U, 30U, 500U}, decoded_welcome;
    BtgaNetHeader header;
    BtgaNetEndpoint host, client;
    BtgaNetPacketView view;
    BtgaNetInputBatch input = {0}, decoded_input;
    BtgaNetSendQueue sends;
    BtgaNetDelivery delivery;
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    uint8_t packet[BTGA_NET_MAX_DATAGRAM_SIZE];
    size_t payload_size, packet_size, index;

    hello.platform = BTGA_NET_PLATFORM_PC;
    hello.capabilities = BTGA_NET_CAP_DIRECT_UDP;
    hello.join_token = token;
    hello.join_token_size = (uint16_t)(sizeof(token) - 1U);
    for (index = 0U; index < BTGA_NET_NONCE_SIZE; ++index) {
        hello.client_nonce[index] = (uint8_t)(0x10U + index);
        challenge.host_nonce[index] = (uint8_t)(0x80U + index);
    }
    memcpy(challenge.client_nonce, hello.client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(welcome.client_nonce, hello.client_nonce, BTGA_NET_NONCE_SIZE);

    payload_size = btga_net_encode_hello(payload, sizeof(payload), &hello);
    packet_size = make_packet(packet, sizeof(packet), session, BTGA_NET_MSG_HELLO,
                              BTGA_NET_UNASSIGNED_PEER_ID, 1U, payload, payload_size);
    CHECK(packet_size != 0U && btga_net_decode_header(&header, packet, packet_size));
    CHECK(btga_net_decode_hello(&decoded_hello, packet + BTGA_NET_HEADER_SIZE,
                                header.payload_size));
    CHECK(memcmp(decoded_hello.client_nonce, hello.client_nonce,
                 BTGA_NET_NONCE_SIZE) == 0);

    payload_size = btga_net_encode_challenge(payload, sizeof(payload), &challenge);
    packet_size = make_packet(packet, sizeof(packet), session, BTGA_NET_MSG_CHALLENGE,
                              0U, 2U, payload, payload_size);
    CHECK(btga_net_decode_header(&header, packet, packet_size));
    CHECK(btga_net_decode_challenge(&decoded_challenge,
                                    packet + BTGA_NET_HEADER_SIZE, header.payload_size));
    CHECK(memcmp(&decoded_challenge, &challenge, sizeof(challenge)) == 0);

    payload_size = btga_net_encode_authenticate(payload, sizeof(payload), &decoded_challenge);
    packet_size = make_packet(packet, sizeof(packet), session,
                              BTGA_NET_MSG_AUTHENTICATE,
                              BTGA_NET_UNASSIGNED_PEER_ID, 3U, payload, payload_size);
    CHECK(btga_net_decode_header(&header, packet, packet_size));
    CHECK(btga_net_decode_authenticate(&decoded_challenge,
                                       packet + BTGA_NET_HEADER_SIZE, header.payload_size));

    payload_size = btga_net_encode_welcome(payload, sizeof(payload), &welcome);
    packet_size = make_packet(packet, sizeof(packet), session, BTGA_NET_MSG_WELCOME,
                              0U, 4U, payload, payload_size);
    CHECK(btga_net_decode_header(&header, packet, packet_size));
    CHECK(btga_net_decode_welcome(&decoded_welcome,
                                  packet + BTGA_NET_HEADER_SIZE, header.payload_size));
    CHECK(decoded_welcome.assigned_peer_id == 1U);

    CHECK(btga_net_endpoint_init(&host, session, 0U, 100U));
    CHECK(btga_net_endpoint_init(&client, session, 1U, 200U));
    btga_net_send_queue_init(&sends);
    input.first_tick = 500U;
    input.player_id = 1U;
    input.frame_count = 1U;
    input.frames[0].buttons = UINT16_C(0x8000);
    input.frames[0].stick_x = 25;
    input.frames[0].stick_y = -40;
    payload_size = btga_net_encode_input_batch(payload, sizeof(payload), &input);
    packet_size = btga_net_endpoint_encode(&client, packet, sizeof(packet),
                                           BTGA_NET_MSG_INPUT,
                                           BTGA_NET_FLAG_RELIABLE, 0U,
                                           payload, payload_size);
    CHECK(packet_size != 0U && btga_net_send_queue_track(&sends, 200U, 1000U, 7U));
    CHECK(btga_net_endpoint_decode(&host, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);
    CHECK(btga_net_decode_input_batch(&decoded_input, view.payload, view.payload_size));
    CHECK(decoded_input.first_tick == 500U && decoded_input.frames[0].stick_y == -40);

    packet_size = btga_net_endpoint_encode(&host, packet, sizeof(packet),
                                           BTGA_NET_MSG_PONG, 0U, 1U, NULL, 0U);
    CHECK(btga_net_endpoint_decode(&client, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);
    CHECK(view.header.acknowledgment == 200U);
    CHECK(btga_net_send_queue_acknowledge(&sends, view.header.acknowledgment,
                                          view.header.acknowledgment_bits,
                                          &delivery, 1U) == 1U);
    CHECK(delivery.user_tag == 7U && sends.active_count == 0U);
    return 0;
}
