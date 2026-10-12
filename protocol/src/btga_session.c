#include "btga/btga_session.h"

#include <string.h>

static size_t encode_packet(uint8_t* packet, size_t packet_capacity,
                            uint64_t session_id, uint32_t sequence,
                            uint8_t message_type, uint16_t peer_id,
                            const uint8_t* payload, size_t payload_size) {
    BtgaNetHeader header;
    size_t header_size;
    if (packet == NULL || payload_size > BTGA_NET_MAX_PAYLOAD_SIZE ||
        packet_capacity < BTGA_NET_HEADER_SIZE + payload_size ||
        (payload_size != 0U && payload == NULL)) return 0U;
    header.protocol_version = BTGA_NET_PROTOCOL_VERSION;
    header.message_type = message_type;
    header.flags = 0U;
    header.session_id = session_id;
    header.sequence = sequence;
    header.acknowledgment = 0U;
    header.acknowledgment_bits = 0U;
    header.payload_size = (uint16_t)payload_size;
    header.peer_id = peer_id;
    header_size = btga_net_encode_header(packet, packet_capacity, &header);
    if (header_size == 0U) return 0U;
    if (payload_size != 0U) memcpy(packet + header_size, payload, payload_size);
    return header_size + payload_size;
}

static int decode_handshake_header(BtgaNetHeader* header,
                                   const uint8_t* packet, size_t packet_size,
                                   uint64_t session_id, uint8_t message_type,
                                   uint16_t peer_id) {
    return btga_net_decode_header(header, packet, packet_size) &&
           header->session_id == session_id &&
           header->message_type == message_type &&
           header->flags == 0U && header->peer_id == peer_id;
}

