#import "IndigoTestSupport.h"

#import "IndigoWire.h"

static int32_t sLastMouseTarget;
static int32_t sLastMouseType;
static BOOL sLastMouseHadSecondPoint;
static CGPoint sLastMousePoint;
static int32_t sLastButtonSource;
static int32_t sLastButtonType;
static int32_t sLastButtonTarget;
static int32_t sLastKeyboardCode;
static int32_t sLastKeyboardType;
static NSInteger sAllocationCount;

/// Allocates a message the same way the SimulatorKit builders do: `calloc`'d, single payload.
static MCIndigoMessage *MCFakeAllocateMessage(void)
{
    sAllocationCount += 1;
    MCIndigoMessage *message = calloc(1, sizeof(MCIndigoMessage));
    message->innerSize = 0xa0;
    return message;
}

static MCIndigoMessage *MCFakeMessageForButton(int32_t source, int32_t type, int32_t target)
{
    sLastButtonSource = source;
    sLastButtonType = type;
    sLastButtonTarget = target;
    MCIndigoMessage *message = MCFakeAllocateMessage();
    message->eventType = MCIndigoEventTypeButton;
    message->payload.eventKind = 2;
    message->payload.event.button.eventSource = (unsigned int)source;
    message->payload.event.button.eventType = (unsigned int)type;
    message->payload.event.button.eventTarget = (unsigned int)target;
    return message;
}

static MCIndigoMessage *MCFakeMessageForKeyboardArbitrary(int32_t keyCode, int32_t type)
{
    sLastKeyboardCode = keyCode;
    sLastKeyboardType = type;
    MCIndigoMessage *message = MCFakeAllocateMessage();
    message->eventType = MCIndigoEventTypeButton;
    message->payload.eventKind = 2;
    message->payload.event.button.eventSource = (unsigned int)keyCode;
    message->payload.event.button.eventType = (unsigned int)type;
    return message;
}

static MCIndigoMessage *MCFakeMessageForMouseNSEvent(
    CGPoint *point, CGPoint *secondPoint, int32_t target, int32_t type, BOOL flag)
{
    (void)flag;
    sLastMouseTarget = target;
    sLastMouseType = type;
    sLastMouseHadSecondPoint = secondPoint != NULL;
    sLastMousePoint = point != NULL ? *point : CGPointZero;
    MCIndigoMessage *message = MCFakeAllocateMessage();
    // The real builder emits a multi-touch message and does not store the caller's coordinates.
    message->eventType = 0x03;
    message->payload.eventKind = MCIndigoTouchEventKind;
    message->payload.event.touch.eventMask = 0x23;
    message->payload.event.touch.range = 1;
    message->payload.event.touch.touch = type == MCIndigoButtonEventTypeDown ? 1 : 0;
    message->payload.event.touch.field1 = 0x400002;
    message->payload.event.touch.field2 = 0x1;
    return message;
}

@implementation MCFakeIndigoBuilders

+ (int32_t)lastMouseTarget { return sLastMouseTarget; }
+ (int32_t)lastMouseType { return sLastMouseType; }
+ (BOOL)lastMouseHadSecondPoint { return sLastMouseHadSecondPoint; }
+ (CGPoint)lastMousePoint { return sLastMousePoint; }
+ (int32_t)lastButtonSource { return sLastButtonSource; }
+ (int32_t)lastButtonType { return sLastButtonType; }
+ (int32_t)lastButtonTarget { return sLastButtonTarget; }
+ (int32_t)lastKeyboardCode { return sLastKeyboardCode; }
+ (int32_t)lastKeyboardType { return sLastKeyboardType; }
+ (NSInteger)allocationCount { return sAllocationCount; }

+ (void)reset
{
    sLastMouseTarget = 0;
    sLastMouseType = 0;
    sLastMouseHadSecondPoint = NO;
    sLastMousePoint = CGPointZero;
    sLastButtonSource = 0;
    sLastButtonType = 0;
    sLastButtonTarget = 0;
    sLastKeyboardCode = 0;
    sLastKeyboardType = 0;
    sAllocationCount = 0;
}

