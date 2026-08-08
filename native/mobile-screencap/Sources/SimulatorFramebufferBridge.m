#import "SimulatorFramebufferBridge.h"

#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <limits.h>
#import <mach/mach.h>

static NSString *const MCFramebufferErrorDomain = @"com.github.copilot.mobile-canvas.framebuffer";

@protocol MCSimServiceContextClass <NSObject>
+ (id)sharedServiceContextForDeveloperDir:(id)developerDirectory error:(id *)error;
@end

@protocol MCSimServiceContext <NSObject>
- (id)defaultDeviceSetWithError:(id *)error;
@end

@interface SimDeviceSet : NSObject
@property (nonatomic, readonly) NSArray *availableDevices;
@end

@interface SimDevice : NSObject
@property (nonatomic, readonly) NSUUID *UDID;
@property (nonatomic, readonly) id io;
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
@end

@protocol MCSimDeviceIOClient <NSObject>
- (NSArray *)ioPorts;
@end

@protocol MCSimDeviceIOPortInterface <NSObject>
@property (nonatomic, readonly) id descriptor;
@end

@protocol MCSimDisplayDescriptorState <NSObject>
@property (nonatomic, readonly) unsigned short displayClass;
@end

@protocol MCSimDisplayDescriptor <NSObject>
- (id)state;
@end

@protocol MCSimDisplayIOSurfaceRenderable <NSObject>
@property (nullable, nonatomic, readonly) id ioSurface;
@property (nullable, nonatomic, readonly) id framebufferSurface;
- (void)unregisterIOSurfaceChangeCallbackWithUUID:(NSUUID *)uuid;
- (void)registerCallbackWithUUID:(NSUUID *)uuid
         ioSurfaceChangeCallback:(void (^)(id _Nullable surface))callback;
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid;
- (void)registerCallbackWithUUID:(NSUUID *)uuid
        ioSurfacesChangeCallback:(void (^)(id _Nullable surface))callback;
@end

@protocol MCSimDisplayRenderable <NSObject>
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid;
- (void)registerCallbackWithUUID:(NSUUID *)uuid
        damageRectanglesCallback:(void (^)(NSArray<NSValue *> *rectangles))callback;
@end

@protocol MCSimScreen <NSObject>
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid
                          callbackQueue:(dispatch_queue_t)callbackQueue
                          frameCallback:(void (^)(void))frameCallback
                surfacesChangedCallback:(void (^)(id _Nullable framebuffer, id _Nullable maskedFramebuffer))surfacesChangedCallback
              propertiesChangedCallback:(void (^)(id properties))propertiesChangedCallback;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)uuid;
@end

typedef NS_ENUM(NSUInteger, MCFramebufferCallbackStyle) {
    MCFramebufferCallbackStyleNone,
    MCFramebufferCallbackStyleScreen,
    MCFramebufferCallbackStyleLegacy,
};

static NSError *MCError(NSInteger code, NSString *description, id _Nullable underlying)
{
    NSMutableDictionary *details = [@{NSLocalizedDescriptionKey: description} mutableCopy];
    if ([underlying isKindOfClass:NSError.class]) {
        details[NSUnderlyingErrorKey] = underlying;
    } else if (underlying != nil) {
        details[@"UnderlyingDescription"] = [underlying description];
    }
    return [NSError errorWithDomain:MCFramebufferErrorDomain code:code userInfo:details];
}

static NSError *MCExceptionError(NSException *exception, NSString *operation)
{
    NSString *description = [NSString stringWithFormat:@"%@ raised %@: %@",
                             operation,
                             exception.name,
                             exception.reason ?: @"no reason"];
    return MCError(10, description, nil);
}

static BOOL MCLoadCoreSimulator(void)
{
    static void *frameworkHandle = NULL;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        frameworkHandle = dlopen(
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            RTLD_LAZY | RTLD_LOCAL);
    });
    return frameworkHandle != NULL && NSClassFromString(@"SimServiceContext") != nil;
}

static BOOL MCIsIOSurface(id _Nullable candidate)
{
    if (candidate == nil) {
        return NO;
    }
    return CFGetTypeID((__bridge CFTypeRef)candidate) == IOSurfaceGetTypeID();
}

