#include "btga/btga_relay.h"
#include "btga/btga_relay_client.h"

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
    BtgaRelayClient client;
    BtgaRelayEnvelope bound;
    BtgaNetHeader net_header;
    uint8_t inner[BTGA_NET_HEADER_SIZE];
    uint8_t bound_packet[BTGA_RELAY_HEADER_SIZE];
    const uint8_t* unwrapped;
    size_t unwrapped_size;
    uint16_t source_slot;

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

    btga_relay_client_init(&client);
    CHECK(client.state == BTGA_RELAY_CLIENT_OFFLINE);
    CHECK(btga_relay_client_make_bind(&client, encoded, sizeof(encoded)) == 0U);
    CHECK(btga_relay_client_begin(&client, BTGA_RELAY_ROLE_CLIENT,
                                  input.session_id, payload,
                                  sizeof(payload)) == 1);
    CHECK(btga_relay_client_make_bind(&client, encoded, sizeof(encoded)) ==
          BTGA_RELAY_HEADER_SIZE + sizeof(payload));
    CHECK(btga_relay_decode(&output, encoded,
                            BTGA_RELAY_HEADER_SIZE + sizeof(payload)) == 1);
    CHECK(output.message_type == BTGA_RELAY_MSG_BIND);

    memset(&bound, 0, sizeof(bound));
    bound.message_type = BTGA_RELAY_MSG_BOUND;
    bound.session_id = input.session_id;
    bound.source_slot = 1U;
    bound.destination_slot = 1U;
    CHECK(btga_relay_encode(bound_packet, sizeof(bound_packet), &bound) ==
          sizeof(bound_packet));
    CHECK(btga_relay_client_accept_bound(&client, bound_packet,
                                          sizeof(bound_packet)) == 1);
    CHECK(client.state == BTGA_RELAY_CLIENT_BOUND);
    CHECK(client.token_size == 0U);

    memset(&net_header, 0, sizeof(net_header));
    net_header.protocol_version = BTGA_NET_PROTOCOL_VERSION;
    net_header.message_type = BTGA_NET_MSG_PING;
    net_header.flags = BTGA_NET_FLAG_RELAYED;
    net_header.session_id = input.session_id;
    net_header.peer_id = 1U;
    CHECK(btga_net_encode_header(inner, sizeof(inner), &net_header) ==
          sizeof(inner));
    CHECK(btga_relay_client_wrap(&client, 0U, inner, sizeof(inner), encoded,
                                  sizeof(encoded)) ==
          BTGA_RELAY_HEADER_SIZE + sizeof(inner));
    CHECK(btga_relay_client_wrap(&client, BTGA_RELAY_BROADCAST_SLOT, inner,
                                  sizeof(inner), encoded, sizeof(encoded)) == 0U);

    net_header.peer_id = 0U;
    CHECK(btga_net_encode_header(inner, sizeof(inner), &net_header) ==
          sizeof(inner));
    output.message_type = BTGA_RELAY_MSG_DATA;
    output.session_id = input.session_id;
    output.source_slot = 0U;
    output.destination_slot = 1U;
    output.payload = inner;
    output.payload_size = (uint16_t)sizeof(inner);
    CHECK(btga_relay_encode(encoded, sizeof(encoded), &output) ==
          BTGA_RELAY_HEADER_SIZE + sizeof(inner));
    CHECK(btga_relay_client_unwrap(&client, encoded,
                                    BTGA_RELAY_HEADER_SIZE + sizeof(inner),
                                    &unwrapped, &unwrapped_size,
                                    &source_slot) == 1);
    CHECK(unwrapped_size == sizeof(inner));
    CHECK(source_slot == 0U);
    CHECK(memcmp(unwrapped, inner, sizeof(inner)) == 0);
    btga_relay_client_disconnect(&client);
    CHECK(client.state == BTGA_RELAY_CLIENT_OFFLINE);
    return 0;
}
