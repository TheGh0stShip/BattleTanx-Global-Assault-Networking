#include "btga/btga_reliability.h"

#include <stdint.h>
#include <stdio.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static int test_in_order_and_gaps(void) {
    BtgaNetReceiveWindow window;

    btga_net_receive_window_init(&window);
    CHECK(btga_net_receive_window_record(&window, 100U) == BTGA_NET_RECEIVE_NEW);
    CHECK(btga_net_receive_window_record(&window, 100U) == BTGA_NET_RECEIVE_DUPLICATE);
    CHECK(btga_net_receive_window_record(&window, 103U) == BTGA_NET_RECEIVE_NEW);
    CHECK(window.most_recent == 103U);
    CHECK(window.acknowledgment_bits == UINT32_C(0x00000004));
    CHECK(btga_net_receive_window_record(&window, 101U) == BTGA_NET_RECEIVE_NEW);
    CHECK(window.acknowledgment_bits == UINT32_C(0x00000006));
    CHECK(btga_net_receive_window_record(&window, 101U) == BTGA_NET_RECEIVE_DUPLICATE);
    CHECK(btga_net_sequence_is_acknowledged(103U, window.most_recent,
                                             window.acknowledgment_bits));
    CHECK(btga_net_sequence_is_acknowledged(101U, window.most_recent,
                                             window.acknowledgment_bits));
    CHECK(!btga_net_sequence_is_acknowledged(102U, window.most_recent,
                                              window.acknowledgment_bits));
    return 0;
}

static int test_window_edges(void) {
    BtgaNetReceiveWindow window;

    btga_net_receive_window_init(&window);
    CHECK(btga_net_receive_window_record(&window, 100U) == BTGA_NET_RECEIVE_NEW);
    CHECK(btga_net_receive_window_record(&window, 132U) == BTGA_NET_RECEIVE_NEW);
    CHECK(window.acknowledgment_bits == UINT32_C(0x80000000));
    CHECK(btga_net_receive_window_record(&window, 100U) == BTGA_NET_RECEIVE_DUPLICATE);
    CHECK(btga_net_receive_window_record(&window, 99U) == BTGA_NET_RECEIVE_TOO_OLD);
    CHECK(btga_net_receive_window_record(&window, 200U) == BTGA_NET_RECEIVE_NEW);
    CHECK(window.acknowledgment_bits == 0U);
    return 0;
}

static int test_wraparound(void) {
    BtgaNetReceiveWindow window;

    btga_net_receive_window_init(&window);
    CHECK(btga_net_sequence_more_recent(0U, UINT32_MAX));
    CHECK(!btga_net_sequence_more_recent(UINT32_MAX, 0U));
    CHECK(!btga_net_sequence_more_recent(UINT32_C(0x80000000), 0U));
    CHECK(btga_net_receive_window_record(&window, UINT32_MAX - 1U) ==
          BTGA_NET_RECEIVE_NEW);
    CHECK(btga_net_receive_window_record(&window, UINT32_MAX) == BTGA_NET_RECEIVE_NEW);
    CHECK(btga_net_receive_window_record(&window, 0U) == BTGA_NET_RECEIVE_NEW);
    CHECK(window.most_recent == 0U);
    CHECK(window.acknowledgment_bits == UINT32_C(0x00000003));
    CHECK(btga_net_sequence_is_acknowledged(UINT32_MAX, 0U,
                                             window.acknowledgment_bits));
    return 0;
}

int main(void) {
    CHECK(test_in_order_and_gaps() == 0);
    CHECK(test_window_edges() == 0);
    CHECK(test_wraparound() == 0);
    CHECK(btga_net_receive_window_record(NULL, 0U) == BTGA_NET_RECEIVE_TOO_OLD);
    return 0;
}
