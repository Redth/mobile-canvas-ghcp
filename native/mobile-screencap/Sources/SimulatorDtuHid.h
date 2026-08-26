#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <xpc/xpc.h>

#import "SimulatorIndigoHid.h"

NS_ASSUME_NONNULL_BEGIN

@class MCSimulatorDevice;

/// The `dtuhidd` per-contact digitizer phase. `dtuhidd` decodes these as `uint64`.
typedef NS_ENUM(uint64_t, MCDtuHidEventType) {
    MCDtuHidEventTypeStart = 0,
    MCDtuHidEventTypePosition = 1,
    MCDtuHidEventTypeEnd = 2,
};

/// The `dtuhidd` `HIDButtonState`. It is 1-based; `0` is rejected at decode.
typedef NS_ENUM(uint64_t, MCDtuHidButtonState) {
    MCDtuHidButtonStateDown = 1,
    MCDtuHidButtonStateUp = 2,
};

/// Maps a stream of down/up primitives onto `dtuhidd`'s start/position/end contact model: the first
/// `down` starts a contact, later `down`s are positions, and `up` ends it.
@interface MCDtuHidContactTracker : NSObject
@property (nonatomic, readonly) BOOL active;
- (MCDtuHidEventType)eventTypeForDirection:(MCHidDirection)direction
    NS_SWIFT_NAME(eventType(direction:));
- (void)reset;
@end

/// The Xcode 27+ DTUHID transport.
///
/// Events cross the host→guest boundary as plain-XPC dictionaries delivered to the
/// `com.apple.coredevice.feature.remote.hid.digitizer` service. The connection is built from the
/// simulator's Mach port through the private `_4sim` endpoint symbols, and has to be marked
/// simulator-to-host before any payload reaches the service handler.
@interface MCDtuHidTransport : NSObject

@property (class, nonatomic, readonly) NSString *digitizerServiceName;

/// Whether all three private `_4sim` XPC symbols are resolvable in this process. A static
/// negotiability check only; reaching `dtuhidd` still requires the service lookup to succeed.
@property (class, nonatomic, readonly, getter=areXPCSymbolsAvailable) BOOL xpcSymbolsAvailable;

/// Whether the connection is still usable. Cleared when XPC reports interruption or invalidation,
/// so input is never accepted into a dead connection.
@property (atomic, readonly, getter=isConnected) BOOL connected;

/// The reason the connection became unusable, when it did.
@property (atomic, copy, readonly, nullable) NSString *failureReason;

+ (nullable instancetype)transportForDevice:(MCSimulatorDevice *)device error:(NSError **)error
    NS_SWIFT_NAME(make(device:));

- (BOOL)sendTouchWithRatio:(CGPoint)ratio direction:(MCHidDirection)direction error:(NSError **)error
    NS_SWIFT_NAME(sendTouch(ratio:direction:));
- (BOOL)sendKeyboardUsage:(uint32_t)usageCode direction:(MCHidDirection)direction error:(NSError **)error
    NS_SWIFT_NAME(sendKeyboard(usage:direction:));
- (BOOL)sendButton:(MCHidButton)button direction:(MCHidDirection)direction error:(NSError **)error
    NS_SWIFT_NAME(sendButton(button:direction:));

/// Waits a bounded interval so `dtuhidd` consumes the events already handed to the connection.
/// Run once per completed gesture or batch, never per primitive.
- (void)drain;

/// Whether a digitizer contact is currently down, so shutdown can lift it.
- (BOOL)hasActiveContact;

- (void)disconnect;

- (instancetype)init NS_UNAVAILABLE;

@end

/// Builds the plain-XPC envelope `dtuhidd` decodes. Exposed so the wire shape can be asserted
/// without a live daemon connection.
extern xpc_object_t MCDtuHidEncodeMessage(NSString *messageType, xpc_object_t payload);

/// Builds an `IndigoDigitizerEvent` payload for a single contact.
extern xpc_object_t MCDtuHidEncodeDigitizerPayload(double x, double y, MCDtuHidEventType eventType);

/// Builds an `IndigoKeyboardButtonEvent` payload.
extern xpc_object_t MCDtuHidEncodeKeyboardPayload(uint64_t usageCode, MCDtuHidButtonState state);

/// Builds an `IndigoButtonEvent` payload.
extern xpc_object_t MCDtuHidEncodeButtonPayload(uint64_t usagePage, uint64_t usageCode, MCDtuHidButtonState state);

/// The Consumer-page usage for a hardware button, or `NO` when the button has no single usage.
/// Apple Pay is a double side-button press rather than one usage.
extern BOOL MCDtuHidConsumerUsageForButton(MCHidButton button, uint64_t *usagePage, uint64_t *usageCode);

NS_ASSUME_NONNULL_END