+ (MCIndigoMessageBuilder *)builder
{
    return [[MCIndigoMessageBuilder alloc] initWithButtonBuilder:MCFakeMessageForButton
                                                 keyboardBuilder:MCFakeMessageForKeyboardArbitrary
                                                    mouseBuilder:MCFakeMessageForMouseNSEvent];
}

@end

size_t MCIndigoPayloadWireSize(void) { return sizeof(MCIndigoPayload); }
size_t MCIndigoMessageWireSize(void) { return sizeof(MCIndigoMessage); }
size_t MCIndigoTouchWireSize(void) { return sizeof(MCIndigoTouch); }

static const MCIndigoMessage *MCMessageBytes(NSData *message)
{
    return (const MCIndigoMessage *)message.bytes;
}

unsigned int MCIndigoMessageInnerSize(NSData *message) { return MCMessageBytes(message)->innerSize; }
unsigned char MCIndigoMessageEventType(NSData *message) { return MCMessageBytes(message)->eventType; }
unsigned int MCIndigoMessageEventKind(NSData *message) { return MCMessageBytes(message)->payload.eventKind; }
double MCIndigoMessageTouchXRatio(NSData *message) { return MCMessageBytes(message)->payload.event.touch.xRatio; }
double MCIndigoMessageTouchYRatio(NSData *message) { return MCMessageBytes(message)->payload.event.touch.yRatio; }

static const MCIndigoPayload *MCSecondPayload(NSData *message)
{
    const unsigned char *bytes = (const unsigned char *)message.bytes;
    return (const MCIndigoPayload *)(bytes + MCIndigoFirstPayloadOffset + sizeof(MCIndigoPayload));
}

unsigned int MCIndigoMessageSecondContactField1(NSData *message) { return MCSecondPayload(message)->event.touch.field1; }
unsigned int MCIndigoMessageSecondContactField2(NSData *message) { return MCSecondPayload(message)->event.touch.field2; }
unsigned int MCIndigoMessageButtonSource(NSData *message) { return MCMessageBytes(message)->payload.event.button.eventSource; }
unsigned int MCIndigoMessageButtonType(NSData *message) { return MCMessageBytes(message)->payload.event.button.eventType; }
unsigned int MCIndigoMessageButtonTarget(NSData *message) { return MCMessageBytes(message)->payload.event.button.eventTarget; }

NSString *MCXpcTypeName(xpc_object_t container, NSString *key)
{
    xpc_object_t value = xpc_dictionary_get_value(container, key.UTF8String);
    if (value == NULL) {
        return @"missing";
    }
    xpc_type_t type = xpc_get_type(value);
    if (type == XPC_TYPE_STRING) return @"string";
    if (type == XPC_TYPE_BOOL) return @"bool";
    if (type == XPC_TYPE_UINT64) return @"uint64";
    if (type == XPC_TYPE_INT64) return @"int64";
    if (type == XPC_TYPE_DOUBLE) return @"double";
    if (type == XPC_TYPE_DICTIONARY) return @"dictionary";
    return @"other";
}

NSString *_Nullable MCXpcStringValue(xpc_object_t container, NSString *key)
{
    const char *value = xpc_dictionary_get_string(container, key.UTF8String);
    return value != NULL ? [NSString stringWithUTF8String:value] : nil;
}

uint64_t MCXpcUInt64Value(xpc_object_t container, NSString *key)
{
    return xpc_dictionary_get_uint64(container, key.UTF8String);
}

double MCXpcDoubleValue(xpc_object_t container, NSString *key)
{
    return xpc_dictionary_get_double(container, key.UTF8String);
}

BOOL MCXpcBoolValue(xpc_object_t container, NSString *key)
{
    return xpc_dictionary_get_bool(container, key.UTF8String);
}

xpc_object_t _Nullable MCXpcDictionaryValue(xpc_object_t container, NSString *key)
{
    return xpc_dictionary_get_dictionary(container, key.UTF8String);
}

NSArray<NSString *> *MCXpcKeys(xpc_object_t container)
{
    NSMutableArray<NSString *> *keys = [NSMutableArray array];
    xpc_dictionary_apply(container, ^bool(const char *key, __unused xpc_object_t value) {
        [keys addObject:[NSString stringWithUTF8String:key]];
        return true;
    });
    [keys sortUsingSelector:@selector(compare:)];
    return keys;
}
