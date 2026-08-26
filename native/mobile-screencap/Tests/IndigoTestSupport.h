#import <Foundation/Foundation.h>
#import <xpc/xpc.h>

#import "SimulatorIndigoHid.h"

NS_ASSUME_NONNULL_BEGIN

/// Test-only Indigo builders.
///
/// The real `IndigoHIDMessageFor*` symbols live in SimulatorKit and cannot be exercised
/// deterministically, so these stand in for them: they `calloc` a message of the same shape, record
/// their arguments, and let the wire layout and allocator ownership of `MCIndigoMessageBuilder` be
/// asserted without a simulator.
@interface MCFakeIndigoBuilders : NSObject

/// Arguments the fake mouse builder last received.
@property (class, nonatomic, readonly) int32_t lastMouseTarget;
@property (class, nonatomic, readonly) int32_t lastMouseType;
@property (class, nonatomic, readonly) BOOL lastMouseHadSecondPoint;
@property (class, nonatomic, readonly) CGPoint lastMousePoint;

/// Arguments the fake button builder last received.
@property (class, nonatomic, readonly) int32_t lastButtonSource;
@property (class, nonatomic, readonly) int32_t lastButtonType;
@property (class, nonatomic, readonly) int32_t lastButtonTarget;

/// Arguments the fake keyboard builder last received.
@property (class, nonatomic, readonly) int32_t lastKeyboardCode;
@property (class, nonatomic, readonly) int32_t lastKeyboardType;

/// How many messages the fake builders allocated. A touch message sources one allocation that
/// `MCIndigoMessageBuilder` must free itself; button and keyboard messages hand ownership to the
/// returned `NSData`.
@property (class, nonatomic, readonly) NSInteger allocationCount;

+ (void)reset;

/// A builder wired to the fakes.
+ (MCIndigoMessageBuilder *)builder;

@end

/// Wire-layout accessors the Swift harness reads without redeclaring the packed structs.
extern size_t MCIndigoPayloadWireSize(void);
extern size_t MCIndigoMessageWireSize(void);
extern size_t MCIndigoTouchWireSize(void);
extern unsigned int MCIndigoMessageInnerSize(NSData *message);
extern unsigned char MCIndigoMessageEventType(NSData *message);
extern unsigned int MCIndigoMessageEventKind(NSData *message);
extern double MCIndigoMessageTouchXRatio(NSData *message);
extern double MCIndigoMessageTouchYRatio(NSData *message);
extern unsigned int MCIndigoMessageSecondContactField1(NSData *message);
extern unsigned int MCIndigoMessageSecondContactField2(NSData *message);
extern unsigned int MCIndigoMessageButtonSource(NSData *message);
extern unsigned int MCIndigoMessageButtonType(NSData *message);
extern unsigned int MCIndigoMessageButtonTarget(NSData *message);

NS_ASSUME_NONNULL_END

NS_ASSUME_NONNULL_BEGIN

/// XPC probes so the DTUHID envelope's keys and wire types can be asserted from Swift.
extern NSString *MCXpcTypeName(xpc_object_t container, NSString *key);
extern NSString *_Nullable MCXpcStringValue(xpc_object_t container, NSString *key);
extern uint64_t MCXpcUInt64Value(xpc_object_t container, NSString *key);
extern double MCXpcDoubleValue(xpc_object_t container, NSString *key);
extern BOOL MCXpcBoolValue(xpc_object_t container, NSString *key);
extern xpc_object_t _Nullable MCXpcDictionaryValue(xpc_object_t container, NSString *key);
extern NSArray<NSString *> *MCXpcKeys(xpc_object_t container);

NS_ASSUME_NONNULL_END