int btga_net_client_session_init(BtgaNetClientSession* session,
                                 uint64_t session_id, uint8_t platform,
                                 uint32_t capabilities,
                                 const uint8_t* join_token,
                                 uint16_t join_token_size,
                                 const uint8_t client_nonce[BTGA_NET_NONCE_SIZE],
                                 uint32_t initial_sequence) {
    uint8_t probe[BTGA_NET_MAX_PAYLOAD_SIZE];
    BtgaNetHello hello;
    if (session == NULL || join_token == NULL || client_nonce == NULL ||
        join_token_size > BTGA_NET_MAX_JOIN_TOKEN_SIZE) return 0;
    memset(session, 0, sizeof(*session));
    hello.platform = platform;
    hello.capabilities = capabilities;
    memcpy(hello.client_nonce, client_nonce, BTGA_NET_NONCE_SIZE);
    hello.join_token = join_token;
    hello.join_token_size = join_token_size;
    if (btga_net_encode_hello(probe, sizeof(probe), &hello) == 0U) return 0;
    session->session_id = session_id;
    session->platform = platform;
    session->capabilities = capabilities;
    session->next_sequence = initial_sequence;
    session->token_size = join_token_size;
    memcpy(session->client_nonce, client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(session->token, join_token, join_token_size);
    session->state = BTGA_NET_CLIENT_READY;
    return 1;
}

size_t btga_net_client_build_hello(BtgaNetClientSession* session,
                                   uint8_t* packet, size_t packet_capacity) {
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    BtgaNetHello hello;
    size_t payload_size, packet_size;
    if (session == NULL || session->state != BTGA_NET_CLIENT_READY) return 0U;
    hello.platform = session->platform;
    hello.capabilities = session->capabilities;
    memcpy(hello.client_nonce, session->client_nonce, BTGA_NET_NONCE_SIZE);
    hello.join_token = session->token;
    hello.join_token_size = session->token_size;
    payload_size = btga_net_encode_hello(payload, sizeof(payload), &hello);
    packet_size = encode_packet(packet, packet_capacity, session->session_id,
                                session->next_sequence, BTGA_NET_MSG_HELLO,
                                BTGA_NET_UNASSIGNED_PEER_ID,
                                payload, payload_size);
    if (packet_size != 0U) {
        session->next_sequence += 1U;
        session->state = BTGA_NET_CLIENT_HELLO_SENT;
    }
    return packet_size;
}

int btga_net_client_accept_challenge(BtgaNetClientSession* session,
                                     const uint8_t* packet,
                                     size_t packet_size) {
    BtgaNetHeader header;
    BtgaNetChallenge challenge;
    if (session == NULL || session->state != BTGA_NET_CLIENT_HELLO_SENT ||
        !decode_handshake_header(&header, packet, packet_size,
                                 session->session_id, BTGA_NET_MSG_CHALLENGE, 0U) ||
        !btga_net_decode_challenge(&challenge, packet + BTGA_NET_HEADER_SIZE,
                                   header.payload_size) ||
        memcmp(challenge.client_nonce, session->client_nonce,
               BTGA_NET_NONCE_SIZE) != 0) return 0;
    memcpy(session->host_nonce, challenge.host_nonce, BTGA_NET_NONCE_SIZE);
    session->state = BTGA_NET_CLIENT_CHALLENGED;
    return 1;
}

size_t btga_net_client_build_authenticate(BtgaNetClientSession* session,
                                          uint8_t* packet,
                                          size_t packet_capacity) {
    uint8_t payload[BTGA_NET_AUTHENTICATE_SIZE];
    BtgaNetChallenge challenge;
    size_t payload_size, packet_size;
    if (session == NULL || session->state != BTGA_NET_CLIENT_CHALLENGED) return 0U;
    memcpy(challenge.client_nonce, session->client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(challenge.host_nonce, session->host_nonce, BTGA_NET_NONCE_SIZE);
    payload_size = btga_net_encode_authenticate(payload, sizeof(payload), &challenge);
    packet_size = encode_packet(packet, packet_capacity, session->session_id,
                                session->next_sequence, BTGA_NET_MSG_AUTHENTICATE,
                                BTGA_NET_UNASSIGNED_PEER_ID,
                                payload, payload_size);
    if (packet_size != 0U) {
        session->next_sequence += 1U;
        session->state = BTGA_NET_CLIENT_AUTH_SENT;
    }
    return packet_size;
}

int btga_net_client_accept_welcome(BtgaNetClientSession* session,
                                   BtgaNetWelcome* welcome,
                                   BtgaNetEndpoint* endpoint,
                                   const uint8_t* packet,
                                   size_t packet_size) {
    BtgaNetHeader header;
    BtgaNetWelcome decoded;
    if (session == NULL || welcome == NULL || endpoint == NULL ||
        session->state != BTGA_NET_CLIENT_AUTH_SENT ||
        !decode_handshake_header(&header, packet, packet_size,
                                 session->session_id, BTGA_NET_MSG_WELCOME, 0U) ||
        !btga_net_decode_welcome(&decoded, packet + BTGA_NET_HEADER_SIZE,
                                 header.payload_size) ||
        memcmp(decoded.client_nonce, session->client_nonce,
               BTGA_NET_NONCE_SIZE) != 0 ||
        !btga_net_endpoint_init(endpoint, session->session_id,
                                decoded.assigned_peer_id,
                                session->next_sequence)) return 0;
    *welcome = decoded;
    session->state = BTGA_NET_CLIENT_ESTABLISHED;
    return 1;
}

int btga_net_host_accept_hello(BtgaNetHostPending* pending,
                               uint64_t session_id,
                               const uint8_t host_nonce[BTGA_NET_NONCE_SIZE],
                               uint32_t initial_sequence,
                               const uint8_t* packet, size_t packet_size) {
    BtgaNetHeader header;
    BtgaNetHello hello;
    if (pending == NULL || host_nonce == NULL ||
        !decode_handshake_header(&header, packet, packet_size, session_id,
                                 BTGA_NET_MSG_HELLO,
                                 BTGA_NET_UNASSIGNED_PEER_ID) ||
        !btga_net_decode_hello(&hello, packet + BTGA_NET_HEADER_SIZE,
                               header.payload_size)) return 0;
    memset(pending, 0, sizeof(*pending));
    pending->session_id = session_id;
    pending->platform = hello.platform;
    pending->capabilities = hello.capabilities;
    pending->next_sequence = initial_sequence;
    pending->token_size = hello.join_token_size;
    memcpy(pending->client_nonce, hello.client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(pending->host_nonce, host_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(pending->token, hello.join_token, hello.join_token_size);
    pending->state = BTGA_NET_HOST_PENDING_HELLO;
    return 1;
}

size_t btga_net_host_build_challenge(BtgaNetHostPending* pending,
                                     uint8_t* packet,
                                     size_t packet_capacity) {
    uint8_t payload[BTGA_NET_CHALLENGE_SIZE];
    BtgaNetChallenge challenge;
    size_t payload_size, packet_size;
    if (pending == NULL || pending->state != BTGA_NET_HOST_PENDING_HELLO) return 0U;
    memcpy(challenge.client_nonce, pending->client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(challenge.host_nonce, pending->host_nonce, BTGA_NET_NONCE_SIZE);
    payload_size = btga_net_encode_challenge(payload, sizeof(payload), &challenge);
    packet_size = encode_packet(packet, packet_capacity, pending->session_id,
                                pending->next_sequence, BTGA_NET_MSG_CHALLENGE,
                                0U, payload, payload_size);
    if (packet_size != 0U) {
        pending->next_sequence += 1U;
        pending->state = BTGA_NET_HOST_PENDING_CHALLENGE_SENT;
    }
    return packet_size;
}

int btga_net_host_accept_authenticate(BtgaNetHostPending* pending,
                                      const uint8_t* packet,
                                      size_t packet_size) {
    BtgaNetHeader header;
    BtgaNetChallenge challenge;
    if (pending == NULL || pending->state != BTGA_NET_HOST_PENDING_CHALLENGE_SENT ||
        !decode_handshake_header(&header, packet, packet_size,
                                 pending->session_id,
                                 BTGA_NET_MSG_AUTHENTICATE,
                                 BTGA_NET_UNASSIGNED_PEER_ID) ||
        !btga_net_decode_authenticate(&challenge,
                                      packet + BTGA_NET_HEADER_SIZE,
                                      header.payload_size) ||
        memcmp(challenge.client_nonce, pending->client_nonce,
               BTGA_NET_NONCE_SIZE) != 0 ||
        memcmp(challenge.host_nonce, pending->host_nonce,
               BTGA_NET_NONCE_SIZE) != 0) return 0;
    pending->state = BTGA_NET_HOST_PENDING_AUTHENTICATED;
    return 1;
}

size_t btga_net_host_build_welcome(BtgaNetHostPending* pending,
                                   uint16_t assigned_peer_id,
                                   uint16_t max_players,
                                   uint16_t simulation_hz,
                                   uint32_t initial_tick,
                                   uint8_t* packet,
                                   size_t packet_capacity) {
    uint8_t payload[BTGA_NET_WELCOME_SIZE];
    BtgaNetWelcome welcome;
    size_t payload_size, packet_size;
    if (pending == NULL ||
        pending->state != BTGA_NET_HOST_PENDING_AUTHENTICATED) return 0U;
    memcpy(welcome.client_nonce, pending->client_nonce, BTGA_NET_NONCE_SIZE);
    welcome.assigned_peer_id = assigned_peer_id;
    welcome.max_players = max_players;
    welcome.simulation_hz = simulation_hz;
    welcome.initial_tick = initial_tick;
    payload_size = btga_net_encode_welcome(payload, sizeof(payload), &welcome);
    packet_size = encode_packet(packet, packet_capacity, pending->session_id,
                                pending->next_sequence, BTGA_NET_MSG_WELCOME,
                                0U, payload, payload_size);
    if (packet_size != 0U) {
        pending->next_sequence += 1U;
        pending->state = BTGA_NET_HOST_PENDING_ESTABLISHED;
    }
    return packet_size;
}
