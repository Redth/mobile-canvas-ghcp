#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// A settable stand-in for a translated `NSAccessibility` element, so `MCAccessibilityNodeForElement`
/// can be exercised deterministically without a booted simulator or the private translation
/// framework. Every property mirrors one of the selectors the real bridge reads; leaving a property
/// unset (`nil` for objects, the `has*` flag left `NO` for scalars) reproduces an element that does
/// not respond to that selector, exactly like a real `AXPMacPlatformElement` that has nothing to say
/// for a given attribute.
@interface MCFakeAXTranslation : NSObject

@property (nonatomic, copy, nullable) NSString *bridgeDelegateToken;

@end

@interface MCFakeAXElement : NSObject

@property (nonatomic, strong) MCFakeAXTranslation *translation;
@property (nonatomic, copy, nullable) NSString *expectedBridgeDelegateToken;
@property (nonatomic, copy, nullable) NSString *fakeRole;
@property (nonatomic, copy, nullable) NSString *fakeSubrole;
@property (nonatomic, copy, nullable) NSString *fakeLabel;
@property (nonatomic, copy, nullable) NSString *fakeIdentifier;
@property (nonatomic, copy, nullable) NSString *fakeHelp;
@property (nonatomic, nullable) id fakeValue;
@property (nonatomic) BOOL hasFakeValue;
@property (nonatomic) NSRect fakeFrame;
@property (nonatomic) BOOL hasFakeFrame;
@property (nonatomic) BOOL fakeEnabled;
@property (nonatomic) BOOL hasFakeEnabled;
@property (nonatomic) BOOL fakeFocused;
@property (nonatomic) BOOL hasFakeFocused;
@property (nonatomic, copy) NSArray<MCFakeAXElement *> *fakeChildren;
@property (nonatomic) BOOL hasFakeChildren;

@end

NS_ASSUME_NONNULL_END
