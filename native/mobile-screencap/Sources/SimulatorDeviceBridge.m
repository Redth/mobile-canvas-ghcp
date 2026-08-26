#import "SimulatorDeviceBridge.h"

#import "SimulatorPrivateAPI.h"

#import <dlfcn.h>

static NSString *const MCSimulatorErrorDomain = @"com.github.copilot.mobile-canvas.coresimulator";

NSError *MCSimulatorError(NSInteger code, NSString *description, id _Nullable underlying)
{
    NSMutableDictionary *details = [@{NSLocalizedDescriptionKey: description} mutableCopy];
    if ([underlying isKindOfClass:NSError.class]) {
        details[NSUnderlyingErrorKey] = underlying;
    } else if (underlying != nil) {
        details[@"UnderlyingDescription"] = [underlying description];
    }
    return [NSError errorWithDomain:MCSimulatorErrorDomain code:code userInfo:details];
}

NSError *MCSimulatorExceptionError(NSException *exception, NSString *operation)
{
    NSString *description = [NSString stringWithFormat:@"%@ raised %@: %@",
                             operation,
                             exception.name,
                             exception.reason ?: @"no reason"];
    return MCSimulatorError(10, description, nil);
}

NSComparisonResult MCCompareNumericVersions(NSString *_Nullable lhs, NSString *_Nullable rhs)
{
    if (lhs == nil && rhs == nil) {
        return NSOrderedSame;
    }
    if (lhs == nil) {
        return NSOrderedAscending;
    }
    if (rhs == nil) {
        return NSOrderedDescending;
    }
    // `compare:options:NSNumericSearch` is what makes 1155.10 sort above 1155.4 rather than
    // lexicographically below it.
    return [lhs compare:rhs options:NSNumericSearch];
}

static BOOL MCLoadCoreSimulatorFramework(void)
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

@interface MCSimulatorDevice ()
@property (nonatomic, strong, readwrite) id device;
@property (nonatomic, copy, readwrite) NSString *udid;
@property (nonatomic, assign, readwrite) CGSize mainScreenSize;
@property (nonatomic, assign, readwrite) float mainScreenScale;
@end

@implementation MCSimulatorDevice

+ (BOOL)isCoreSimulatorAvailable
{
    return MCLoadCoreSimulatorFramework();
}

+ (nullable NSString *)loadedCoreSimulatorVersion
{
    Class simDeviceClass = NSClassFromString(@"SimDevice");
    if (simDeviceClass == nil) {
        return nil;
    }
    @try {
        NSBundle *bundle = [NSBundle bundleForClass:simDeviceClass];
        id version = bundle.infoDictionary[@"CFBundleVersion"];
        return [version isKindOfClass:NSString.class] ? version : nil;
    } @catch (__unused NSException *exception) {
        return nil;
    }
}

+ (nullable instancetype)deviceWithUDID:(NSString *)udid
                     developerDirectory:(NSString *)developerDirectory
                                  error:(NSError **)error
{
    if (!MCLoadCoreSimulatorFramework()) {
        if (error != NULL) {
            const char *loadError = dlerror();
            NSString *detail = loadError != NULL
                ? [NSString stringWithUTF8String:loadError]
                : @"CoreSimulator.framework could not be loaded";
            *error = MCSimulatorError(1, detail, nil);
        }
        return nil;
    }

    @try {
        id contextError = nil;
        Class<MCSimServiceContextClass> contextClass =
            (Class<MCSimServiceContextClass>)NSClassFromString(@"SimServiceContext");
        id<MCSimServiceContext> context =
            [contextClass sharedServiceContextForDeveloperDir:developerDirectory error:&contextError];
        if (context == nil) {
            if (error != NULL) {
                *error = MCSimulatorError(1, @"Could not connect to CoreSimulator", contextError);
            }
            return nil;
        }

        id deviceSetError = nil;
        SimDeviceSet *deviceSet = [context defaultDeviceSetWithError:&deviceSetError];
        if (deviceSet == nil) {
            if (error != NULL) {
                *error = MCSimulatorError(2, @"Could not open the default simulator device set", deviceSetError);
            }
            return nil;
        }

        for (SimDevice *candidate in deviceSet.availableDevices) {
            if ([candidate.UDID.UUIDString caseInsensitiveCompare:udid] != NSOrderedSame) {
                continue;
            }
            MCSimulatorDevice *matched = [[MCSimulatorDevice alloc] initInternal];
            matched.device = candidate;
            matched.udid = candidate.UDID.UUIDString;
            matched.mainScreenSize = CGSizeZero;
            matched.mainScreenScale = 0;
            @try {
                SimDeviceType *deviceType = candidate.deviceType;
                if (deviceType != nil) {
                    matched.mainScreenSize = deviceType.mainScreenSize;
                    matched.mainScreenScale = deviceType.mainScreenScale;
                }
            } @catch (__unused NSException *exception) {
                // Leave the screen metrics unset; callers that need them report their own error.
            }
            return matched;
        }

        if (error != NULL) {
            *error = MCSimulatorError(3,
                                      [NSString stringWithFormat:@"Simulator %@ was not found in the default device set", udid],
                                      nil);
        }
        return nil;
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCSimulatorExceptionError(exception, @"Looking the simulator up in CoreSimulator");
        }
        return nil;
    }
}

- (instancetype)initInternal
{
    return [super init];
}

- (mach_port_t)lookupService:(NSString *)service error:(NSError **)error
{
    @try {
        NSError *lookupError = nil;
        mach_port_t port = [(SimDevice *)self.device lookup:service error:&lookupError];
        if (port == MACH_PORT_NULL && error != NULL) {
            *error = MCSimulatorError(
                4,
                [NSString stringWithFormat:@"The simulator did not publish %@", service],
                lookupError);
        }
        return port;
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCSimulatorExceptionError(
                exception, [NSString stringWithFormat:@"Looking %@ up on the simulator", service]);
        }
        return MACH_PORT_NULL;
    }
}

@end
