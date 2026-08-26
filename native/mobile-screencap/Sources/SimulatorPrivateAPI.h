#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <mach/mach.h>

NS_ASSUME_NONNULL_BEGIN

/// Declarations for the CoreSimulator classes the helper messages at runtime.
///
/// These are type declarations only: nothing here references a class literal, so no link-time
/// `_OBJC_CLASS_$_` symbol is emitted for a framework the helper does not link against.

@protocol MCSimServiceContextClass <NSObject>
+ (nullable id)sharedServiceContextForDeveloperDir:(id)developerDirectory
                                             error:(id _Nullable *_Nullable)error;
@end

@protocol MCSimServiceContext <NSObject>
- (nullable id)defaultDeviceSetWithError:(id _Nullable *_Nullable)error;
@end

@interface SimDeviceSet : NSObject
@property (nonatomic, readonly) NSArray *availableDevices;
@end

@interface SimDeviceType : NSObject
@property (nonatomic, readonly) CGSize mainScreenSize;
@property (nonatomic, readonly) float mainScreenScale;
@end

@interface SimDevice : NSObject
@property (nonatomic, readonly) NSUUID *UDID;
@property (nonatomic, readonly) id io;
@property (nonatomic, readonly) SimDeviceType *deviceType;
/// `SimDeviceState` as a raw integer (`3` is `Booted`); read defensively, see `stateString`.
@property (nonatomic, readonly) unsigned long long state;
/// CoreSimulator's own human-readable state name (`"Booted"`, `"Shutdown"`, ...), preferred over
/// `state` because it does not depend on the numeric enum staying stable across CoreSimulator
/// versions.
@property (nonatomic, readonly, copy) NSString *stateString;
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
/// Bridges a translated accessibility request to the guest and back. Only present on CoreSimulator
/// builds that ship the host-side accessibility-translation path (Xcode 12+); callers must guard
/// with `respondsToSelector:` before sending this. `request`/the value handed to `completionHandler`
/// are opaque `AXPTranslatorRequest`/`AXPTranslatorResponse` instances from the
/// `AccessibilityPlatformTranslation` framework -- declared as `id` here so this header never needs
/// to name (and thus never needs to link) that framework.
- (void)sendAccessibilityRequestAsync:(id)request
                       completionQueue:(dispatch_queue_t)completionQueue
                     completionHandler:(void (^)(id _Nullable response))completionHandler;
@end

NS_ASSUME_NONNULL_END
