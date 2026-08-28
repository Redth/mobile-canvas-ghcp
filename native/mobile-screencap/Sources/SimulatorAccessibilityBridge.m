#import "SimulatorAccessibilityBridge.h"

#import "SimulatorDeviceBridge.h"
#import "SimulatorPrivateAPI.h"

#import <AppKit/AppKit.h>
#import <dlfcn.h>

// Adapted from Meta's idb FBAXTranslationDispatcher, FBSimulatorAccessibilityCommands,
// FBAXPlatformElement, and FBAccessibilityDocument (MIT); see the repository LICENSE.
//
// Unlike idb, none of `AXPTranslator`, `AXPTranslatorRequest`/`AXPTranslatorResponse`, or the
// `AXPTranslationTokenDelegateHelper` protocol are declared against the real framework: this file
// never links `AccessibilityPlatformTranslation`, only `dlopen`s it, and every private type is
// either an informal protocol resolved through `NSClassFromString`/`respondsToSelector:` or plain
// `id`. `AXPTranslatorRequest`/`AXPTranslatorResponse` in particular never need a name here at
// all -- `AXPTranslator` builds the request and hands it to `accessibilityTranslationDelegateBridgeCallbackWithToken:`'s
// returned block, which only has to forward it verbatim to `SimDevice
// sendAccessibilityRequestAsync:` and hand the response back, so both stay untyped `id`.

NSString *const MCAccessibilityErrorDomain = @"com.github.copilot.mobile-canvas.accessibility";

static NSError *MCAccessibilityError(MCAccessibilityErrorCode code, NSString *description, id _Nullable underlying)
{
    NSMutableDictionary *details = [@{NSLocalizedDescriptionKey: description} mutableCopy];
    if ([underlying isKindOfClass:NSError.class]) {
        details[NSUnderlyingErrorKey] = underlying;
    } else if (underlying != nil) {
        details[@"UnderlyingDescription"] = [underlying description];
    }
    return [NSError errorWithDomain:MCAccessibilityErrorDomain code:code userInfo:details];
}

static NSString *const MCAXPFrameworkPath =
    @"/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation";

/// Loads `AccessibilityPlatformTranslation` once per process.
///
/// The Xcode SDK only ships a link-time `.tbd` stub for this framework; the real binary lives in
/// the dyld shared cache with no standalone Mach-O on disk, and is only reachable at this fixed
/// system path (confirmed by probing `dlopen` directly against a running `mobile-screencap`
/// process), unlike `SimulatorKit`/`CoreSimulator`, which are developer-directory-relative.
static BOOL MCLoadAccessibilityPlatformTranslation(NSString *_Nullable *_Nullable failureDetail)
{
    static BOOL loaded = NO;
    static NSString *detail = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        void *handle = dlopen(MCAXPFrameworkPath.fileSystemRepresentation, RTLD_LAZY | RTLD_LOCAL);
        if (handle == NULL) {
            const char *dlError = dlerror();
            detail = [NSString stringWithFormat:@"AccessibilityPlatformTranslation could not be loaded from %@%@",
                                                 MCAXPFrameworkPath,
                                                 dlError != NULL
                                                     ? [NSString stringWithFormat:@": %s", dlError]
                                                     : @""];
            return;
        }
        loaded = NSClassFromString(@"AXPTranslator") != nil;
        if (!loaded) {
            detail = @"AccessibilityPlatformTranslation loaded, but AXPTranslator is not present";
        }
    });
    if (!loaded && failureDetail != NULL) {
        *failureDetail = detail;
    }
    return loaded;
}

#pragma mark - Informal declarations for the runtime-only AXPTranslator

/// `AXPTranslator`'s class side. Declared as a protocol -- never a class literal -- so nothing here
/// requires (or emits a link-time reference to) the real `AXPTranslator` symbol.
@protocol MCAXPTranslatorClass <NSObject>
+ (nullable id)sharedInstance;
@end

/// `AXPTranslator`'s instance side; the handful of methods this reader actually calls.
@protocol MCAXPTranslator <NSObject>
- (void)setBridgeTokenDelegate:(nullable id)delegate;
- (nullable id)frontmostApplicationWithDisplayId:(uint32_t)displayId
                             bridgeDelegateToken:(nullable NSString *)token;
