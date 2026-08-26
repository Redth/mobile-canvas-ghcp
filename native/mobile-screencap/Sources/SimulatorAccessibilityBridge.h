#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class MCSimulatorDevice;

/// Error domain for `MCAccessibilityReader`, distinct from `MCSimulatorErrorDomain` so a caller can
/// tell an accessibility-specific failure apart from a general CoreSimulator one.
extern NSString *const MCAccessibilityErrorDomain;

/// Stable codes a Swift caller can switch on without parsing `localizedDescription`.
typedef NS_ENUM(NSInteger, MCAccessibilityErrorCode) {
    /// `AccessibilityPlatformTranslation.framework` could not be loaded on this host.
    MCAccessibilityErrorFrameworkUnavailable = 1,
    /// The framework loaded, but a required class/selector is missing (an older OS/Xcode).
    MCAccessibilityErrorSelectorUnavailable = 2,
    /// The simulator device is not in the `Booted` state.
    MCAccessibilityErrorDeviceNotBooted = 3,
    /// The bounded wait for a translation response elapsed.
    MCAccessibilityErrorTimeout = 4,
    /// The translator reported no frontmost application (nothing to read).
    MCAccessibilityErrorEmptyTree = 5,
    /// An unexpected failure (including a caught `NSException`) while translating or walking the
    /// tree.
    MCAccessibilityErrorInternal = 6,
};

/// Reads the frontmost iOS Simulator application's accessibility hierarchy from the host side,
/// without `idb_companion`.
///
/// Adapted from Meta's idb (`FBAXTranslationDispatcher`, `FBSimulatorAccessibilityCommands`,
/// `FBAXPlatformElement`, `FBAccessibilityDocument`; MIT license) -- see the repository LICENSE.
/// Unlike idb this reader:
///  - is `dlopen`ed/declared at runtime rather than linked against a vendored framework binding,
///  - only walks the frontmost application's tree (no point/hit-test queries, remote-content
///    synthesis, coverage grids, or SpringBoard-crash remediation), and
///  - serializes directly to the dictionary shape `AccessibilityParser` (managed side) already
///    understands, rather than idb's full attributed-string/traits/actions payload.
@interface MCAccessibilityReader : NSObject

/// Whether `AccessibilityPlatformTranslation` could be loaded and `SimDevice` exposes the
/// translation-request selector in this process. `NO` is definitive and device-independent; it
/// generally means an Xcode/CoreSimulator older than the one that introduced this path.
@property (class, nonatomic, readonly, getter=isAvailable) BOOL available;

/// Why `available` is `NO`, or `nil` when it is `YES`.
@property (class, nonatomic, readonly, nullable) NSString *unavailableReason;

/// Reads the frontmost application's accessibility tree as a JSON-serializable dictionary tree.
///
/// - `maxDepth`: the root counts as depth `0`; children beyond `maxDepth` are cut off (their
///   parent still reports `children: []`, never a mix of the real count and a partial list).
/// - `maxNodes`: a running budget across the whole traversal (root included); traversal stops
///   filling further siblings/children once it is exhausted rather than throwing, since a
///   truncated-but-well-formed tree is more useful to a caller than none at all.
/// - `requestTimeout`: the most this call will wait for a single translator round trip.
///
/// Returns `nil` and sets `error` (in `MCAccessibilityErrorDomain`) when the framework/selector is
/// unavailable, the device is not booted, the wait times out, or there is no frontmost application.
+ (nullable NSDictionary<NSString *, id> *)accessibilityTreeForDevice:(MCSimulatorDevice *)device
                                                               maxDepth:(NSInteger)maxDepth
                                                               maxNodes:(NSInteger)maxNodes
                                                         requestTimeout:(NSTimeInterval)requestTimeout
                                                                  error:(NSError **)error
    NS_SWIFT_NAME(accessibilityTree(device:maxDepth:maxNodes:requestTimeout:));

- (instancetype)init NS_UNAVAILABLE;

@end

/// Serializes a single accessibility element (and its accessible children, subject to the same
/// `maxDepth`/`maxNodes` bounds `MCAccessibilityReader` applies) into the dictionary shape
/// `AccessibilityParser` understands. `element` must respond to the same duck-typed
/// `NSAccessibility` selectors (`accessibilityRole`, `accessibilityLabel`, `accessibilityChildren`,
/// ...) the reader itself uses; it is declared as a plain `id` rather than `id<NSAccessibility>` so
/// a fake test object does not have to formally (and expensively, given how large that protocol
/// has grown) declare conformance -- exactly like the real translated elements this reads from,
/// which never declare it either.
///
/// Exposed separately from `MCAccessibilityReader` because it has no CoreSimulator/`dlopen`
/// dependency at all -- it is plain, public `NSAccessibility` traversal -- so tests can exercise the
/// exact bounding and serialization logic the real reader uses against a fake element, without a
/// booted simulator. `MCAccessibilityReader` itself calls this same function on the real
/// translated tree.
extern NSDictionary<NSString *, id> *_Nullable MCAccessibilityNodeForElement(id element,
                                                                              NSInteger maxDepth,
                                                                              NSInteger maxNodes);

NS_ASSUME_NONNULL_END
