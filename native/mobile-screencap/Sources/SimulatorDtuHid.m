#import "SimulatorDtuHid.h"

#import "SimulatorDeviceBridge.h"

#import <dlfcn.h>

// Adapted from Meta's idb FBSimulatorDTUHIDTransport (MIT); see the repository LICENSE.

static NSString *const MCDtuHidDigitizerServiceName = @"com.apple.coredevice.feature.remote.hid.digitizer";

/// How long `drain` waits for `dtuhidd` to consume the events already sent.
///
/// The XPC send barrier confirms only that the bytes reached the connection, and `dtuhidd` neither
/// replies to events nor to barriers, so a bounded wait is the only signal available. `dtuhidd`
/// resets its virtual services the instant the host peer disconnects, so a gesture whose events are
/// still queued when the connection goes away is dropped.
static const uint64_t MCDtuHidDrainNanoseconds = 80ull * NSEC_PER_MSEC;

typedef xpc_object_t _Nullable (*MCXpcEndpointFromMachPortFn)(mach_port_t port, uint64_t flags, uint64_t reserved);
typedef xpc_connection_t _Nullable (*MCXpcConnectionFromEndpointFn)(xpc_object_t endpoint);
typedef void (*MCXpcEnableSim2HostFn)(xpc_connection_t connection);

typedef struct {
    MCXpcEndpointFromMachPortFn endpointFromPort;
    MCXpcConnectionFromEndpointFn connectionFromEndpoint;
    MCXpcEnableSim2HostFn enableSim2Host;
} MCDtuHidSymbols;

static BOOL MCResolveDtuHidSymbols(MCDtuHidSymbols *symbols)
{
    void *handle = dlopen(NULL, RTLD_NOW);
    if (handle == NULL) {
        return NO;
    }
    void *endpoint = dlsym(handle, "xpc_endpoint_create_mach_port_4sim");
    void *connection = dlsym(handle, "xpc_connection_create_from_endpoint");
    void *enable = dlsym(handle, "xpc_connection_enable_sim2host_4sim");
    if (endpoint == NULL || connection == NULL || enable == NULL) {
        return NO;
    }
    if (symbols != NULL) {
        symbols->endpointFromPort = (MCXpcEndpointFromMachPortFn)endpoint;
        symbols->connectionFromEndpoint = (MCXpcConnectionFromEndpointFn)connection;
        symbols->enableSim2Host = (MCXpcEnableSim2HostFn)enable;
    }
    return YES;
}

xpc_object_t MCDtuHidEncodeMessage(NSString *messageType, xpc_object_t payload)
{
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_string(message, "messageType", messageType.UTF8String);
    xpc_dictionary_set_bool(message, "isBarrier", false);
    xpc_dictionary_set_string(message, "featureIdentifier", MCDtuHidDigitizerServiceName.UTF8String);
    xpc_dictionary_set_value(message, "payload", payload);
    return message;
}

xpc_object_t MCDtuHidEncodeDigitizerPayload(double x, double y, MCDtuHidEventType eventType)
{
    xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_double(point, "x", x);
    xpc_dictionary_set_double(point, "y", y);

    xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_value(payload, "pointOne", point);
    // `pointTwo` is omitted entirely for a single contact, matching the single-contact wire shape.
    xpc_dictionary_set_uint64(payload, "eventType", (uint64_t)eventType);
    xpc_dictionary_set_uint64(payload, "edge", 0);
    xpc_dictionary_set_uint64(payload, "target", 0);
    return payload;
}

xpc_object_t MCDtuHidEncodeKeyboardPayload(uint64_t usageCode, MCDtuHidButtonState state)
{
    xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(payload, "usageCode", usageCode);
    xpc_dictionary_set_uint64(payload, "state", (uint64_t)state);
    return payload;
}

xpc_object_t MCDtuHidEncodeButtonPayload(uint64_t usagePage, uint64_t usageCode, MCDtuHidButtonState state)
{
    xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(payload, "usagePage", usagePage);
    xpc_dictionary_set_uint64(payload, "usageCode", usageCode);
    xpc_dictionary_set_uint64(payload, "state", (uint64_t)state);
    return payload;
}

