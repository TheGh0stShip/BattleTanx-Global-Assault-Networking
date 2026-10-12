cmake_minimum_required(VERSION 3.20)
project(BattleTanxGA_Networking_Consumer LANGUAGES C)

find_package(BattleTanxGANetworking 0.1 CONFIG REQUIRED)

add_executable(btga_net_consumer main.c)
target_link_libraries(btga_net_consumer PRIVATE BattleTanxGA::NetProtocol)
