cmake_minimum_required(VERSION 3.20)
project(BattleTanxGA_Networking VERSION 0.1.0 LANGUAGES C)

include(CMakePackageConfigHelpers)
include(GNUInstallDirs)

option(BTGA_NET_BUILD_TESTS "Build protocol conformance tests" ON)

add_library(btga_net_protocol STATIC
    protocol/src/btga_net.c
    protocol/src/btga_reliability.c)
add_library(BattleTanxGA::NetProtocol ALIAS btga_net_protocol)
target_include_directories(btga_net_protocol PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/protocol/include>
    $<INSTALL_INTERFACE:include>)
target_compile_features(btga_net_protocol PUBLIC c_std_99)
set_target_properties(btga_net_protocol PROPERTIES
    EXPORT_NAME NetProtocol
    POSITION_INDEPENDENT_CODE ON)

if(MSVC)
    target_compile_options(btga_net_protocol PRIVATE /W4 /WX)
else()
    target_compile_options(btga_net_protocol PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

install(TARGETS btga_net_protocol
    EXPORT BattleTanxGANetworkingTargets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(DIRECTORY protocol/include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(EXPORT BattleTanxGANetworkingTargets
    FILE BattleTanxGANetworkingTargets.cmake
    NAMESPACE BattleTanxGA::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/BattleTanxGANetworking)

configure_package_config_file(
    cmake/BattleTanxGANetworkingConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/BattleTanxGANetworkingConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/BattleTanxGANetworking)
write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/BattleTanxGANetworkingConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion)
install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/BattleTanxGANetworkingConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/BattleTanxGANetworkingConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/BattleTanxGANetworking)
if(BTGA_NET_BUILD_TESTS)
    enable_testing()
    add_executable(btga_net_protocol_tests tests/protocol_tests.c)
    target_link_libraries(btga_net_protocol_tests PRIVATE btga_net_protocol)
    if(MSVC)
        target_compile_options(btga_net_protocol_tests PRIVATE /W4 /WX)
    else()
        target_compile_options(btga_net_protocol_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME protocol_conformance COMMAND btga_net_protocol_tests)

    add_executable(btga_net_reliability_tests tests/reliability_tests.c)
    target_link_libraries(btga_net_reliability_tests PRIVATE btga_net_protocol)
    if(MSVC)
        target_compile_options(btga_net_reliability_tests PRIVATE /W4 /WX)
    else()
        target_compile_options(btga_net_reliability_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME reliability_window COMMAND btga_net_reliability_tests)
endif()
