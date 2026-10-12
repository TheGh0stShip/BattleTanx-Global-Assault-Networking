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
    uint64_t session_id = 0U;
    char session_text[BTGA_NET_SESSION_ID_TEXT_SIZE + 1U];

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
    CHECK(btga_net_parse_session_id(&session_id, "0123456789ABCDEF",
                                    BTGA_NET_SESSION_ID_TEXT_SIZE));
    CHECK(session_id == UINT64_C(0x0123456789ABCDEF));
    CHECK(btga_net_format_session_id(session_text, sizeof(session_text), session_id));
    CHECK(strcmp(session_text, "0123456789abcdef") == 0);
    CHECK(!btga_net_parse_session_id(&session_id, "1234", 4U));
    CHECK(!btga_net_parse_session_id(&session_id, "0123456789abcdeg",
                                     BTGA_NET_SESSION_ID_TEXT_SIZE));
    CHECK(!btga_net_format_session_id(session_text,
                                      BTGA_NET_SESSION_ID_TEXT_SIZE, session_id));

    header.message_type = BTGA_NET_MSG_HELLO;
    header.peer_id = BTGA_NET_UNASSIGNED_PEER_ID;
    CHECK(btga_net_encode_header(packet, sizeof(packet), &header) ==
          BTGA_NET_HEADER_SIZE);
    CHECK(btga_net_decode_header(&decoded, packet, sizeof(packet)));
    header.message_type = BTGA_NET_MSG_INPUT;
    CHECK(btga_net_encode_header(packet, sizeof(packet), &header) == 0U);
    return 0;
}