static SimDevice *_Nullable MCFindDevice(
    NSString *udid,
    NSString *developerDirectory,
    NSError **error)
{
    if (!MCLoadCoreSimulator()) {
        if (error != NULL) {
            const char *loadError = dlerror();
            NSString *detail = loadError != NULL
                ? [NSString stringWithUTF8String:loadError]
                : @"CoreSimulator.framework could not be loaded";
            *error = MCError(1, detail, nil);
        }
        return nil;
    }

    id contextError = nil;
    Class<MCSimServiceContextClass> contextClass =
        (Class<MCSimServiceContextClass>)NSClassFromString(@"SimServiceContext");
    id<MCSimServiceContext> context =
        [contextClass sharedServiceContextForDeveloperDir:developerDirectory error:&contextError];
    if (context == nil) {
        if (error != NULL) {
            *error = MCError(1, @"Could not connect to CoreSimulator", contextError);
        }
        return nil;
    }

    id deviceSetError = nil;
    SimDeviceSet *deviceSet = [context defaultDeviceSetWithError:&deviceSetError];
    if (deviceSet == nil) {
        if (error != NULL) {
            *error = MCError(2, @"Could not open the default simulator device set", deviceSetError);
        }
        return nil;
    }

    for (SimDevice *device in deviceSet.availableDevices) {
        if ([device.UDID.UUIDString caseInsensitiveCompare:udid] == NSOrderedSame) {
            return device;
        }
    }

    if (error != NULL) {
        *error = MCError(3,
                         [NSString stringWithFormat:@"Simulator %@ was not found in the default device set", udid],
                         nil);
    }
    return nil;
}

@interface MCSimulatorFramebuffer ()
@property (atomic, strong, readwrite, nullable) id currentSurface;
@property (nonatomic, strong) id descriptor;
@property (nonatomic, strong) NSUUID *callbackToken;
@property (nonatomic, strong) dispatch_queue_t callbackQueue;
@property (atomic, copy, nullable) MCSimulatorSurfaceChangedHandler surfaceChangedHandler;
@property (atomic, copy, nullable) MCSimulatorFrameRenderedHandler frameRenderedHandler;
@property (nonatomic, assign) MCFramebufferCallbackStyle callbackStyle;
@end

@implementation MCSimulatorFramebuffer

+ (BOOL)isSupported
{
    return MCLoadCoreSimulator();
}

- (nullable instancetype)initWithUDID:(NSString *)udid
                   developerDirectory:(NSString *)developerDirectory
                                error:(NSError **)error
{
    self = [super init];
    if (self == nil) {
        return nil;
    }

    _callbackToken = NSUUID.UUID;
    _callbackQueue = dispatch_queue_create(
        "com.github.copilot.mobile-canvas.framebuffer-callbacks",
        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));

    @try {
        SimDevice *matchedDevice = MCFindDevice(udid, developerDirectory, error);
        if (matchedDevice == nil) {
            return nil;
        }

        id<MCSimDeviceIOClient> ioClient = matchedDevice.io;
        NSArray *ports = [ioClient ioPorts];
        if (ports.count == 0) {
            if (error != NULL) {
                *error = MCError(4,
                                 [NSString stringWithFormat:@"Simulator %@ has no display IO ports", udid],
                                 nil);
            }
            return nil;
        }

        id fallbackDescriptor = nil;
        for (id<MCSimDeviceIOPortInterface> port in ports) {
            id descriptor = port.descriptor;
            BOOL hasScreenCallbacks =
                [descriptor respondsToSelector:@selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)];
            BOOL hasLegacyCallbacks =
                [descriptor respondsToSelector:@selector(registerCallbackWithUUID:damageRectanglesCallback:)];
            if (!hasScreenCallbacks && !hasLegacyCallbacks) {
                continue;
            }

            unsigned short displayClass = USHRT_MAX;
            @try {
                if ([descriptor respondsToSelector:@selector(state)]) {
                    id state = [(id<MCSimDisplayDescriptor>)descriptor state];
                    if ([state respondsToSelector:@selector(displayClass)]) {
                        displayClass = [(id<MCSimDisplayDescriptorState>)state displayClass];
                    }
                }
            } @catch (__unused NSException *exception) {
                displayClass = USHRT_MAX;
            }

            if (displayClass == 0) {
                _descriptor = descriptor;
                break;
            }
            if (fallbackDescriptor == nil) {
                fallbackDescriptor = descriptor;
            }
        }

        if (_descriptor == nil) {
            _descriptor = fallbackDescriptor;
        }
        if (_descriptor == nil) {
            if (error != NULL) {
                *error = MCError(5,
                                 [NSString stringWithFormat:@"Simulator %@ has no renderable display", udid],
                                 nil);
            }
            return nil;
        }

        self.currentSurface = [self immediatelyAvailableSurface];
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCExceptionError(exception, @"Attaching to the simulator framebuffer");
        }
        return nil;
    }

    return self;
}

