# Mobile Canvas contribution rules

- Treat the GitHub App canvas and VS Code extension as two hosts for the same Mobile Canvas product.
- Put behavior shared by both hosts in `web/` or another shared module; keep host-specific adapters and styling isolated to their host directories.
- When changing behavior, layout, theming, transport, or packaging for either host, verify the equivalent workflow in both the GitHub App canvas and VS Code extension.
- Do not fix one host by changing shared assets in a way that regresses the other. Add shared tests for shared behavior and host-specific tests for each adapter or override.
