#include "btga/btga_relay.h"

#include <string.h>

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

int main(void) {
    static const uint8_t payload[] = {0x42, 0x54, 0x47, 0x41};
    static const uint8_t expected[] = {
        0x42, 0x54, 0x52, 0x4c, 0x01, 0x03, 0x00, 0x00,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00,
        0x42, 0x54, 0x47, 0x41
    };
    uint8_t encoded[64];
    BtgaRelayEnvelope input;
    BtgaRelayEnvelope output;

    memset(&input, 0, sizeof(input));
    input.message_type = BTGA_RELAY_MSG_DATA;
    input.session_id = UINT64_C(0x0123456789abcdef);
    input.source_slot = 1U;
    input.destination_slot = 0U;
    input.payload = payload;
    input.payload_size = (uint16_t)sizeof(payload);
    CHECK(btga_relay_encode(encoded, sizeof(encoded), &input) == sizeof(expected));
    CHECK(memcmp(encoded, expected, sizeof(expected)) == 0);
    CHECK(btga_relay_decode(&output, encoded, sizeof(expected)) == 1);
    CHECK(output.message_type == input.message_type);
    CHECK(output.session_id == input.session_id);
    CHECK(output.source_slot == input.source_slot);
    CHECK(output.destination_slot == input.destination_slot);
    CHECK(output.payload_size == sizeof(payload));
    CHECK(memcmp(output.payload, payload, sizeof(payload)) == 0);

    encoded[6] = 1U;
    CHECK(btga_relay_decode(&output, encoded, sizeof(expected)) == 0);
    CHECK(btga_relay_decode(&output, expected, sizeof(expected) - 1U) == 0);
    return 0;
}
