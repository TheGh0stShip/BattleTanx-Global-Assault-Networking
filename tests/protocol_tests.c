#include "btga/btga_net.h"

#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

int main(void) {
    static const uint8_t expected[BTGA_NET_HEADER_SIZE] = {
        0x42, 0x54, 0x47, 0x41, 0x00, 0x01, 0x06, 0x01,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
        0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
        0x90, 0xA0, 0xB0, 0xC0, 0x00, 0x00, 0x00, 0x0F
    };
    BtgaNetHeader header = {
        BTGA_NET_PROTOCOL_VERSION, BTGA_NET_MSG_SNAPSHOT, BTGA_NET_FLAG_RELIABLE,
        UINT64_C(0x0123456789ABCDEF), UINT32_C(0x10203040),
        UINT32_C(0x50607080), UINT32_C(0x90A0B0C0), 0U, 15U
    };
    uint8_t packet[BTGA_NET_HEADER_SIZE];
    BtgaNetHeader decoded;

    CHECK(btga_net_encode_header(packet, sizeof(packet), &header) == BTGA_NET_HEADER_SIZE);
    CHECK(memcmp(packet, expected, sizeof(expected)) == 0);
    CHECK(btga_net_decode_header(&decoded, packet, sizeof(packet)) == 1);
    CHECK(decoded.session_id == header.session_id);
    CHECK(decoded.sequence == header.sequence);
    CHECK(decoded.acknowledgment == header.acknowledgment);
    CHECK(decoded.acknowledgment_bits == header.acknowledgment_bits);
    CHECK(decoded.peer_id == 15U);

    packet[0] = 0U;
    CHECK(btga_net_decode_header(&decoded, packet, sizeof(packet)) == 0);
    packet[0] = 0x42U;
    packet[7] = 0x80U;
    CHECK(btga_net_decode_header(&decoded, packet, sizeof(packet)) == 0);
    packet[7] = BTGA_NET_FLAG_RELIABLE;
    CHECK(btga_net_decode_header(&decoded, packet, sizeof(packet) - 1U) == 0);
    return 0;
}