- (id _Nullable)immediatelyAvailableSurface
{
    id<MCSimDisplayIOSurfaceRenderable> renderable = self.descriptor;
    @try {
        id surface = renderable.framebufferSurface;
        if (MCIsIOSurface(surface)) {
            return surface;
        }
    } @catch (__unused NSException *exception) {
    }

    @try {
        id surface = renderable.ioSurface;
        if (MCIsIOSurface(surface)) {
            return surface;
        }
    } @catch (__unused NSException *exception) {
    }
    return nil;
}

- (BOOL)startWithSurfaceChangedHandler:(MCSimulatorSurfaceChangedHandler)surfaceChangedHandler
                  frameRenderedHandler:(MCSimulatorFrameRenderedHandler)frameRenderedHandler
                                 error:(NSError **)error
{
    self.surfaceChangedHandler = surfaceChangedHandler;
    self.frameRenderedHandler = frameRenderedHandler;

    if ([self registerScreenCallbacks]) {
        self.callbackStyle = MCFramebufferCallbackStyleScreen;
        return YES;
    }

    NSError *legacyError = nil;
    if ([self registerLegacyCallbacks:&legacyError]) {
        self.callbackStyle = MCFramebufferCallbackStyleLegacy;
        return YES;
    }

    self.surfaceChangedHandler = nil;
    self.frameRenderedHandler = nil;
    if (error != NULL) {
        *error = legacyError ?: MCError(6, @"Could not register simulator framebuffer callbacks", nil);
    }
    return NO;
}

- (BOOL)registerScreenCallbacks
{
    id<MCSimScreen> screen = self.descriptor;
    if (![screen respondsToSelector:@selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)]) {
        return NO;
    }

    __weak MCSimulatorFramebuffer *weakSelf = self;
    @try {
        [screen registerScreenCallbacksWithUUID:self.callbackToken
                                  callbackQueue:self.callbackQueue
                                  frameCallback:^{
                                      MCSimulatorFramebuffer *strongSelf = weakSelf;
                                      MCSimulatorFrameRenderedHandler handler =
                                          strongSelf.frameRenderedHandler;
                                      if (handler != nil) {
                                          handler();
                                      }
                                  }
                        surfacesChangedCallback:^(id framebuffer, __unused id maskedFramebuffer) {
                            [weakSelf handleSurfaceChanged:framebuffer];
                        }
                      propertiesChangedCallback:^(__unused id properties) {
                      }];
        return YES;
    } @catch (__unused NSException *exception) {
        @try {
            [screen unregisterScreenCallbacksWithUUID:self.callbackToken];
        } @catch (__unused NSException *unregisterException) {
        }
        return NO;
    }
}

- (BOOL)registerLegacyCallbacks:(NSError **)error
{
    id<MCSimDisplayIOSurfaceRenderable> surface = self.descriptor;
    id<MCSimDisplayRenderable> renderable = self.descriptor;
    __weak MCSimulatorFramebuffer *weakSelf = self;
    __block BOOL registeredSurfaceCallback = NO;
    __block NSException *surfaceException = nil;

    @try {
        [surface registerCallbackWithUUID:self.callbackToken
                 ioSurfacesChangeCallback:^(id newSurface) {
                     [weakSelf handleSurfaceChanged:newSurface];
                 }];
        registeredSurfaceCallback = YES;
    } @catch (NSException *exception) {
        surfaceException = exception;
    }

    @try {
        [surface registerCallbackWithUUID:self.callbackToken
                  ioSurfaceChangeCallback:^(id newSurface) {
                      [weakSelf handleSurfaceChanged:newSurface];
                  }];
        registeredSurfaceCallback = YES;
    } @catch (NSException *exception) {
        if (surfaceException == nil) {
            surfaceException = exception;
        }
    }

    if (!registeredSurfaceCallback) {
        if (error != NULL) {
            *error = surfaceException != nil
                ? MCExceptionError(surfaceException, @"Registering framebuffer surface callbacks")
                : MCError(7, @"No framebuffer surface callback is available", nil);
        }
        return NO;
    }

    @try {
        [renderable registerCallbackWithUUID:self.callbackToken
                    damageRectanglesCallback:^(__unused NSArray<NSValue *> *rectangles) {
                        MCSimulatorFramebuffer *strongSelf = weakSelf;
                        MCSimulatorFrameRenderedHandler handler =
                            strongSelf.frameRenderedHandler;
                        if (handler != nil) {
                            handler();
                        }
                    }];
        return YES;
    } @catch (NSException *exception) {
        [self unregisterLegacyCallbacks];
        if (error != NULL) {
            *error = MCExceptionError(exception, @"Registering framebuffer frame callbacks");
        }
        return NO;
    }
}

