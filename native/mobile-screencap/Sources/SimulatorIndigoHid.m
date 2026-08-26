#import "SimulatorIndigoHid.h"

#import "SimulatorDeviceBridge.h"
#import "SimulatorPrivateAPI.h"

#import <dlfcn.h>
#import <mach/mach_time.h>
#import <malloc/malloc.h>
#import <objc/runtime.h>

// Adapted from Meta's idb FBSimulatorIndigoHID (MIT); see the repository LICENSE.

/// Informal protocol for messaging the runtime-only `SimDeviceLegacyHIDClient`.
@protocol MCSimDeviceLegacyHIDClient <NSObject>
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message
           freeWhenDone:(BOOL)freeWhenDone
        completionQueue:(dispatch_queue_t)completionQueue
             completion:(void (^)(NSError *_Nullable error))completion;
@end

static NSString *const MCIndigoClientClassName = @"SimulatorKit.SimDeviceLegacyHIDClient";

NSArray<NSString *> *MCSimulatorKitCandidatePaths(NSString *developerDirectory)
{
    NSString *trimmed = developerDirectory ?: @"";
    while (trimmed.length > 1 && [trimmed hasSuffix:@"/"]) {
        trimmed = [trimmed substringToIndex:trimmed.length - 1];
    }
    // `DEVELOPER_DIR` is `<App>/Contents/Developer`, so `Contents` is its parent.
    NSString *contents = trimmed.stringByDeletingLastPathComponent;
    return @[
        [contents stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
        [trimmed stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
    ];
}

/// Loads SimulatorKit once per process, keeping the handle alive for the session.
static void *MCLoadSimulatorKit(NSString *developerDirectory, NSError **error)
{
    static void *handle = NULL;
    static dispatch_once_t onceToken;
    static NSString *failureDetail = nil;
    dispatch_once(&onceToken, ^{
        NSMutableArray<NSString *> *attempted = [NSMutableArray array];
        for (NSString *candidate in MCSimulatorKitCandidatePaths(developerDirectory)) {
            [attempted addObject:candidate];
            handle = dlopen(candidate.fileSystemRepresentation, RTLD_LAZY | RTLD_LOCAL);
            if (handle != NULL) {
                return;
            }
        }
        failureDetail = [NSString stringWithFormat:@"SimulatorKit could not be loaded from %@",
                                                   [attempted componentsJoinedByString:@" or "]];
    });
    if (handle == NULL && error != NULL) {
        *error = MCSimulatorError(20, failureDetail ?: @"SimulatorKit could not be loaded", nil);
    }
    return handle;
}

@interface MCIndigoMessageBuilder ()
@property (nonatomic, assign) MCIndigoMessageForButtonFn buttonBuilder;
@property (nonatomic, assign) MCIndigoMessageForKeyboardArbitraryFn keyboardBuilder;
@property (nonatomic, assign) MCIndigoMessageForMouseNSEventFn mouseBuilder;
@end

@implementation MCIndigoMessageBuilder

+ (nullable instancetype)builderWithDeveloperDirectory:(NSString *)developerDirectory
                                                 error:(NSError **)error
{
    void *handle = MCLoadSimulatorKit(developerDirectory, error);
    if (handle == NULL) {
        return nil;
    }

    void *button = dlsym(handle, "IndigoHIDMessageForButton");
    void *keyboard = dlsym(handle, "IndigoHIDMessageForKeyboardArbitrary");
    void *mouse = dlsym(handle, "IndigoHIDMessageForMouseNSEvent");
    if (button == NULL || keyboard == NULL || mouse == NULL) {
        if (error != NULL) {
            *error = MCSimulatorError(
                21,
                @"SimulatorKit does not export the IndigoHIDMessageFor* builders this transport needs",
                nil);
        }
        return nil;
    }

    return [[self alloc] initWithButtonBuilder:(MCIndigoMessageForButtonFn)button
                               keyboardBuilder:(MCIndigoMessageForKeyboardArbitraryFn)keyboard
                                  mouseBuilder:(MCIndigoMessageForMouseNSEventFn)mouse];
}

- (instancetype)initWithButtonBuilder:(MCIndigoMessageForButtonFn)buttonBuilder
                      keyboardBuilder:(MCIndigoMessageForKeyboardArbitraryFn)keyboardBuilder
                         mouseBuilder:(MCIndigoMessageForMouseNSEventFn)mouseBuilder
{
    self = [super init];
    if (self == nil) {
        return nil;
    }
    _buttonBuilder = buttonBuilder;
    _keyboardBuilder = keyboardBuilder;
    _mouseBuilder = mouseBuilder;
    return self;
}

/// Wraps a `malloc`'d message as `NSData` that frees the allocation when it is released.
static NSData *MCDataFromMallocedMessage(MCIndigoMessage *message)
{
    void *raw = message;
    return [NSData dataWithBytesNoCopy:raw length:malloc_size(raw) freeWhenDone:YES];
}

- (NSData *)touchMessageForRatio:(CGPoint)ratio direction:(MCHidDirection)direction
{
    // SimulatorKit has no single-touch builder: `IndigoHIDMessageForMouseNSEvent` always emits a
    // multi-touch (eventType 0x03) message. Source a valid contact from it, then hand-envelope it as
    // a single-touch (eventType 0x02) two-payload message.
    CGPoint point = ratio;
    MCIndigoMessage *source = self.mouseBuilder(&point, NULL, 0x32, (int32_t)direction, NO);
    source->payload.event.touch.xRatio = point.x;
    source->payload.event.touch.yRatio = point.y;
    unsigned char *sourceBytes = (unsigned char *)source;

    const size_t stride = sizeof(MCIndigoPayload);
    const size_t messageSize = sizeof(MCIndigoMessage) + stride;
    unsigned char *destination = calloc(1, messageSize);
    if (destination == NULL) {
        free(source);
        return [NSData data];
    }

    MCIndigoMessage *message = (MCIndigoMessage *)destination;
    message->innerSize = (unsigned int)stride;
    message->eventType = MCIndigoEventTypeTouch;
    message->payload.eventKind = MCIndigoTouchEventKind;
    message->payload.timestamp = mach_absolute_time();

    memcpy(destination + MCIndigoEventOffset, sourceBytes + MCIndigoEventOffset, sizeof(MCIndigoTouch));
    free(source);

    // Duplicate the first payload into the second slot and mark the copied contact.
    memcpy(destination + MCIndigoFirstPayloadOffset + stride, destination + MCIndigoFirstPayloadOffset, stride);
    MCIndigoPayload *secondPayload =
        (MCIndigoPayload *)(destination + MCIndigoFirstPayloadOffset + stride);
    secondPayload->event.touch.field1 = 1;
    secondPayload->event.touch.field2 = 2;

    return [NSData dataWithBytesNoCopy:destination length:messageSize freeWhenDone:YES];
}

- (nullable NSData *)buttonMessageForButton:(MCHidButton)button direction:(MCHidDirection)direction
{
    int32_t source;
    switch (button) {
        case MCHidButtonHome:
            source = MCIndigoButtonEventSourceHomeButton;
            break;
        case MCHidButtonLock:
            source = MCIndigoButtonEventSourceLock;
            break;
        case MCHidButtonSide:
            source = MCIndigoButtonEventSourceSideButton;
            break;
        case MCHidButtonSiri:
            source = MCIndigoButtonEventSourceSiri;
            break;
        case MCHidButtonApplePay:
            source = MCIndigoButtonEventSourceApplePay;
            break;
        default:
            return nil;
    }
    MCIndigoMessage *message =
        self.buttonBuilder(source, (int32_t)direction, MCIndigoButtonEventTargetHardware);
    return MCDataFromMallocedMessage(message);
}

- (NSData *)keyboardMessageForUsage:(uint32_t)usageCode direction:(MCHidDirection)direction
{
    MCIndigoMessage *message = self.keyboardBuilder((int32_t)usageCode, (int32_t)direction);
    return MCDataFromMallocedMessage(message);
}

@end

@interface MCIndigoHidClient ()
@property (nonatomic, strong, nullable) id client;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, strong) NSLock *lock;
@end

@implementation MCIndigoHidClient

+ (nullable instancetype)clientForDevice:(MCSimulatorDevice *)device
                      developerDirectory:(NSString *)developerDirectory
                                   error:(NSError **)error
{
    // SimulatorKit has to be loaded before the class lookup: the helper links against neither the
    // framework nor the class, so otherwise there is nothing for the lookup to find.
    if (MCLoadSimulatorKit(developerDirectory, error) == NULL) {
        return nil;
    }

    Class clientClass = objc_lookUpClass(MCIndigoClientClassName.UTF8String);
    if (clientClass == Nil) {
        if (error != NULL) {
            *error = MCSimulatorError(
                22,
                [NSString stringWithFormat:@"%@ is not available in the loaded SimulatorKit",
                                           MCIndigoClientClassName],
                nil);
        }
        return nil;
    }

    id client = nil;
    @try {
        NSError *clientError = nil;
        client = [(id<MCSimDeviceLegacyHIDClient>)[clientClass alloc] initWithDevice:device.device
                                                                              error:&clientError];
        if (client == nil) {
            if (error != NULL) {
                *error = MCSimulatorError(23, @"The legacy Indigo HID client declined to attach", clientError);
            }
            return nil;
        }
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCSimulatorExceptionError(exception, @"Creating the legacy Indigo HID client");
        }
        return nil;
    }

    MCIndigoHidClient *wrapper = [[MCIndigoHidClient alloc] initInternal];
    wrapper.client = client;
    return wrapper;
}

