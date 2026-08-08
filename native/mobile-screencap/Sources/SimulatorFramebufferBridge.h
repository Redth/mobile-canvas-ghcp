#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^MCSimulatorSurfaceChangedHandler)(id _Nullable surface);
typedef void (^MCSimulatorFrameRenderedHandler)(void);

/// Isolates calls into CoreSimulator's private display proxies so Objective-C
/// exceptions cannot unwind through Swift or the .NET host.
@interface MCSimulatorFramebuffer : NSObject

@property (class, nonatomic, readonly, getter=isSupported) BOOL supported;
@property (atomic, strong, readonly, nullable) id currentSurface;

- (nullable instancetype)initWithUDID:(NSString *)udid
                   developerDirectory:(NSString *)developerDirectory
                                error:(NSError **)error NS_DESIGNATED_INITIALIZER;

- (BOOL)startWithSurfaceChangedHandler:(MCSimulatorSurfaceChangedHandler)surfaceChangedHandler
                  frameRenderedHandler:(MCSimulatorFrameRenderedHandler)frameRenderedHandler
                                 error:(NSError **)error;

- (void)stop;

- (instancetype)init NS_UNAVAILABLE;

@end

/// Sends device control events through CoreSimulator without depending on Simulator.app UI.
@interface MCSimulatorRotation : NSObject

+ (BOOL)rotateDeviceWithUDID:(NSString *)udid
          developerDirectory:(NSString *)developerDirectory
                 orientation:(NSUInteger)orientation
                       error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
