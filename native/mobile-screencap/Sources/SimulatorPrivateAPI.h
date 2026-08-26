#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
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
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