BOOL MCDtuHidConsumerUsageForButton(MCHidButton button, uint64_t *usagePage, uint64_t *usageCode)
{
    uint64_t page = 0x0C;
    uint64_t code;
    switch (button) {
        case MCHidButtonHome:
            code = 0x40; // Consumer: Menu
            break;
        case MCHidButtonLock:
        case MCHidButtonSide:
            code = 0x30; // Consumer: Power; the side button is the power/lock button
            break;
        case MCHidButtonSiri:
            code = 0xCF; // Consumer: Voice Command
            break;
        case MCHidButtonApplePay:
        default:
            // Apple Pay is a double side-button press, not a single usage.
            return NO;
    }
    if (usagePage != NULL) {
        *usagePage = page;
    }
    if (usageCode != NULL) {
        *usageCode = code;
    }
    return YES;
}

@implementation MCDtuHidContactTracker {
    BOOL _active;
}

- (BOOL)active
{
    return _active;
}

- (MCDtuHidEventType)eventTypeForDirection:(MCHidDirection)direction
{
    if (direction == MCHidDirectionUp) {
        _active = NO;
        return MCDtuHidEventTypeEnd;
    }
    if (_active) {
        return MCDtuHidEventTypePosition;
    }
    _active = YES;
    return MCDtuHidEventTypeStart;
}

- (void)reset
{
    _active = NO;
}

@end

@interface MCDtuHidTransport ()
@property (nonatomic, strong) MCDtuHidContactTracker *contact;
@property (atomic, assign, readwrite, getter=isConnected) BOOL connected;
@property (atomic, copy, readwrite, nullable) NSString *failureReason;
- (instancetype)initWithConnection:(xpc_connection_t)connection;
- (void)markFailed:(NSString *)reason;
@end

@implementation MCDtuHidTransport {
    xpc_connection_t _connection;
}

+ (NSString *)digitizerServiceName
{
    return MCDtuHidDigitizerServiceName;
}

+ (BOOL)areXPCSymbolsAvailable
{
    return MCResolveDtuHidSymbols(NULL);
}

+ (nullable instancetype)transportForDevice:(MCSimulatorDevice *)device error:(NSError **)error
{
    MCDtuHidSymbols symbols = {0};
    if (!MCResolveDtuHidSymbols(&symbols)) {
        if (error != NULL) {
            *error = MCSimulatorError(
                30, @"The private _4sim XPC endpoint symbols DTUHID needs are unavailable", nil);
        }
        return nil;
    }

    NSError *lookupError = nil;
    mach_port_t servicePort = [device lookupService:MCDtuHidDigitizerServiceName error:&lookupError];
    if (servicePort == MACH_PORT_NULL) {
        if (error != NULL) {
            *error = MCSimulatorError(
                31,
                [NSString stringWithFormat:@"The simulator did not publish %@", MCDtuHidDigitizerServiceName],
                lookupError);
        }
        return nil;
    }

    xpc_object_t endpoint = symbols.endpointFromPort(servicePort, 0, 0);
    if (endpoint == NULL) {
        if (error != NULL) {
            *error = MCSimulatorError(32, @"Could not build an XPC endpoint for the DTUHID digitizer", nil);
        }
        return nil;
    }
    xpc_connection_t connection = symbols.connectionFromEndpoint(endpoint);
    if (connection == NULL) {
        if (error != NULL) {
            *error = MCSimulatorError(33, @"Could not open an XPC connection to the DTUHID digitizer", nil);
        }
        return nil;
    }

    // Without this the daemon observes the peer but never the payload.
    symbols.enableSim2Host(connection);

    MCDtuHidTransport *transport = [[MCDtuHidTransport alloc] initWithConnection:connection];
    __weak MCDtuHidTransport *weakTransport = transport;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (event == XPC_ERROR_CONNECTION_INTERRUPTED) {
            [weakTransport markFailed:@"the DTUHID XPC connection was interrupted"];
        } else if (event == XPC_ERROR_CONNECTION_INVALID) {
            [weakTransport markFailed:@"the DTUHID XPC connection was invalidated"];
        }
    });
    xpc_connection_resume(connection);
    return transport;
}

