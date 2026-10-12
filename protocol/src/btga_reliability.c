#include "btga/btga_reliability.h"

#include <stddef.h>

#define BTGA_NET_SEQUENCE_HALF_RANGE UINT32_C(0x80000000)
#define BTGA_NET_ACK_WINDOW_BITS 32U

void btga_net_receive_window_init(BtgaNetReceiveWindow* window) {
    if (window != NULL) {
        window->most_recent = 0U;
        window->acknowledgment_bits = 0U;
        window->initialized = 0U;
    }
}

int btga_net_sequence_more_recent(uint32_t left, uint32_t right) {
    const uint32_t difference = left - right;
    return difference != 0U && difference < BTGA_NET_SEQUENCE_HALF_RANGE;
}

BtgaNetReceiveResult btga_net_receive_window_record(BtgaNetReceiveWindow* window,
                                                    uint32_t sequence) {
    uint32_t distance;
    uint32_t mask;

    if (window == NULL) {
        return BTGA_NET_RECEIVE_TOO_OLD;
    }
    if (window->initialized == 0U) {
        window->most_recent = sequence;
        window->acknowledgment_bits = 0U;
        window->initialized = 1U;
        return BTGA_NET_RECEIVE_NEW;
    }
    if (sequence == window->most_recent) {
        return BTGA_NET_RECEIVE_DUPLICATE;
    }
    if (btga_net_sequence_more_recent(sequence, window->most_recent)) {
        distance = sequence - window->most_recent;
        if (distance > BTGA_NET_ACK_WINDOW_BITS) {
            window->acknowledgment_bits = 0U;
        } else if (distance == BTGA_NET_ACK_WINDOW_BITS) {
            window->acknowledgment_bits = UINT32_C(1) << 31;
        } else {
            window->acknowledgment_bits =
                (window->acknowledgment_bits << distance) |
                (UINT32_C(1) << (distance - 1U));
        }
        window->most_recent = sequence;
        return BTGA_NET_RECEIVE_NEW;
    }

    distance = window->most_recent - sequence;
    if (distance == 0U || distance > BTGA_NET_ACK_WINDOW_BITS) {
        return BTGA_NET_RECEIVE_TOO_OLD;
    }
    mask = UINT32_C(1) << (distance - 1U);
    if ((window->acknowledgment_bits & mask) != 0U) {
        return BTGA_NET_RECEIVE_DUPLICATE;
    }
    window->acknowledgment_bits |= mask;
    return BTGA_NET_RECEIVE_NEW;
}

int btga_net_sequence_is_acknowledged(uint32_t sequence, uint32_t acknowledgment,
                                      uint32_t acknowledgment_bits) {
    uint32_t distance;

    if (sequence == acknowledgment) {
        return 1;
    }
    if (btga_net_sequence_more_recent(sequence, acknowledgment)) {
        return 0;
    }
    distance = acknowledgment - sequence;
    return distance >= 1U && distance <= BTGA_NET_ACK_WINDOW_BITS &&
           (acknowledgment_bits & (UINT32_C(1) << (distance - 1U))) != 0U;
}
