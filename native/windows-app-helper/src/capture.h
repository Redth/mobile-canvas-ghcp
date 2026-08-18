#pragma once

#include <string>

namespace helper {

/// Runs the one-shot screenshot command.
///
/// Standard output receives nothing but PNG bytes and standard error receives exactly one JSON
/// descriptor line, so the two never mix and no framing has to be invented for the image. Returns
/// the process exit code; a failure still writes a versioned JSON line describing why.
int RunScreenshot(const std::string& request_json);

/// Runs the long-lived capture command.
///
/// Standard error receives one JSON descriptor line before any bytes and one JSON end line after
/// the last, both newline delimited. Standard output receives nothing but Annex-B H.264. The stream
/// deliberately ends when the window's size or DPI changes: an encoder is never handed frames of a
/// size it was not configured for.
int RunCapture(const std::string& request_json);

} // namespace helper
