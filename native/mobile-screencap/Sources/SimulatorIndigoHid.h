#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#import "IndigoWire.h"

NS_ASSUME_NONNULL_BEGIN

@class MCSimulatorDevice;

/// The direction of a HID primitive. The raw values are the Indigo wire values.
typedef NS_ENUM(int32_t, MCHidDirection) {
    MCHidDirectionDown = MCIndigoButtonEventTypeDown,
    MCHidDirectionUp = MCIndigoButtonEventTypeUp,
};

/// The hardware buttons the helper can drive.
typedef NS_ENUM(NSUInteger, MCHidButton) {
    MCHidButtonHome,
    MCHidButtonLock,
    MCHidButtonSide,
    MCHidButtonSiri,
    MCHidButtonApplePay,
};

/// The `IndigoHIDMessageFor*` entry points, resolved from SimulatorKit at runtime.
typedef MCIndigoMessage *_Nonnull (*MCIndigoMessageForButtonFn)(int32_t source, int32_t type, int32_t target);
typedef MCIndigoMessage *_Nonnull (*MCIndigoMessageForKeyboardArbitraryFn)(int32_t keyCode, int32_t type);
typedef MCIndigoMessage *_Nonnull (*MCIndigoMessageForMouseNSEventFn)(
    CGPoint *_Nullable point, CGPoint *_Nullable secondPoint, int32_t target, int32_t type, BOOL flag);

/// The candidate SimulatorKit locations, most-current first. Xcode 27 moved the framework to
/// `Contents/SharedFrameworks`; older Xcodes keep it under the Developer private frameworks.
extern NSArray<NSString *> *MCSimulatorKitCandidatePaths(NSString *developerDirectory);

/// Builds Indigo message bytes.
///
/// The three builder functions are injectable so the wire layout can be exercised without
/// SimulatorKit present.
@interface MCIndigoMessageBuilder : NSObject

/// Loads SimulatorKit from the selected developer directory and resolves the builder symbols.
/// The framework handle is kept alive for the process.
+ (nullable instancetype)builderWithDeveloperDirectory:(NSString *)developerDirectory
                                                 error:(NSError **)error
    NS_SWIFT_NAME(make(developerDirectory:));

- (instancetype)initWithButtonBuilder:(MCIndigoMessageForButtonFn)buttonBuilder
                      keyboardBuilder:(MCIndigoMessageForKeyboardArbitraryFn)keyboardBuilder
                         mouseBuilder:(MCIndigoMessageForMouseNSEventFn)mouseBuilder
    NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// A single-finger touch. `ratio` is the normalized 0...1 top-left screen position.
- (NSData *)touchMessageForRatio:(CGPoint)ratio direction:(MCHidDirection)direction
    NS_SWIFT_NAME(touchMessage(ratio:direction:));

/// A hardware button press, or `nil` when the button has no legacy Indigo source.
- (nullable NSData *)buttonMessageForButton:(MCHidButton)button direction:(MCHidDirection)direction
    NS_SWIFT_NAME(buttonMessage(button:direction:));

/// A keyboard event. `usageCode` is a USB HID keyboard usage.
- (NSData *)keyboardMessageForUsage:(uint32_t)usageCode direction:(MCHidDirection)direction
    NS_SWIFT_NAME(keyboardMessage(usage:direction:));

@end

/// Owns the runtime-only `SimulatorKit.SimDeviceLegacyHIDClient` and delivers Indigo bytes to it.
///
/// The class has relocated between Xcode releases, so it is resolved by Objective-C runtime name
/// after SimulatorKit is loaded rather than referenced as a link-time class.
@interface MCIndigoHidClient : NSObject

+ (nullable instancetype)clientForDevice:(MCSimulatorDevice *)device
                      developerDirectory:(NSString *)developerDirectory
                                   error:(NSError **)error
    NS_SWIFT_NAME(make(device:developerDirectory:));

/// Sends the message bytes, blocking until the client acknowledges delivery or `timeout` elapses.
///
/// Ownership: the bytes are copied into a fresh `malloc` block handed to the client with
/// `freeWhenDone:YES`. If the private message raises, the block is deliberately leaked — a raise
/// leaves no way to know whether ownership transferred, and one leaked message beats a double free.
- (BOOL)sendMessage:(NSData *)message timeout:(NSTimeInterval)timeout error:(NSError **)error
    NS_SWIFT_NAME(send(message:timeout:));

- (void)disconnect;

- (instancetype)init NS_UNAVAILABLE;

@end

NS_ASSUME_NONNULL_END
