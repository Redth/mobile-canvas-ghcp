#import "AccessibilityTestSupport.h"

@implementation MCFakeAXTranslation
@end

@implementation MCFakeAXElement

- (instancetype)init
{
    self = [super init];
    if (self != nil) {
        _translation = [[MCFakeAXTranslation alloc] init];
        _fakeChildren = @[];
    }
    return self;
}

- (void)requireExpectedBridgeDelegateToken
{
    if (self.expectedBridgeDelegateToken != nil &&
        ![self.translation.bridgeDelegateToken isEqualToString:self.expectedBridgeDelegateToken]) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"Accessibility attribute read before bridge token propagation"];
    }
}

// Only "responds" to the bounded/typed selectors when the matching test explicitly set a value,
// so a test can reproduce a real `AXPMacPlatformElement` that simply has nothing to say for a
// given attribute (the bridge always checks `respondsToSelector:` first).
- (BOOL)respondsToSelector:(SEL)aSelector
{
    if (aSelector == @selector(accessibilityValue)) {
        return self.hasFakeValue;
    }
    if (aSelector == @selector(accessibilityFrame)) {
        return self.hasFakeFrame;
    }
    if (aSelector == @selector(isAccessibilityEnabled)) {
        return self.hasFakeEnabled;
    }
    if (aSelector == @selector(isAccessibilityFocused)) {
        return self.hasFakeFocused;
    }
    if (aSelector == @selector(accessibilityChildren)) {
        return self.hasFakeChildren;
    }
    return [super respondsToSelector:aSelector];
}

- (nullable NSString *)accessibilityRole
{
    [self requireExpectedBridgeDelegateToken];
    return self.fakeRole;
}

- (nullable NSString *)accessibilitySubrole
{
    return self.fakeSubrole;
}

- (nullable NSString *)accessibilityLabel
{
    return self.fakeLabel;
}

- (nullable NSString *)accessibilityIdentifier
{
    return self.fakeIdentifier;
}

- (nullable NSString *)accessibilityHelp
{
    return self.fakeHelp;
}

- (nullable id)accessibilityValue
{
    return self.fakeValue;
}

- (NSRect)accessibilityFrame
{
    return self.fakeFrame;
}

- (BOOL)isAccessibilityEnabled
{
    return self.fakeEnabled;
}

- (BOOL)isAccessibilityFocused
{
    return self.fakeFocused;
}

- (NSArray<MCFakeAXElement *> *)accessibilityChildren
{
    [self requireExpectedBridgeDelegateToken];
    return self.fakeChildren;
}

@end