- (nullable id)macPlatformElementFromTranslation:(nullable id)translation;
@end

@protocol MCAXPTranslationObject <NSObject>
@property (nonatomic, copy, nullable) NSString *bridgeDelegateToken;
@end

@protocol MCAXPMacPlatformElement <NSObject>
@property (nonatomic, strong, readonly, nullable) id<MCAXPTranslationObject> translation;
@end

static BOOL MCSetTranslationBridgeDelegateToken(id _Nullable translation, NSString *token)
{
    if (![translation respondsToSelector:@selector(setBridgeDelegateToken:)]) {
        return NO;
    }
    [(id<MCAXPTranslationObject>)translation setBridgeDelegateToken:token];
    return YES;
}

static BOOL MCSetElementBridgeDelegateToken(id _Nullable element, NSString *token)
{
    if (![element respondsToSelector:@selector(translation)]) {
        return NO;
    }
    id translation = [(id<MCAXPMacPlatformElement>)element translation];
    return MCSetTranslationBridgeDelegateToken(translation, token);
}

#pragma mark - Bounded per-token XPC bridge

/// Per-read bookkeeping keyed by a one-shot token: which device to route a translation request to,
/// how long to wait for it, and whether that wait ever failed.
@interface MCAXRequestContext : NSObject
@property (nonatomic, strong) id device;
@property (nonatomic, assign) NSTimeInterval timeout;
@property (nonatomic, assign) BOOL timedOut;
@property (nonatomic, assign) BOOL requestFailed;
@end

@implementation MCAXRequestContext
@end

/// Implements the framework's private `AXPTranslationTokenDelegateHelper` protocol informally (by
/// selector name only -- the real protocol is never imported) and bridges its synchronous callback
/// to `SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:`.
///
/// `AXPTranslator` is a process-wide singleton with a single `bridgeTokenDelegate`, so this is a
/// singleton too; the token registry lets one delegate instance serve reads for different devices
/// without them racing each other's timeout/failure bookkeeping.
@interface MCAXTranslationDelegate : NSObject
@property (nonatomic, strong, readonly) dispatch_queue_t completionQueue;
@end

@implementation MCAXTranslationDelegate {
    NSLock *_lock;
    NSMutableDictionary<NSString *, MCAXRequestContext *> *_contexts;
}

+ (instancetype)sharedDelegate
{
    static MCAXTranslationDelegate *delegate = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        delegate = [[MCAXTranslationDelegate alloc] initInternal];
    });
    return delegate;
}

