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

static int test_round_trip_and_filtering(void) {
    static const uint8_t payload[] = {0x10U, 0x20U, 0x30U, 0x40U};
    BtgaNetEndpoint host;
    BtgaNetEndpoint client;
    BtgaNetPacketView view;
    uint8_t packet[BTGA_NET_MAX_DATAGRAM_SIZE];
    size_t packet_size;

    CHECK(btga_net_endpoint_init(&host, UINT64_C(0x1020304050607080), 0U, 77U));
    CHECK(btga_net_endpoint_init(&client, UINT64_C(0x1020304050607080), 1U, 900U));
    packet_size = btga_net_endpoint_encode(&host, packet, sizeof(packet),
                                           BTGA_NET_MSG_INPUT, 0U, 1U,
                                           payload, sizeof(payload));
    CHECK(packet_size == BTGA_NET_HEADER_SIZE + sizeof(payload));
    CHECK(host.next_sequence == 78U);
    CHECK(btga_net_endpoint_decode(&client, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);
    CHECK(view.header.sequence == 77U);
    CHECK(view.header.peer_id == 0U);
    CHECK(view.payload_size == sizeof(payload));
    CHECK(memcmp(view.payload, payload, sizeof(payload)) == 0);
    CHECK(btga_net_endpoint_decode(&client, &view, packet, packet_size) ==
          BTGA_NET_PACKET_DUPLICATE);
    CHECK(btga_net_endpoint_decode(&host, &view, packet, packet_size) ==
          BTGA_NET_PACKET_SELF);

    packet_size = btga_net_endpoint_encode(&client, packet, sizeof(packet),
                                           BTGA_NET_MSG_PONG, 0U, 0U,
                                           NULL, 0U);
    CHECK(packet_size == BTGA_NET_HEADER_SIZE);
    CHECK(btga_net_endpoint_decode(&host, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);
    CHECK(view.header.acknowledgment == 77U);
    CHECK(view.header.acknowledgment_bits == 0U);
    return 0;
}

static int test_rejection_and_sequence_wrap(void) {
    BtgaNetEndpoint source;
    BtgaNetEndpoint destination;
    BtgaNetPacketView view;
    uint8_t packet[BTGA_NET_HEADER_SIZE];
    size_t packet_size;

    CHECK(!btga_net_endpoint_init(&source, 0U, 0U, 0U));
    CHECK(!btga_net_endpoint_init(&source, 1U, BTGA_NET_MAX_PLAYERS, 0U));
    CHECK(btga_net_endpoint_init(&source, 1U, 2U, UINT32_MAX));
    CHECK(btga_net_endpoint_init(&destination, 1U, 3U, 0U));
    packet_size = btga_net_endpoint_encode(&source, packet, sizeof(packet),
                                           BTGA_NET_MSG_PING, 0U, 3U, NULL, 0U);
    CHECK(packet_size == sizeof(packet));
    CHECK(source.next_sequence == 0U);
    CHECK(btga_net_endpoint_decode(&destination, &view, packet, packet_size) ==
          BTGA_NET_PACKET_NEW);

    packet[15] ^= 1U;
    CHECK(btga_net_endpoint_decode(&destination, &view, packet, packet_size) ==
          BTGA_NET_PACKET_WRONG_SESSION);
    packet[15] ^= 1U;
    packet[0] = 0U;
    CHECK(btga_net_endpoint_decode(&destination, &view, packet, packet_size) ==
          BTGA_NET_PACKET_INVALID);

    packet[0] = 0x42U;
    packet[6] = BTGA_NET_MSG_HELLO;
    packet[30] = 0xFFU;
    packet[31] = 0xFFU;
    CHECK(btga_net_endpoint_decode(&destination, &view, packet, packet_size) ==
          BTGA_NET_PACKET_INVALID);
    return 0;
}

static int test_encode_bounds(void) {
    BtgaNetEndpoint endpoint;
    uint8_t packet[BTGA_NET_MAX_DATAGRAM_SIZE];
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE + 1U];

    CHECK(btga_net_endpoint_init(&endpoint, 1U, 0U, 5U));
    CHECK(btga_net_endpoint_encode(&endpoint, packet, sizeof(packet),
                                   BTGA_NET_MSG_EVENT, 0U, 1U,
                                   payload, sizeof(payload)) == 0U);
    CHECK(endpoint.next_sequence == 5U);
    CHECK(btga_net_endpoint_encode(&endpoint, packet, BTGA_NET_HEADER_SIZE - 1U,
                                   BTGA_NET_MSG_EVENT, 0U, 1U, NULL, 0U) == 0U);
    CHECK(btga_net_endpoint_encode(&endpoint, packet, sizeof(packet),
                                   BTGA_NET_MSG_EVENT, 0U, 1U, NULL, 1U) == 0U);
    CHECK(btga_net_endpoint_encode(&endpoint, packet, sizeof(packet),
                                   BTGA_NET_MSG_EVENT, 0U, 0U, NULL, 0U) == 0U);
    CHECK(btga_net_endpoint_encode(&endpoint, packet, sizeof(packet),
                                   BTGA_NET_MSG_EVENT, 0U,
                                   BTGA_NET_MAX_PLAYERS, NULL, 0U) == 0U);
    return 0;
}

int main(void) {
    CHECK(test_round_trip_and_filtering() == 0);
    CHECK(test_rejection_and_sequence_wrap() == 0);
    CHECK(test_encode_bounds() == 0);
    return 0;
}