- (void)handleSurfaceChanged:(id _Nullable)surface
{
    id validatedSurface = MCIsIOSurface(surface) ? surface : nil;
    self.currentSurface = validatedSurface;
    MCSimulatorSurfaceChangedHandler handler = self.surfaceChangedHandler;
    if (handler != nil) {
        handler(validatedSurface);
    }
}

- (void)unregisterLegacyCallbacks
{
    id<MCSimDisplayIOSurfaceRenderable> surface = self.descriptor;
    id<MCSimDisplayRenderable> renderable = self.descriptor;
    @try {
        [surface unregisterIOSurfacesChangeCallbackWithUUID:self.callbackToken];
    } @catch (__unused NSException *exception) {
    }
    @try {
        [surface unregisterIOSurfaceChangeCallbackWithUUID:self.callbackToken];
    } @catch (__unused NSException *exception) {
    }
    @try {
        [renderable unregisterDamageRectanglesCallbackWithUUID:self.callbackToken];
    } @catch (__unused NSException *exception) {
    }
}

- (void)stop
{
    MCFramebufferCallbackStyle callbackStyle = self.callbackStyle;
    self.callbackStyle = MCFramebufferCallbackStyleNone;
    if (callbackStyle == MCFramebufferCallbackStyleScreen) {
        @try {
            [(id<MCSimScreen>)self.descriptor unregisterScreenCallbacksWithUUID:self.callbackToken];
        } @catch (__unused NSException *exception) {
        }
    } else if (callbackStyle == MCFramebufferCallbackStyleLegacy) {
        [self unregisterLegacyCallbacks];
    }
    self.surfaceChangedHandler = nil;
    self.frameRenderedHandler = nil;
    self.currentSurface = nil;
}

- (void)dealloc
{
    [self stop];
}

@end

@implementation MCSimulatorRotation

+ (BOOL)rotateDeviceWithUDID:(NSString *)udid
          developerDirectory:(NSString *)developerDirectory
                 orientation:(NSUInteger)orientation
                       error:(NSError **)error
{
    @try {
        SimDevice *device = MCFindDevice(udid, developerDirectory, error);
        if (device == nil) {
            return NO;
        }

        NSError *lookupError = nil;
        mach_port_t port = [device lookup:@"PurpleWorkspacePort" error:&lookupError];
        if (port == MACH_PORT_NULL) {
            if (error != NULL) {
                *error = MCError(7, @"The simulator did not publish PurpleWorkspacePort", lookupError);
            }
            return NO;
        }

        uint8_t message[112] = {0};
        mach_msg_header_t *header = (mach_msg_header_t *)message;
        header->msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
        header->msgh_size = 108;
        header->msgh_remote_port = port;
        header->msgh_id = 0x7B;

        uint32_t eventType = 50 | 0x20000;
        uint32_t payloadSize = 4;
        uint32_t deviceOrientation = (uint32_t)orientation;
        memcpy(message + 0x18, &eventType, sizeof(eventType));
        memcpy(message + 0x48, &payloadSize, sizeof(payloadSize));
        memcpy(message + 0x4C, &deviceOrientation, sizeof(deviceOrientation));

        kern_return_t result = mach_msg(
            header,
            MACH_SEND_MSG | MACH_SEND_TIMEOUT,
            header->msgh_size,
            0,
            MACH_PORT_NULL,
            2000,
            MACH_PORT_NULL);
        if (result != KERN_SUCCESS) {
            if (error != NULL) {
                NSString *detail = [NSString stringWithUTF8String:mach_error_string(result)];
                *error = MCError(8,
                                 [NSString stringWithFormat:@"Could not send the orientation event: %@", detail],
                                 nil);
            }
            return NO;
        }
        return YES;
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCExceptionError(exception, @"Rotating the simulator");
        }
        return NO;
    }
}

@end
