#include "btga/btga_relay_client.h"

#include <string.h>

void btga_relay_client_init(BtgaRelayClient* client) {
    if (client != NULL) {
        memset(client, 0, sizeof(*client));
        client->relay_slot = BTGA_RELAY_BROADCAST_SLOT;
    }
}

int btga_relay_client_begin(BtgaRelayClient* client, BtgaRelayRole role,
                            uint64_t session_id, const uint8_t* token,
                            size_t token_size) {
    if (client == NULL || token == NULL || token_size == 0U ||
        token_size > BTGA_NET_MAX_JOIN_TOKEN_SIZE ||
        (role != BTGA_RELAY_ROLE_HOST && role != BTGA_RELAY_ROLE_CLIENT)) {
        return 0;
    }
    btga_relay_client_init(client);
    client->state = BTGA_RELAY_CLIENT_BINDING;
    client->role = (uint8_t)role;
    client->session_id = session_id;
    client->token_size = (uint16_t)token_size;
    memcpy(client->token, token, token_size);
    return 1;
}

size_t btga_relay_client_make_bind(const BtgaRelayClient* client,
                                   uint8_t* destination,
                                   size_t destination_size) {
    BtgaRelayEnvelope envelope;
    if (client == NULL || client->state != BTGA_RELAY_CLIENT_BINDING) {
        return 0U;
    }
    envelope.message_type = BTGA_RELAY_MSG_BIND;
    envelope.session_id = client->session_id;
    envelope.source_slot = BTGA_RELAY_BROADCAST_SLOT;
    envelope.destination_slot = 0U;
    envelope.payload = client->token;
    envelope.payload_size = client->token_size;
    return btga_relay_encode(destination, destination_size, &envelope);
}

int btga_relay_client_accept_bound(BtgaRelayClient* client,
                                   const uint8_t* datagram,
                                   size_t datagram_size) {
    BtgaRelayEnvelope envelope;
    if (client == NULL || client->state != BTGA_RELAY_CLIENT_BINDING ||
        !btga_relay_decode(&envelope, datagram, datagram_size) ||
        envelope.message_type != BTGA_RELAY_MSG_BOUND ||
        envelope.session_id != client->session_id ||
        envelope.payload_size != 0U ||
        envelope.source_slot >= BTGA_NET_MAX_PLAYERS ||
        envelope.destination_slot != envelope.source_slot ||
        (client->role == BTGA_RELAY_ROLE_HOST && envelope.source_slot != 0U) ||
        (client->role == BTGA_RELAY_ROLE_CLIENT && envelope.source_slot == 0U)) {
        return 0;
    }
    client->state = BTGA_RELAY_CLIENT_BOUND;
    client->relay_slot = envelope.source_slot;
    memset(client->token, 0, sizeof(client->token));
    client->token_size = 0U;
    return 1;
}

size_t btga_relay_client_wrap(const BtgaRelayClient* client,
                              uint16_t destination_slot,
                              const uint8_t* inner_datagram,
                              size_t inner_size, uint8_t* destination,
                              size_t destination_size) {
    BtgaRelayEnvelope envelope;
    BtgaNetHeader header;
    if (client == NULL || client->state != BTGA_RELAY_CLIENT_BOUND ||
        inner_datagram == NULL ||
        !btga_net_decode_header(&header, inner_datagram, inner_size) ||
        header.session_id != client->session_id ||
        (header.flags & BTGA_NET_FLAG_RELAYED) == 0U ||
        (client->role == BTGA_RELAY_ROLE_CLIENT && destination_slot != 0U) ||
        (client->role == BTGA_RELAY_ROLE_HOST &&
         destination_slot != BTGA_RELAY_BROADCAST_SLOT &&
         (destination_slot == 0U || destination_slot >= BTGA_NET_MAX_PLAYERS))) {
        return 0U;
    }
    envelope.message_type = BTGA_RELAY_MSG_DATA;
    envelope.session_id = client->session_id;
    envelope.source_slot = client->relay_slot;
    envelope.destination_slot = destination_slot;
    envelope.payload = inner_datagram;
    envelope.payload_size = (uint16_t)inner_size;
    return btga_relay_encode(destination, destination_size, &envelope);
}

int btga_relay_client_unwrap(const BtgaRelayClient* client,
                             const uint8_t* relay_datagram,
                             size_t relay_size,
                             const uint8_t** inner_datagram,
                             size_t* inner_size, uint16_t* source_slot) {
    BtgaRelayEnvelope envelope;
    BtgaNetHeader header;
    if (client == NULL || inner_datagram == NULL || inner_size == NULL ||
        source_slot == NULL || client->state != BTGA_RELAY_CLIENT_BOUND ||
        !btga_relay_decode(&envelope, relay_datagram, relay_size) ||
        envelope.message_type != BTGA_RELAY_MSG_DATA ||
        envelope.session_id != client->session_id ||
        envelope.destination_slot != client->relay_slot ||
        envelope.payload_size < BTGA_NET_HEADER_SIZE ||
        !btga_net_decode_header(&header, envelope.payload,
                                envelope.payload_size) ||
        header.session_id != client->session_id ||
        (header.flags & BTGA_NET_FLAG_RELAYED) == 0U ||
        (client->role == BTGA_RELAY_ROLE_CLIENT && envelope.source_slot != 0U) ||
        (client->role == BTGA_RELAY_ROLE_HOST &&
         (envelope.source_slot == 0U || envelope.source_slot >= BTGA_NET_MAX_PLAYERS))) {
        return 0;
    }
    *inner_datagram = envelope.payload;
    *inner_size = envelope.payload_size;
    *source_slot = envelope.source_slot;
    return 1;
}

void btga_relay_client_disconnect(BtgaRelayClient* client) {
    btga_relay_client_init(client);
}