- (instancetype)initWithConnection:(xpc_connection_t)connection
{
    self = [super init];
    if (self == nil) {
        return nil;
    }
    _connection = connection;
    _contact = [[MCDtuHidContactTracker alloc] init];
    _connected = YES;
    return self;
}

- (void)markFailed:(NSString *)reason
{
    if (!self.connected) {
        return;
    }
    self.connected = NO;
    self.failureReason = reason;
}

- (BOOL)ensureConnected:(NSError **)error
{
    if (self.connected) {
        return YES;
    }
    if (error != NULL) {
        *error = MCSimulatorError(34, self.failureReason ?: @"the DTUHID transport is disconnected", nil);
    }
    return NO;
}

- (BOOL)sendMessageType:(NSString *)messageType payload:(xpc_object_t)payload error:(NSError **)error
{
    if (![self ensureConnected:error]) {
        return NO;
    }
    xpc_object_t message = MCDtuHidEncodeMessage(messageType, payload);
    dispatch_semaphore_t barrier = dispatch_semaphore_create(0);
    xpc_connection_send_message(_connection, message);
    xpc_connection_send_barrier(_connection, ^{
        dispatch_semaphore_signal(barrier);
    });
    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(barrier, deadline) != 0) {
        [self markFailed:@"the DTUHID XPC send barrier did not fire"];
        if (error != NULL) {
            *error = MCSimulatorError(35, @"The DTUHID XPC send barrier did not fire", nil);
        }
        return NO;
    }
    // A barrier that fired after the connection died means the bytes went nowhere.
    return [self ensureConnected:error];
}

- (BOOL)sendTouchWithRatio:(CGPoint)ratio direction:(MCHidDirection)direction error:(NSError **)error
{
    MCDtuHidEventType eventType = [self.contact eventTypeForDirection:direction];
    xpc_object_t payload = MCDtuHidEncodeDigitizerPayload(ratio.x, ratio.y, eventType);
    return [self sendMessageType:@"IndigoDigitizerEvent" payload:payload error:error];
}

- (BOOL)sendKeyboardUsage:(uint32_t)usageCode direction:(MCHidDirection)direction error:(NSError **)error
{
    MCDtuHidButtonState state =
        direction == MCHidDirectionDown ? MCDtuHidButtonStateDown : MCDtuHidButtonStateUp;
    xpc_object_t payload = MCDtuHidEncodeKeyboardPayload(usageCode, state);
    return [self sendMessageType:@"IndigoKeyboardButtonEvent" payload:payload error:error];
}

- (BOOL)sendButton:(MCHidButton)button direction:(MCHidDirection)direction error:(NSError **)error
{
    uint64_t usagePage = 0;
    uint64_t usageCode = 0;
    if (!MCDtuHidConsumerUsageForButton(button, &usagePage, &usageCode)) {
        if (error != NULL) {
            *error = MCSimulatorError(
                36,
                @"This button has no single DTUHID usage; send it as a side-button sequence instead",
                nil);
        }
        return NO;
    }
    MCDtuHidButtonState state =
        direction == MCHidDirectionDown ? MCDtuHidButtonStateDown : MCDtuHidButtonStateUp;
    xpc_object_t payload = MCDtuHidEncodeButtonPayload(usagePage, usageCode, state);
    return [self sendMessageType:@"IndigoButtonEvent" payload:payload error:error];
}

- (void)drain
{
    if (!self.connected) {
        return;
    }
    struct timespec wait = {
        .tv_sec = (time_t)(MCDtuHidDrainNanoseconds / NSEC_PER_SEC),
        .tv_nsec = (long)(MCDtuHidDrainNanoseconds % NSEC_PER_SEC),
    };
    nanosleep(&wait, NULL);
}

- (BOOL)hasActiveContact
{
    return self.contact.active;
}

- (void)disconnect
{
    if (_connection != NULL) {
        xpc_connection_cancel(_connection);
    }
    self.connected = NO;
    [self.contact reset];
}

@end