- (instancetype)initInternal
{
    self = [super init];
    if (self == nil) {
        return nil;
    }
    _queue = dispatch_queue_create("com.github.copilot.mobile-canvas.indigo-hid", DISPATCH_QUEUE_SERIAL);
    _lock = [[NSLock alloc] init];
    return self;
}

- (BOOL)sendMessage:(NSData *)message timeout:(NSTimeInterval)timeout error:(NSError **)error
{
    [self.lock lock];
    id client = self.client;
    [self.lock unlock];
    if (client == nil) {
        if (error != NULL) {
            *error = MCSimulatorError(24, @"The legacy Indigo HID client has been disconnected", nil);
        }
        return NO;
    }

    // The client takes ownership of the buffer via `freeWhenDone:`, so hand it a fresh allocation
    // rather than the NSData backing store.
    size_t size = message.length;
    void *raw = malloc(size);
    if (raw == NULL) {
        if (error != NULL) {
            *error = MCSimulatorError(25, @"Could not allocate an Indigo message buffer", nil);
        }
        return NO;
    }
    memcpy(raw, message.bytes, size);

    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block NSError *sendError = nil;
    @try {
        [(id<MCSimDeviceLegacyHIDClient>)client sendWithMessage:raw
                                                   freeWhenDone:YES
                                                completionQueue:self.queue
                                                     completion:^(NSError *_Nullable completionError) {
                                                         sendError = completionError;
                                                         dispatch_semaphore_signal(completed);
                                                     }];
    } @catch (NSException *exception) {
        // `raw` is deliberately not freed: a raise leaves no way to tell whether ownership
        // transferred, and one leaked message beats a double free.
        if (error != NULL) {
            *error = MCSimulatorExceptionError(exception, @"Sending an Indigo HID message");
        }
        return NO;
    }

    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(completed, deadline) != 0) {
        if (error != NULL) {
            *error = MCSimulatorError(26, @"The simulator did not acknowledge an Indigo HID message", nil);
        }
        return NO;
    }
    if (sendError != nil) {
        if (error != NULL) {
            *error = MCSimulatorError(27, @"The simulator rejected an Indigo HID message", sendError);
        }
        return NO;
    }
    return YES;
}

- (void)disconnect
{
    [self.lock lock];
    // Releasing the client is the disconnect: `SimDeviceLegacyHIDClient` tears its port down in
    // `dealloc`.
    self.client = nil;
    [self.lock unlock];
}

@end
