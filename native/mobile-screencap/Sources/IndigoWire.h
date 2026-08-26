/**
 * Indigo HID wire format.
 *
 * Adapted from Meta's idb (`PrivateHeaders/SimulatorApp/Indigo.h`), which is licensed under the
 * MIT license:
 *
 *   Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Structures for the mach message protocol between the host `SimDeviceLegacyHIDClient` and the
 * guest `SimHIDVirtualServiceManager`, which dispatches on `IndigoPayload.eventKind` and target id.
 */

#import <Foundation/Foundation.h>

#pragma pack(push, 4)

/// Mirrors `mach_msg_header_t` with explicit types so it survives `#pragma pack(4)`.
typedef struct {
    unsigned int msgh_bits;         // 0x0
    unsigned int msgh_size;         // 0x4
    unsigned int msgh_remote_port;  // 0x8
    unsigned int msgh_local_port;   // 0xc
    unsigned int msgh_voucher_port; // 0x10
    int msgh_id;                    // 0x14
} MCIndigoMachHeader;

/// A digitizer contact. The location rides in `xRatio`/`yRatio` as 0...1 from the top left.
typedef struct {
    unsigned int field1;    // 0x30
    unsigned int field2;    // 0x34
    unsigned int eventMask; // 0x38 IOHIDDigitizerEventMask: Range 0x1 | Touch 0x2 | Position 0x4 | Identity 0x20
    double xRatio;          // 0x3c
    double yRatio;          // 0x44
    double field6;          // 0x4c
    double field7;          // 0x54
    double field8;          // 0x5c
    unsigned int range;     // 0x64 in-range / hover
    unsigned int touch;     // 0x68 contact down
    unsigned int field11;   // 0x6c
    unsigned int field12;   // 0x70
    unsigned int field13;   // 0x74
    double field14;         // 0x78
    double field15;         // 0x80
    double field16;         // 0x88
    double field17;         // 0x90
    double field18;         // 0x98
} MCIndigoTouch;

/// A hardware-button or keyboard event.
typedef struct {
    unsigned int eventSource; // 0x30
    unsigned int eventType;   // 0x34
    unsigned int eventTarget; // 0x38
    unsigned int keyCode;     // 0x3c
    unsigned int field5;      // 0x40
} MCIndigoButton;

/// A packed quad, equivalent to `NSEdgeInsets`.
typedef struct {
    double field1;
    double field2;
    double field3;
    double field4;
} MCIndigoQuad;

/// A game controller event. Present only because it is the widest union member, and therefore
/// determines `sizeof(MCIndigoPayload)` (0x90), which the hand-built touch message depends on.
typedef struct {
    MCIndigoQuad dpad;
    MCIndigoQuad face;
    MCIndigoQuad shoulder;
    MCIndigoQuad joystick;
} MCIndigoGameController;

typedef union {
    MCIndigoTouch touch;
    MCIndigoButton button;
    MCIndigoGameController gameController;
} MCIndigoEvent;

/// The payload embedded in an `MCIndigoMessage` below the mach headers.
typedef struct {
    unsigned int eventKind;       // 0x20 guest-side dispatch discriminator
    unsigned long long timestamp; // 0x24 mach_absolute_time()
    unsigned int field3;          // 0x2c
    MCIndigoEvent event;          // 0x30
} MCIndigoPayload;

/// The message delivered through `SimDeviceLegacyHIDClient`. A single-payload message is 0xC0 bytes.
typedef struct {
    MCIndigoMachHeader header; // 0x0
    unsigned int innerSize;    // 0x18
    unsigned char eventType;   // 0x1c
    MCIndigoPayload payload;   // 0x20
} MCIndigoMessage;

#define MCIndigoButtonEventSourceApplePay 0x1f4
#define MCIndigoButtonEventSourceHomeButton 0x0
#define MCIndigoButtonEventSourceLock 0x1
#define MCIndigoButtonEventSourceSideButton 0xbb8
#define MCIndigoButtonEventSourceSiri 0x400002

#define MCIndigoButtonEventTargetHardware 0x33

/// Derived from `NSEventTypeKeyDown`/`NSEventTypeKeyUp`, less 0xa.
#define MCIndigoButtonEventTypeDown 0x1
#define MCIndigoButtonEventTypeUp 0x2

#define MCIndigoEventTypeButton 1
#define MCIndigoEventTypeTouch 2

/// The `eventKind` a touch payload carries.
#define MCIndigoTouchEventKind 0x0000000B

/// Wire offset of the payload inside a message.
#define MCIndigoFirstPayloadOffset 0x20
/// Wire offset of the digitizer event inside a message.
#define MCIndigoEventOffset 0x30

#pragma pack(pop)