- (instancetype)initInternal
{
    self = [super init];
    if (self != nil) {
        _lock = [[NSLock alloc] init];
        _contexts = [NSMutableDictionary dictionary];
        _completionQueue = dispatch_queue_create("dev.mobilecanvas.accessibility.completion", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (NSString *)registerDevice:(id)device timeout:(NSTimeInterval)timeout
{
    NSString *token = [NSUUID UUID].UUIDString;
    MCAXRequestContext *context = [[MCAXRequestContext alloc] init];
    context.device = device;
    context.timeout = timeout;
    [_lock lock];
    _contexts[token] = context;
    [_lock unlock];
    return token;
}

- (void)unregisterToken:(NSString *)token
{
    [_lock lock];
    [_contexts removeObjectForKey:token];
    [_lock unlock];
}

- (nullable MCAXRequestContext *)contextForToken:(NSString *)token
{
    [_lock lock];
    MCAXRequestContext *context = _contexts[token];
    [_lock unlock];
    return context;
}

- (BOOL)didTimeOutForToken:(NSString *)token
{
    return [self contextForToken:token].timedOut;
}

- (BOOL)didRequestFailForToken:(NSString *)token
{
    return [self contextForToken:token].requestFailed;
}

#pragma mark AXPTranslationTokenDelegateHelper (informal)

/// The simulator host process has exactly one coordinate space, so platform and system frames are
/// the same rect; idb's own dispatcher makes the same simplification.
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token
{
    return rect;
}

/// The frontmost application is the traversal's own root, so it has no accessibility parent.
- (nullable id)accessibilityTranslationRootParentWithToken:(NSString *)token
{
    return nil;
}

/// Returns the synchronous `(request) -> response` block `AXPTranslator` invokes (from its own
/// internal queue, not ours) whenever it needs a translation round trip for `token`.
- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token
{
    __weak MCAXTranslationDelegate *weakSelf = self;
    NSString *capturedToken = [token copy];
    id (^callback)(id) = ^id(id request) {
        return [weakSelf sendRequest:request forToken:capturedToken];
    };
    return [callback copy];
}

#pragma mark Bounded synchronous send

/// Bridges the translator's synchronous callback to the async `sendAccessibilityRequestAsync:`,
/// waiting at most the registered timeout. The completion runs on `completionQueue`, never on the
/// thread that is waiting on `semaphore`, so there is no self-deadlock.
- (nullable id)sendRequest:(id)request forToken:(NSString *)token
{
    MCAXRequestContext *context = [self contextForToken:token];
    if (context == nil || request == nil) {
        return nil;
    }

    id device = context.device;
    if (![device respondsToSelector:@selector(sendAccessibilityRequestAsync:completionQueue:completionHandler:)]) {
        context.requestFailed = YES;
        return nil;
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block id response = nil;
    @try {
        [device sendAccessibilityRequestAsync:request
                               completionQueue:self.completionQueue
                             completionHandler:^(id _Nullable value) {
                                 response = value;
                                 dispatch_semaphore_signal(semaphore);
                             }];
    } @catch (__unused NSException *exception) {
        context.requestFailed = YES;
        dispatch_semaphore_signal(semaphore);
        return nil;
    }

    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(context.timeout, 0.0) * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(semaphore, deadline) != 0) {
        context.timedOut = YES;
        return nil;
    }
    return response;
}

@end

#pragma mark - Bounded traversal over the public NSAccessibility protocol

// `AXPMacPlatformElement` (the class `macPlatformElementFromTranslation:` returns) implements a few
// modern NSAccessibility selectors directly and relies on AppKit's `NSObject(NSAccessibility)`
// category -- which every `NSObject` picks up simply by linking AppKit, already true for this
// helper -- to forward the rest to its own legacy `accessibilityAttributeValue:` override. So,
// unlike `AXPTranslator` itself, no private declarations are needed to read attributes: these are
// all genuine public AppKit selectors.

static NSString *_Nullable MCAXStringSelector(BOOL (^responds)(void), NSString *_Nullable (^read)(void))
{
    if (!responds()) {
        return nil;
    }
    @try {
        NSString *value = read();
        return [value isKindOfClass:NSString.class] && value.length > 0 ? value : nil;
    } @catch (__unused NSException *exception) {
        return nil;
    }
}

static NSString *_Nullable MCAXRole(id<NSAccessibility> element)
{
    return MCAXStringSelector(
        ^BOOL { return [element respondsToSelector:@selector(accessibilityRole)]; },
        ^NSString *_Nullable { return [element accessibilityRole]; });
}

static NSString *_Nullable MCAXSubrole(id<NSAccessibility> element)
{
    return MCAXStringSelector(
        ^BOOL { return [element respondsToSelector:@selector(accessibilitySubrole)]; },
        ^NSString *_Nullable { return [element accessibilitySubrole]; });
}

static NSString *_Nullable MCAXLabel(id<NSAccessibility> element)
{
    return MCAXStringSelector(
        ^BOOL { return [element respondsToSelector:@selector(accessibilityLabel)]; },
        ^NSString *_Nullable { return [element accessibilityLabel]; });
}

static NSString *_Nullable MCAXIdentifier(id<NSAccessibility> element)
{
    return MCAXStringSelector(
        ^BOOL { return [element respondsToSelector:@selector(accessibilityIdentifier)]; },
        ^NSString *_Nullable { return [element accessibilityIdentifier]; });
}

static NSString *_Nullable MCAXHelp(id<NSAccessibility> element)
{
    return MCAXStringSelector(
        ^BOOL { return [element respondsToSelector:@selector(accessibilityHelp)]; },
        ^NSString *_Nullable { return [element accessibilityHelp]; });
}

static id _Nullable MCAXValue(id<NSAccessibility> element)
{
    if (![element respondsToSelector:@selector(accessibilityValue)]) {
        return nil;
    }
    @try {
        return [element accessibilityValue];
    } @catch (__unused NSException *exception) {
        return nil;
    }
}

static BOOL MCAXFrame(id<NSAccessibility> element, NSRect *outFrame)
{
    if (![element respondsToSelector:@selector(accessibilityFrame)]) {
        return NO;
    }
    @try {
        *outFrame = [element accessibilityFrame];
        return YES;
    } @catch (__unused NSException *exception) {
        return NO;
    }
}

static BOOL MCAXEnabled(id<NSAccessibility> element, BOOL *outValue)
{
    if (![element respondsToSelector:@selector(isAccessibilityEnabled)]) {
        return NO;
    }
    @try {
        *outValue = [element isAccessibilityEnabled];
        return YES;
    } @catch (__unused NSException *exception) {
        return NO;
    }
}

static BOOL MCAXFocused(id<NSAccessibility> element, BOOL *outValue)
{
    if (![element respondsToSelector:@selector(isAccessibilityFocused)]) {
        return NO;
    }
    @try {
        *outValue = [element isAccessibilityFocused];
        return YES;
    } @catch (__unused NSException *exception) {
        return NO;
    }
}

static NSArray *_Nullable MCAXChildren(id<NSAccessibility> element)
{
    if (![element respondsToSelector:@selector(accessibilityChildren)]) {
        return nil;
    }
    @try {
        id value = [element accessibilityChildren];
        return [value isKindOfClass:NSArray.class] ? value : nil;
    } @catch (__unused NSException *exception) {
        return nil;
    }
}

/// Strips the "AX" prefix idb/AppKit roles carry (`AXButton` -> `Button`), matching the managed
/// `AccessibilityParser`'s own historical `type` spelling. Left untouched when there is no prefix.
static NSString *_Nullable MCNormalizeRole(NSString *_Nullable role)
{
    if (role.length > 2 && [role hasPrefix:@"AX"]) {
        return [role substringFromIndex:2];
    }
    return role;
}

/// `accessibilityValue` can answer with anything (a string, a number, a custom value object for a
/// slider/stepper, ...); only JSON-native kinds are passed through unchanged; everything else
/// degrades to its `description` rather than failing serialization or silently vanishing.
static id _Nullable MCConvertAccessibilityValue(id _Nullable value)
{
    if (value == nil || [value isKindOfClass:NSNull.class]) {
        return nil;
    }
    if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) {
        return value;
    }
    NSString *description = [value description];
    return description.length > 0 ? description : nil;
}

/// Depth-first, bounded by `maxDepth` (root is depth `0`) and a running `remainingNodes` budget
/// shared across the whole traversal (root included). Once the budget is spent, further
/// siblings/children are simply omitted -- a truncated well-formed tree beats an error or a
/// half-built one.
static NSDictionary<NSString *, id> *_Nullable MCBuildAccessibilityNode(id<NSAccessibility> element,
                                                                         NSInteger depth,
                                                                         NSInteger maxDepth,
                                                                         NSInteger *remainingNodes,
                                                                         NSString *_Nullable bridgeDelegateToken)
{
    if (*remainingNodes <= 0) {
        return nil;
    }
    if (bridgeDelegateToken != nil && !MCSetElementBridgeDelegateToken(element, bridgeDelegateToken)) {
        return nil;
    }
    (*remainingNodes)--;

    NSMutableDictionary<NSString *, id> *node = [NSMutableDictionary dictionary];

    NSString *role = MCAXRole(element);
    if (role != nil) {
        node[@"role"] = role;
        NSString *normalized = MCNormalizeRole(role);
        if (normalized != nil) {
            node[@"type"] = normalized;
        }
    }
    NSString *subrole = MCAXSubrole(element);
    if (subrole != nil) {
        node[@"subrole"] = subrole;
    }
    NSString *label = MCAXLabel(element);
    if (label != nil) {
        node[@"AXLabel"] = label;
    }
    id value = MCConvertAccessibilityValue(MCAXValue(element));
    if (value != nil) {
        node[@"AXValue"] = value;
    }
    NSString *identifier = MCAXIdentifier(element);
    if (identifier != nil) {
        node[@"AXUniqueId"] = identifier;
    }
    NSString *help = MCAXHelp(element);
    if (help != nil) {
        node[@"help"] = help;
    }

    NSRect frame;
    if (MCAXFrame(element, &frame)) {
        node[@"frame"] = @{
            @"x": @(frame.origin.x),
            @"y": @(frame.origin.y),
            @"width": @(frame.size.width),
            @"height": @(frame.size.height),
        };
    }

    BOOL enabled;
    if (MCAXEnabled(element, &enabled)) {
        node[@"enabled"] = @(enabled);
    }
    BOOL focused;
    if (MCAXFocused(element, &focused)) {
        node[@"focused"] = @(focused);
    }

    NSMutableArray<NSDictionary<NSString *, id> *> *children = [NSMutableArray array];
    if (depth < maxDepth) {
        for (id child in MCAXChildren(element) ?: @[]) {
            if (*remainingNodes <= 0) {
                break;
            }
            if (![child isKindOfClass:NSObject.class]) {
                continue;
            }
            NSDictionary<NSString *, id> *childNode =
                MCBuildAccessibilityNode((id<NSAccessibility>)child, depth + 1, maxDepth, remainingNodes,
                                         bridgeDelegateToken);
            if (childNode != nil) {
                [children addObject:childNode];
            } else if (bridgeDelegateToken != nil) {
                return nil;
            }
        }
    }
    node[@"children"] = children;

    return node;
}

NSDictionary<NSString *, id> *_Nullable MCAccessibilityNodeForElement(id element,
                                                                       NSInteger maxDepth,
                                                                       NSInteger maxNodes)
{
    NSInteger remaining = MAX(maxNodes, 1);
    return MCBuildAccessibilityNode((id<NSAccessibility>)element, 0, MAX(maxDepth, 0), &remaining, nil);
}

NSDictionary<NSString *, id> *_Nullable MCAccessibilityNodeForElementWithBridgeDelegateToken(
    id element,
    NSInteger maxDepth,
    NSInteger maxNodes,
    NSString *bridgeDelegateToken)
{
    NSInteger remaining = MAX(maxNodes, 1);
    return MCBuildAccessibilityNode((id<NSAccessibility>)element, 0, MAX(maxDepth, 0), &remaining,
                                    bridgeDelegateToken);
}

#pragma mark - MCAccessibilityReader

@implementation MCAccessibilityReader

+ (BOOL)isAvailable
{
    return MCLoadAccessibilityPlatformTranslation(NULL);
}

+ (nullable NSString *)unavailableReason
{
    NSString *detail = nil;
    BOOL loaded = MCLoadAccessibilityPlatformTranslation(&detail);
    return loaded ? nil : (detail ?: @"AccessibilityPlatformTranslation is unavailable");
}

+ (nullable NSDictionary<NSString *, id> *)accessibilityTreeForDevice:(MCSimulatorDevice *)device
                                                               maxDepth:(NSInteger)maxDepth
                                                               maxNodes:(NSInteger)maxNodes
                                                         requestTimeout:(NSTimeInterval)requestTimeout
                                                                  error:(NSError **)error
{
    NSString *loadFailure = nil;
    if (!MCLoadAccessibilityPlatformTranslation(&loadFailure)) {
        if (error != NULL) {
            *error = MCAccessibilityError(MCAccessibilityErrorFrameworkUnavailable,
                                           loadFailure ?: @"AccessibilityPlatformTranslation could not be loaded",
                                           nil);
        }
        return nil;
    }

    Class<MCAXPTranslatorClass> translatorClass = (Class<MCAXPTranslatorClass>)NSClassFromString(@"AXPTranslator");
    if (translatorClass == nil || ![translatorClass respondsToSelector:@selector(sharedInstance)]) {
        if (error != NULL) {
            *error = MCAccessibilityError(MCAccessibilityErrorSelectorUnavailable,
                                           @"AXPTranslator.sharedInstance is not available in this process", nil);
        }
        return nil;
    }

    id rawDevice = device.device;
    if (![rawDevice respondsToSelector:@selector(sendAccessibilityRequestAsync:completionQueue:completionHandler:)]) {
        if (error != NULL) {
            *error = MCAccessibilityError(
                MCAccessibilityErrorSelectorUnavailable,
                @"This CoreSimulator does not expose sendAccessibilityRequestAsync:; Xcode 12 or later is required",
                nil);
        }
        return nil;
    }

    @try {
        id<MCAXPTranslator> translator = (id<MCAXPTranslator>)[translatorClass sharedInstance];
        if (translator == nil) {
            if (error != NULL) {
                *error = MCAccessibilityError(MCAccessibilityErrorSelectorUnavailable,
                                               @"AXPTranslator.sharedInstance returned nil", nil);
            }
            return nil;
        }

        MCAXTranslationDelegate *delegate = [MCAXTranslationDelegate sharedDelegate];
        NSString *token = [delegate registerDevice:rawDevice timeout:MAX(requestTimeout, 0.1)];

        @try {
            [translator setBridgeTokenDelegate:delegate];
            id application = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:token];
            if (application != nil && !MCSetTranslationBridgeDelegateToken(application, token)) {
                if (error != NULL) {
                    *error = MCAccessibilityError(
                        MCAccessibilityErrorSelectorUnavailable,
                        @"The accessibility translation object does not expose bridgeDelegateToken", nil);
                }
                return nil;
            }
            id root = application != nil ? [translator macPlatformElementFromTranslation:application] : nil;

            if (root == nil || ![root isKindOfClass:NSObject.class]) {
                if (error != NULL) {
                    if ([delegate didTimeOutForToken:token]) {
                        *error = MCAccessibilityError(
                            MCAccessibilityErrorTimeout,
                            [NSString stringWithFormat:
                                          @"Timed out waiting %.1fs for the simulator's accessibility translation",
                                          requestTimeout],
                            nil);
                    } else if ([delegate didRequestFailForToken:token]) {
                        *error = MCAccessibilityError(
                            MCAccessibilityErrorInternal,
                            @"The simulator rejected an accessibility translation request", nil);
                    } else {
                        *error = MCAccessibilityError(MCAccessibilityErrorEmptyTree,
                                                       @"The simulator reported no frontmost application", nil);
                    }
                }
                return nil;
            }

            NSDictionary<NSString *, id> *tree =
                MCAccessibilityNodeForElementWithBridgeDelegateToken(
                    (id<NSAccessibility>)root, maxDepth, maxNodes, token);

            if ([delegate didTimeOutForToken:token]) {
                if (error != NULL) {
                    *error = MCAccessibilityError(
                        MCAccessibilityErrorTimeout,
                        [NSString stringWithFormat:
                                      @"Timed out waiting %.1fs for the simulator's accessibility translation",
                                      requestTimeout],
                        nil);
                }
                return nil;
            }
            if ([delegate didRequestFailForToken:token]) {
                if (error != NULL) {
                    *error = MCAccessibilityError(
                        MCAccessibilityErrorInternal,
                        @"The simulator rejected an accessibility translation request", nil);
                }
                return nil;
            }
            if (tree == nil) {
                if (error != NULL) {
                    *error = MCAccessibilityError(
                        MCAccessibilityErrorEmptyTree,
                        @"The frontmost application reported no readable accessibility attributes", nil);
                }
                return nil;
            }
            return tree;
        } @finally {
            [delegate unregisterToken:token];
        }
    } @catch (NSException *exception) {
        if (error != NULL) {
            *error = MCAccessibilityError(
                MCAccessibilityErrorInternal,
                [NSString stringWithFormat:@"Reading the accessibility tree raised %@: %@", exception.name,
                                            exception.reason ?: @"no reason"],
                nil);
        }
        return nil;
    }
}

@end
