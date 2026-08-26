#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <mach/mach.h>

NS_ASSUME_NONNULL_BEGIN

/// Shared CoreSimulator device lookup.
///
/// Framebuffer capture, rotation, and HID all need the same `SimDevice`, so the lookup lives here
/// and every private-API message is contained in an Objective-C exception guard: CoreSimulator
/// asserts on state this process does not own, and an `NSException` unwinding through a Swift frame
/// reaches `libc++abi` and aborts the helper.
@interface MCSimulatorDevice : NSObject

/// The private `SimDevice` instance. Untyped on purpose; the concrete class is runtime-only.
@property (nonatomic, readonly) id device;

/// The device UDID as reported by CoreSimulator.
@property (nonatomic, readonly) NSString *udid;

/// The main screen size in pixels, or `CGSizeZero` when CoreSimulator did not report one.
@property (nonatomic, readonly) CGSize mainScreenSize;

/// The main screen scale, or `0` when CoreSimulator did not report one.
@property (nonatomic, readonly) float mainScreenScale;

/// Whether the CoreSimulator private framework could be loaded in this process.
@property (class, nonatomic, readonly, getter=isCoreSimulatorAvailable) BOOL coreSimulatorAvailable;

/// `CFBundleVersion` of the CoreSimulator framework actually loaded in this process, read from the
/// bundle that vends `SimDevice`. CoreSimulator is a system framework that the Xcode installer
/// overwrites, so it can be newer than the selected Xcode; version-gated behaviour must use this
/// rather than an Xcode version.
@property (class, nonatomic, readonly, nullable) NSString *loadedCoreSimulatorVersion;

+ (nullable instancetype)deviceWithUDID:(NSString *)udid
                     developerDirectory:(NSString *)developerDirectory
                                  error:(NSError **)error
    NS_SWIFT_NAME(lookUp(udid:developerDirectory:));

/// Looks a guest service up on the device, returning `MACH_PORT_NULL` on failure.
- (mach_port_t)lookupService:(NSString *)service error:(NSError **)error
    NS_SWIFT_NAME(lookUpService(_:));

- (instancetype)init NS_UNAVAILABLE;

@end

/// Builds an `NSError` in the helper's CoreSimulator domain.
extern NSError *MCSimulatorError(NSInteger code, NSString *description, id _Nullable underlying);

/// Wraps a caught `NSException` as an `NSError` describing the operation that raised.
extern NSError *MCSimulatorExceptionError(NSException *exception, NSString *operation);

/// Compares two dotted numeric version strings (`1155.10` sorts above `1155.4`).
/// A `nil` version sorts below every concrete version.
extern NSComparisonResult MCCompareNumericVersions(NSString *_Nullable lhs, NSString *_Nullable rhs);

NS_ASSUME_NONNULL_END
