#include "uia.h"

#include "support.h"
#include "version.h"

#include <UIAutomation.h>
#include <oleauto.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cwctype>
#include <exception>
#include <functional>
#include <initializer_list>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace helper {
namespace {

constexpr int kDefaultDepth = 12;
constexpr int kMaximumDepth = 32;
constexpr int kDefaultNodes = 500;
constexpr int kMaximumNodes = 5000;
constexpr int kDefaultTimeoutMilliseconds = 5000;
constexpr int kMaximumTimeoutMilliseconds = 30000;
constexpr int kDefaultQueryLimit = 50;
constexpr int kMaximumQueryLimit = 500;
constexpr int kDefaultPollMilliseconds = 200;
constexpr int kMinimumPollMilliseconds = 50;
constexpr size_t kMaximumRequestBytes = 64 * 1024;
constexpr size_t kMaximumRequestTextCharacters = 4096;
// At the public maximum of 5000 nodes this keeps worst-case serialized helper output below the
// managed bridge's hard 16 MB output cap. A provider's unbounded strings must not bypass a tree cap.
constexpr size_t kMaximumOutputTextCharacters = 64;
constexpr size_t kMaximumAncestors = 16;

constexpr char kUiInvalidSelector[] = "windows_uia_invalid_selector";
constexpr char kUiElementNotFound[] = "windows_uia_element_not_found";
constexpr char kUiElementAmbiguous[] = "windows_uia_element_ambiguous";
constexpr char kUiCapabilityUnavailable[] = "windows_uia_capability_unavailable";
constexpr char kUiPasswordValueForbidden[] = "windows_uia_password_value_forbidden";
constexpr char kUiTimeout[] = "windows_uia_timeout";
constexpr char kUiActionFailed[] = "windows_uia_action_failed";

class JsonValue final {
public:
	enum class Kind {
		Null,
		Boolean,
		Number,
		String,
		Array,
		Object,
	};

	Kind kind = Kind::Null;
	bool boolean = false;
	std::string text;
	std::vector<JsonValue> array;
	std::vector<std::pair<std::string, JsonValue>> object;

	const JsonValue* Field(std::string_view name) const {
		for (const auto& pair : object) {
			if (pair.first == name) {
				return &pair.second;
			}
		}
		return nullptr;
	}
};

class JsonParser final {
public:
	explicit JsonParser(std::string_view input) : input_(input) {}

	JsonValue Parse() {
		SkipWhitespace();
		JsonValue result = Value(0);
		SkipWhitespace();
		if (position_ != input_.size()) {
			Fail("Unexpected content after the JSON request.");
		}
		return result;
	}

private:
	[[noreturn]] static void Fail(std::string message) {
		throw FatalError("uia_invalid_request", std::move(message));
	}

	void SkipWhitespace() {
		while (position_ < input_.size()) {
			const char character = input_[position_];
			if (character != ' ' && character != '\n' && character != '\r' && character != '\t') {
				return;
			}
			++position_;
		}
	}

	char Take() {
		if (position_ == input_.size()) {
			Fail("The JSON request ended unexpectedly.");
		}
		return input_[position_++];
	}

	void Expect(char expected) {
		if (Take() != expected) {
			Fail("The JSON request has invalid syntax.");
		}
	}

	JsonValue Value(int depth) {
		if (depth > 64) {
			Fail("The JSON request is nested too deeply.");
		}
		SkipWhitespace();
		if (position_ == input_.size()) {
			Fail("The JSON request ended unexpectedly.");
		}

		switch (input_[position_]) {
		case '{':
			return Object(depth + 1);
		case '[':
			return Array(depth + 1);
		case '"':
			return JsonValue{ JsonValue::Kind::String, false, String() };
		case 't':
			Keyword("true");
			return JsonValue{ JsonValue::Kind::Boolean, true };
		case 'f':
			Keyword("false");
			return JsonValue{ JsonValue::Kind::Boolean, false };
		case 'n':
			Keyword("null");
			return JsonValue{};
		default:
			if (input_[position_] == '-' ||
				(input_[position_] >= '0' && input_[position_] <= '9')) {
				return JsonValue{ JsonValue::Kind::Number, false, Number() };
			}
			Fail("The JSON request has an invalid value.");
		}
	}

	JsonValue Object(int depth) {
		Expect('{');
		JsonValue result;
		result.kind = JsonValue::Kind::Object;
		SkipWhitespace();
		if (position_ < input_.size() && input_[position_] == '}') {
			++position_;
			return result;
		}

		for (;;) {
			SkipWhitespace();
			if (position_ == input_.size() || input_[position_] != '"') {
				Fail("A JSON object key must be a string.");
			}
			std::string key = String();
			for (const auto& existing : result.object) {
				if (existing.first == key) {
					Fail("Duplicate JSON object fields are not allowed.");
				}
			}
			SkipWhitespace();
			Expect(':');
			result.object.emplace_back(std::move(key), Value(depth));
			SkipWhitespace();
			const char delimiter = Take();
			if (delimiter == '}') {
				return result;
			}
			if (delimiter != ',') {
				Fail("A JSON object is missing a comma.");
			}
		}
	}

	JsonValue Array(int depth) {
		Expect('[');
		JsonValue result;
		result.kind = JsonValue::Kind::Array;
		SkipWhitespace();
		if (position_ < input_.size() && input_[position_] == ']') {
			++position_;
			return result;
		}

		for (;;) {
			result.array.push_back(Value(depth));
			SkipWhitespace();
			const char delimiter = Take();
			if (delimiter == ']') {
				return result;
			}
			if (delimiter != ',') {
				Fail("A JSON array is missing a comma.");
			}
		}
	}

	void Keyword(std::string_view keyword) {
		if (input_.substr(position_, keyword.size()) != keyword) {
			Fail("The JSON request has an invalid literal.");
		}
		position_ += keyword.size();
	}

	static int Hex(char value) {
		if (value >= '0' && value <= '9') {
			return value - '0';
		}
		if (value >= 'a' && value <= 'f') {
			return value - 'a' + 10;
		}
		if (value >= 'A' && value <= 'F') {
			return value - 'A' + 10;
		}
		return -1;
	}

	std::uint32_t UnicodeEscape() {
		std::uint32_t value = 0;
		for (int index = 0; index < 4; ++index) {
			const int nibble = Hex(Take());
			if (nibble < 0) {
				Fail("The JSON request has an invalid Unicode escape.");
			}
			value = (value << 4) | static_cast<std::uint32_t>(nibble);
		}
		return value;
	}

	static void AppendUtf8(std::string& output, std::uint32_t code_point) {
		if (code_point <= 0x7f) {
			output += static_cast<char>(code_point);
		} else if (code_point <= 0x7ff) {
			output += static_cast<char>(0xc0 | (code_point >> 6));
			output += static_cast<char>(0x80 | (code_point & 0x3f));
		} else if (code_point <= 0xffff) {
			output += static_cast<char>(0xe0 | (code_point >> 12));
			output += static_cast<char>(0x80 | ((code_point >> 6) & 0x3f));
			output += static_cast<char>(0x80 | (code_point & 0x3f));
		} else {
			output += static_cast<char>(0xf0 | (code_point >> 18));
			output += static_cast<char>(0x80 | ((code_point >> 12) & 0x3f));
			output += static_cast<char>(0x80 | ((code_point >> 6) & 0x3f));
			output += static_cast<char>(0x80 | (code_point & 0x3f));
		}
	}

	std::string String() {
		Expect('"');
		std::string output;
		for (;;) {
			const char character = Take();
			if (character == '"') {
				return output;
			}
			if (static_cast<unsigned char>(character) < 0x20) {
				Fail("A JSON string contains an unescaped control character.");
			}
			if (character != '\\') {
				output += character;
				continue;
			}

			switch (Take()) {
			case '"':
				output += '"';
				break;
			case '\\':
				output += '\\';
				break;
			case '/':
				output += '/';
				break;
			case 'b':
				output += '\b';
				break;
			case 'f':
				output += '\f';
				break;
			case 'n':
				output += '\n';
				break;
			case 'r':
				output += '\r';
				break;
			case 't':
				output += '\t';
				break;
			case 'u': {
				std::uint32_t code_point = UnicodeEscape();
				if (code_point >= 0xd800 && code_point <= 0xdbff) {
					if (Take() != '\\' || Take() != 'u') {
						Fail("A JSON Unicode high surrogate has no low surrogate.");
					}
					const std::uint32_t low = UnicodeEscape();
					if (low < 0xdc00 || low > 0xdfff) {
						Fail("A JSON Unicode high surrogate has an invalid low surrogate.");
					}
					code_point = 0x10000 + ((code_point - 0xd800) << 10) + (low - 0xdc00);
				} else if (code_point >= 0xdc00 && code_point <= 0xdfff) {
					Fail("A JSON Unicode low surrogate has no high surrogate.");
				}
				AppendUtf8(output, code_point);
				break;
			}
			default:
				Fail("The JSON request has an invalid string escape.");
			}
		}
	}

	std::string Number() {
		const size_t first = position_;
		if (input_[position_] == '-') {
			++position_;
		}
		if (position_ == input_.size()) {
			Fail("The JSON request has an invalid number.");
		}
		if (input_[position_] == '0') {
			++position_;
		} else if (input_[position_] >= '1' && input_[position_] <= '9') {
			do {
				++position_;
			} while (position_ < input_.size() &&
				input_[position_] >= '0' && input_[position_] <= '9');
		} else {
			Fail("The JSON request has an invalid number.");
		}
		if (position_ < input_.size() &&
			(input_[position_] == '.' || input_[position_] == 'e' || input_[position_] == 'E')) {
			Fail("UI Automation request numbers must be integers.");
		}
		return std::string(input_.substr(first, position_ - first));
	}

	std::string_view input_;
	size_t position_ = 0;
};

[[noreturn]] void InvalidRequest(std::string message) {
	throw FatalError("uia_invalid_request", std::move(message));
}

void RequireObject(const JsonValue& value, std::string_view name) {
	if (value.kind != JsonValue::Kind::Object) {
		InvalidRequest(std::string(name) + " must be a JSON object.");
	}
}

void RequireOnly(const JsonValue& object, std::initializer_list<std::string_view> fields) {
	RequireObject(object, "value");
	for (const auto& pair : object.object) {
		bool allowed = false;
		for (const auto field : fields) {
			if (pair.first == field) {
				allowed = true;
				break;
			}
		}
		if (!allowed) {
			InvalidRequest("The JSON request contains an unknown field: " + pair.first + ".");
		}
	}
}

const JsonValue& Required(const JsonValue& object, std::string_view name) {
	const JsonValue* value = object.Field(name);
	if (value == nullptr) {
		InvalidRequest("The JSON request is missing " + std::string(name) + ".");
	}
	return *value;
}

std::int64_t Integer(const JsonValue& value, std::string_view name) {
	if (value.kind != JsonValue::Kind::Number) {
		InvalidRequest(std::string(name) + " must be an integer.");
	}
	try {
		size_t read = 0;
		const auto result = std::stoll(value.text, &read, 10);
		if (read != value.text.size()) {
			InvalidRequest(std::string(name) + " must be an integer.");
		}
		return result;
	} catch (const std::exception&) {
		InvalidRequest(std::string(name) + " is outside the supported integer range.");
	}
}

std::optional<std::wstring> OptionalWideString(
	const JsonValue& object,
	std::string_view name,
	size_t maximum = kMaximumRequestTextCharacters,
	bool preserve_empty = false) {
	const JsonValue* value = object.Field(name);
	if (value == nullptr || value->kind == JsonValue::Kind::Null) {
		return std::nullopt;
	}
	if (value->kind != JsonValue::Kind::String) {
		InvalidRequest(std::string(name) + " must be a string.");
	}
	if (value->text.find('\0') != std::string::npos) {
		InvalidRequest(std::string(name) + " must not contain a null character.");
	}
	if (value->text.size() > maximum * 4) {
		InvalidRequest(std::string(name) + " is too long.");
	}
	if (value->text.empty()) {
		return preserve_empty ? std::optional<std::wstring>(L"") : std::nullopt;
	}
	const int needed = MultiByteToWideChar(
		CP_UTF8,
		MB_ERR_INVALID_CHARS,
		value->text.data(),
		static_cast<int>(value->text.size()),
		nullptr,
		0);
	if (needed <= 0) {
		InvalidRequest(std::string(name) + " is not valid UTF-8.");
	}
	std::wstring result(static_cast<size_t>(needed), L'\0');
	if (MultiByteToWideChar(
			CP_UTF8,
			MB_ERR_INVALID_CHARS,
			value->text.data(),
			static_cast<int>(value->text.size()),
			result.data(),
			needed) != needed) {
		InvalidRequest(std::string(name) + " is not valid UTF-8.");
	}
	if (result.size() > maximum) {
		InvalidRequest(std::string(name) + " is too long.");
	}
	return result;
}

bool OptionalBoolean(const JsonValue& object, std::string_view name, bool fallback) {
	const JsonValue* value = object.Field(name);
	if (value == nullptr) {
		return fallback;
	}
	if (value->kind != JsonValue::Kind::Boolean) {
		InvalidRequest(std::string(name) + " must be a boolean.");
	}
	return value->boolean;
}

int BoundedInteger(
	const JsonValue& object,
	std::string_view name,
	int fallback,
	int minimum,
	int maximum) {
	const JsonValue* value = object.Field(name);
	if (value == nullptr) {
		return fallback;
	}
	const std::int64_t parsed = Integer(*value, name);
	if (parsed < minimum || parsed > maximum) {
		InvalidRequest(
			std::string(name) + " must be between " + std::to_string(minimum) + " and " +
			std::to_string(maximum) + ".");
	}
	return static_cast<int>(parsed);
}

bool EqualNoCase(std::wstring_view left, std::wstring_view right) {
	return CompareStringOrdinal(
		left.data(),
		static_cast<int>(left.size()),
		right.data(),
		static_cast<int>(right.size()),
		TRUE) == CSTR_EQUAL;
}

bool ContainsNoCase(std::wstring_view haystack, std::wstring_view needle) {
	if (needle.empty()) {
		return true;
	}
	if (needle.size() > haystack.size()) {
		return false;
	}
	for (size_t start = 0; start + needle.size() <= haystack.size(); ++start) {
		bool matches = true;
		for (size_t index = 0; index < needle.size(); ++index) {
			if (std::towlower(haystack[start + index]) != std::towlower(needle[index])) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return true;
		}
	}
	return false;
}

bool MatchesText(
	const std::wstring& actual,
	const std::optional<std::wstring>& expected,
	bool exact) {
	if (!expected.has_value()) {
		return true;
	}
	return exact
		? EqualNoCase(actual, *expected)
		: ContainsNoCase(actual, *expected);
}

struct SelectorAtom {
	std::optional<std::wstring> automation_id;
	std::optional<std::wstring> control_type;
	std::optional<std::wstring> role;
	std::optional<std::wstring> name;
	bool exact = true;
};

struct Selector : SelectorAtom {
	std::optional<std::wstring> value;
	std::vector<SelectorAtom> ancestors;
	std::vector<int> path;
	std::optional<int> index;
};

enum class SelectorStrategy {
	AutomationIdAndControlType,
	ControlTypeAndNameOrValue,
	QualifiedFallback,
};

bool HasType(const SelectorAtom& selector) {
	return selector.control_type.has_value() || selector.role.has_value();
}

SelectorStrategy StrategyFor(const Selector& selector) {
	if (selector.automation_id.has_value() && HasType(selector)) {
		return SelectorStrategy::AutomationIdAndControlType;
	}
	if (HasType(selector) && (selector.name.has_value() || selector.value.has_value())) {
		return SelectorStrategy::ControlTypeAndNameOrValue;
	}
	return SelectorStrategy::QualifiedFallback;
}

void ValidateSelector(const Selector& selector) {
	const bool qualified = !selector.ancestors.empty() || !selector.path.empty() ||
		selector.index.has_value();
	if (!(selector.automation_id.has_value() && HasType(selector)) &&
		!(HasType(selector) && (selector.name.has_value() || selector.value.has_value())) &&
		!qualified) {
		throw FatalError(
			kUiInvalidSelector,
			"A selector must use automationId plus controlType/role, controlType/role plus " +
				std::string("name/value, or an explicit ancestry, index, or path."));
	}
	if (selector.automation_id.has_value() && !HasType(selector)) {
		throw FatalError(
			kUiInvalidSelector,
			"An automationId selector requires controlType or role.");
	}
}

SelectorAtom ParseSelectorAtom(const JsonValue& value, bool allow_value) {
	RequireObject(value, "selector");
	if (allow_value) {
		RequireOnly(
			value,
			{
				"automationId", "controlType", "role", "name", "value", "exact",
				"ancestors", "path", "index",
			});
	} else {
		// Managed ancestor atoms use the public selector type, whose non-null array defaults
		// serialize as empty arrays. Accept those structural fields only when they remain empty;
		// nested ancestry/indexing is still invalid and cannot alter selector semantics.
		RequireOnly(
			value,
			{ "automationId", "controlType", "role", "name", "exact", "ancestors", "path" });
		for (const char* field_name : { "ancestors", "path" }) {
			if (const JsonValue* field = value.Field(field_name);
				field != nullptr
				&& (field->kind != JsonValue::Kind::Array || !field->array.empty())) {
				InvalidRequest(
					std::string("A selector ancestor cannot contain non-empty ")
					+ field_name + ".");
			}
		}
	}
	SelectorAtom result;
	result.automation_id = OptionalWideString(value, "automationId");
	result.control_type = OptionalWideString(value, "controlType", 128);
	result.role = OptionalWideString(value, "role", 128);
	result.name = OptionalWideString(value, "name");
	result.exact = OptionalBoolean(value, "exact", true);
	return result;
}

Selector ParseSelector(const JsonValue& value) {
	Selector result;
	SelectorAtom base = ParseSelectorAtom(value, true);
	result.automation_id = std::move(base.automation_id);
	result.control_type = std::move(base.control_type);
	result.role = std::move(base.role);
	result.name = std::move(base.name);
	result.exact = base.exact;
	result.value = OptionalWideString(value, "value");

	if (const JsonValue* ancestors = value.Field("ancestors")) {
		if (ancestors->kind != JsonValue::Kind::Array ||
			ancestors->array.size() > kMaximumAncestors) {
			InvalidRequest("ancestors must be an array of at most 16 selector atoms.");
		}
		for (const auto& ancestor : ancestors->array) {
			SelectorAtom parsed = ParseSelectorAtom(ancestor, false);
			if (!parsed.automation_id.has_value() && !parsed.control_type.has_value() &&
				!parsed.role.has_value() && !parsed.name.has_value()) {
				InvalidRequest("Every selector ancestor needs a semantic constraint.");
			}
			result.ancestors.push_back(std::move(parsed));
		}
	}
	if (const JsonValue* path = value.Field("path")) {
		if (path->kind != JsonValue::Kind::Array || path->array.size() > kMaximumDepth) {
			InvalidRequest("path must be an array no longer than the maximum depth.");
		}
		for (const auto& index : path->array) {
			const std::int64_t parsed = Integer(index, "path");
			if (parsed < 0 || parsed > std::numeric_limits<int>::max()) {
				InvalidRequest("path indexes must be non-negative integers.");
			}
			result.path.push_back(static_cast<int>(parsed));
		}
	}
	if (const JsonValue* index = value.Field("index")) {
		const std::int64_t parsed = Integer(*index, "index");
		if (parsed < 0 || parsed > std::numeric_limits<int>::max()) {
			InvalidRequest("index must be a non-negative integer.");
		}
		result.index = static_cast<int>(parsed);
	}
	ValidateSelector(result);
	return result;
}

struct Limits {
	int maximum_depth = kDefaultDepth;
	int maximum_nodes = kDefaultNodes;
	int timeout_milliseconds = kDefaultTimeoutMilliseconds;
};

Limits ParseLimits(const JsonValue& object) {
	return {
		BoundedInteger(object, "maximumDepth", kDefaultDepth, 1, kMaximumDepth),
		BoundedInteger(object, "maximumNodes", kDefaultNodes, 1, kMaximumNodes),
		BoundedInteger(
			object,
			"timeoutMilliseconds",
			kDefaultTimeoutMilliseconds,
			1,
			kMaximumTimeoutMilliseconds),
	};
}

struct RequestRoot {
	uintptr_t handle = 0;
	std::shared_ptr<JsonValue> body;
};

RequestRoot ParseRoot(std::string_view json, std::string_view body_name) {
	if (json.size() > kMaximumRequestBytes) {
		InvalidRequest("The UI Automation request is too large.");
	}
	const JsonValue root = JsonParser(json).Parse();
	RequireObject(root, "request");
	RequireOnly(root, { "schemaVersion", "handle", body_name });
	if (Integer(Required(root, "schemaVersion"), "schemaVersion") != 1) {
		throw FatalError(
			"uia_schema_incompatible",
			"The UI Automation request schemaVersion must be 1.");
	}
	const std::int64_t handle = Integer(Required(root, "handle"), "handle");
	if (handle <= 0 ||
		static_cast<std::uint64_t>(handle) >
			static_cast<std::uint64_t>(std::numeric_limits<uintptr_t>::max())) {
		InvalidRequest("handle must be a positive native window handle.");
	}
	const JsonValue& body = Required(root, body_name);
	RequireObject(body, body_name);
	// The parser owns this local root. Retain a private copy of the body long enough for the
	// command-specific parser to validate it without exposing a general JSON DOM outside this file.
	return { static_cast<uintptr_t>(handle), std::make_shared<JsonValue>(body) };
}

struct SnapshotRequest {
	uintptr_t handle = 0;
	Limits limits;
};

struct QueryRequest {
	uintptr_t handle = 0;
	Limits limits;
	Selector selector;
	int limit = kDefaultQueryLimit;
};

struct ScrollRequest {
	std::string direction;
	std::string amount;
};

struct ActionRequest {
	uintptr_t handle = 0;
	Limits limits;
	std::string action;
	Selector selector;
	std::optional<std::wstring> value;
	std::optional<ScrollRequest> scroll;
};

struct WaitRequest {
	uintptr_t handle = 0;
	Limits limits;
	Selector selector;
	std::string condition;
	std::optional<std::string> property;
	std::optional<std::wstring> expected_value;
	int poll_milliseconds = kDefaultPollMilliseconds;
};

SnapshotRequest ParseSnapshotRequest(std::string_view json) {
	const RequestRoot root = ParseRoot(json, "request");
	RequireOnly(*root.body, { "maximumDepth", "maximumNodes", "timeoutMilliseconds" });
	return { root.handle, ParseLimits(*root.body) };
}

QueryRequest ParseQueryRequest(std::string_view json) {
	const RequestRoot root = ParseRoot(json, "query");
	RequireOnly(
		*root.body,
		{ "selector", "limit", "maximumDepth", "maximumNodes", "timeoutMilliseconds" });
	QueryRequest result;
	result.handle = root.handle;
	result.limits = ParseLimits(*root.body);
	result.selector = ParseSelector(Required(*root.body, "selector"));
	result.limit = BoundedInteger(
		*root.body,
		"limit",
		kDefaultQueryLimit,
		1,
		kMaximumQueryLimit);
	return result;
}

std::string RequiredEnum(
	const JsonValue& object,
	std::string_view name,
	std::initializer_list<std::string_view> allowed) {
	const JsonValue& value = Required(object, name);
	if (value.kind != JsonValue::Kind::String) {
		InvalidRequest(std::string(name) + " must be a string.");
	}
	for (const auto option : allowed) {
		if (value.text == option) {
			return value.text;
		}
	}
	InvalidRequest(std::string(name) + " is not supported.");
}

ActionRequest ParseActionRequest(std::string_view json) {
	const RequestRoot root = ParseRoot(json, "request");
	RequireOnly(
		*root.body,
		{
			"action", "selector", "value", "scroll", "maximumDepth", "maximumNodes",
			"timeoutMilliseconds",
		});
	ActionRequest result;
	result.handle = root.handle;
	result.limits = ParseLimits(*root.body);
	result.action = RequiredEnum(
		*root.body,
		"action",
		{
			"invoke", "setValue", "select", "toggle", "expand", "collapse", "scroll", "focus",
		});
	result.selector = ParseSelector(Required(*root.body, "selector"));
	result.value = OptionalWideString(
		*root.body,
		"value",
		kMaximumRequestTextCharacters,
		true);
	if (result.action == "setValue") {
		const JsonValue* value = root.body->Field("value");
		if (value == nullptr || value->kind == JsonValue::Kind::Null) {
			InvalidRequest("setValue requires value.");
		}
	} else if (root.body->Field("value") != nullptr &&
		root.body->Field("value")->kind != JsonValue::Kind::Null) {
		InvalidRequest("Only setValue accepts value.");
	}

	const JsonValue* scroll = root.body->Field("scroll");
	if (result.action == "scroll") {
		if (scroll == nullptr || scroll->kind != JsonValue::Kind::Object) {
			InvalidRequest("scroll requires a scroll object.");
		}
		RequireOnly(*scroll, { "direction", "amount" });
		result.scroll = ScrollRequest
		{
			RequiredEnum(*scroll, "direction", { "up", "down", "left", "right" }),
			RequiredEnum(*scroll, "amount", { "small", "large" }),
		};
	} else if (scroll != nullptr && scroll->kind != JsonValue::Kind::Null) {
		InvalidRequest("Only scroll accepts scroll options.");
	}
	return result;
}

WaitRequest ParseWaitRequest(std::string_view json) {
	const RequestRoot root = ParseRoot(json, "request");
	RequireOnly(
		*root.body,
		{
			"selector", "condition", "property", "expectedValue", "timeoutMilliseconds",
			"pollIntervalMilliseconds", "maximumDepth", "maximumNodes",
		});
	WaitRequest result;
	result.handle = root.handle;
	result.limits = ParseLimits(*root.body);
	result.selector = ParseSelector(Required(*root.body, "selector"));
	result.condition = RequiredEnum(
		*root.body,
		"condition",
		{ "exists", "notExists", "property", "state" });
	result.expected_value = OptionalWideString(*root.body, "expectedValue");
	result.poll_milliseconds = BoundedInteger(
		*root.body,
		"pollIntervalMilliseconds",
		kDefaultPollMilliseconds,
		kMinimumPollMilliseconds,
		kMaximumTimeoutMilliseconds);
	if (result.condition == "property" || result.condition == "state") {
		if (!result.expected_value.has_value()) {
			InvalidRequest("property and state waits require expectedValue.");
		}
		if (result.condition == "property") {
			const JsonValue& property = Required(*root.body, "property");
			if (property.kind != JsonValue::Kind::String) {
				InvalidRequest("property must be a string.");
			}
			static const std::unordered_set<std::string> allowed =
			{
				"name", "enabled", "offscreen", "focusable", "focused", "value",
			};
			if (allowed.find(property.text) == allowed.end()) {
				InvalidRequest("property is not supported.");
			}
			result.property = property.text;
		} else if (root.body->Field("property") != nullptr) {
			InvalidRequest("state waits do not accept property.");
		}
	} else if (root.body->Field("property") != nullptr ||
		root.body->Field("expectedValue") != nullptr) {
		InvalidRequest("exists and notExists waits do not accept property or expectedValue.");
	}
	return result;
}

std::wstring LimitText(std::wstring value, bool* truncated = nullptr) {
	if (value.size() <= kMaximumOutputTextCharacters) {
		return value;
	}
	if (truncated != nullptr) {
		*truncated = true;
	}
	return value.substr(0, kMaximumOutputTextCharacters);
}

std::optional<std::wstring> CachedString(
	IUIAutomationElement* element,
	PROPERTYID property,
	bool* truncated) {
	VARIANT value;
	VariantInit(&value);
	const HRESULT result = element->GetCachedPropertyValue(property, &value);
	std::optional<std::wstring> text;
	if (SUCCEEDED(result) && value.vt == VT_BSTR && value.bstrVal != nullptr) {
		text = LimitText(value.bstrVal, truncated);
	}
	VariantClear(&value);
	return text;
}

std::optional<bool> CachedBoolean(IUIAutomationElement* element, PROPERTYID property) {
	VARIANT value;
	VariantInit(&value);
	const HRESULT result = element->GetCachedPropertyValue(property, &value);
	std::optional<bool> boolean;
	if (SUCCEEDED(result) && value.vt == VT_BOOL) {
		boolean = value.boolVal != VARIANT_FALSE;
	}
	VariantClear(&value);
	return boolean;
}

std::optional<long> CachedInteger(IUIAutomationElement* element, PROPERTYID property) {
	VARIANT value;
	VariantInit(&value);
	const HRESULT result = element->GetCachedPropertyValue(property, &value);
	std::optional<long> number;
	if (SUCCEEDED(result) && value.vt == VT_I4) {
		number = value.lVal;
	}
	VariantClear(&value);
	return number;
}

struct PixelRect {
	int left = 0;
	int top = 0;
	int width = 0;
	int height = 0;
};

std::optional<PixelRect> CachedBounds(IUIAutomationElement* element) {
	VARIANT value;
	VariantInit(&value);
	const HRESULT result = element->GetCachedPropertyValue(UIA_BoundingRectanglePropertyId, &value);
	std::optional<PixelRect> bounds;
	if (SUCCEEDED(result) && (value.vt & VT_ARRAY) != 0 &&
		(value.vt & VT_TYPEMASK) == VT_R8 && value.parray != nullptr) {
		LONG lower = 0;
		LONG upper = -1;
		if (SUCCEEDED(SafeArrayGetLBound(value.parray, 1, &lower)) &&
			SUCCEEDED(SafeArrayGetUBound(value.parray, 1, &upper)) &&
			upper - lower + 1 >= 4) {
			double* coordinates = nullptr;
			if (SUCCEEDED(SafeArrayAccessData(value.parray, reinterpret_cast<void**>(&coordinates)))) {
				const auto clamp = [](double coordinate) {
					if (coordinate > static_cast<double>(std::numeric_limits<int>::max())) {
						return std::numeric_limits<int>::max();
					}
					if (coordinate < static_cast<double>(std::numeric_limits<int>::min())) {
						return std::numeric_limits<int>::min();
					}
					return static_cast<int>(std::lround(coordinate));
				};
				bounds = PixelRect
				{
					clamp(coordinates[0]),
					clamp(coordinates[1]),
					clamp(coordinates[2]),
					clamp(coordinates[3]),
				};
				SafeArrayUnaccessData(value.parray);
			}
		}
	}
	VariantClear(&value);
	return bounds;
}

template <typename T>
bool CachedPattern(IUIAutomationElement* element, PATTERNID pattern, ComPtr<T>& output) {
	void* value = nullptr;
	const HRESULT result = element->GetCachedPatternAs(pattern, __uuidof(T), &value);
	if (FAILED(result) || value == nullptr) {
		return false;
	}
	output.Attach(static_cast<T*>(value));
	return true;
}

template <typename T>
bool CurrentPattern(IUIAutomationElement* element, PATTERNID pattern, ComPtr<T>& output) {
	void* value = nullptr;
	const HRESULT result = element->GetCurrentPatternAs(pattern, __uuidof(T), &value);
	if (FAILED(result) || value == nullptr) {
		return false;
	}
	output.Attach(static_cast<T*>(value));
	return true;
}

std::string ControlTypeName(long type) {
	switch (type) {
	case UIA_ButtonControlTypeId:
		return "button";
	case UIA_CalendarControlTypeId:
		return "calendar";
	case UIA_CheckBoxControlTypeId:
		return "checkBox";
	case UIA_ComboBoxControlTypeId:
		return "comboBox";
	case UIA_CustomControlTypeId:
		return "custom";
	case UIA_DataGridControlTypeId:
		return "dataGrid";
	case UIA_DataItemControlTypeId:
		return "dataItem";
	case UIA_DocumentControlTypeId:
		return "document";
	case UIA_EditControlTypeId:
		return "edit";
	case UIA_GroupControlTypeId:
		return "group";
	case UIA_HeaderControlTypeId:
		return "header";
	case UIA_HeaderItemControlTypeId:
		return "headerItem";
	case UIA_HyperlinkControlTypeId:
		return "hyperlink";
	case UIA_ImageControlTypeId:
		return "image";
	case UIA_ListControlTypeId:
		return "list";
	case UIA_ListItemControlTypeId:
		return "listItem";
	case UIA_MenuControlTypeId:
		return "menu";
	case UIA_MenuBarControlTypeId:
		return "menuBar";
	case UIA_MenuItemControlTypeId:
		return "menuItem";
	case UIA_PaneControlTypeId:
		return "pane";
	case UIA_ProgressBarControlTypeId:
		return "progressBar";
	case UIA_RadioButtonControlTypeId:
		return "radioButton";
	case UIA_ScrollBarControlTypeId:
		return "scrollBar";
	case UIA_SeparatorControlTypeId:
		return "separator";
	case UIA_SliderControlTypeId:
		return "slider";
	case UIA_SpinnerControlTypeId:
		return "spinner";
	case UIA_SplitButtonControlTypeId:
		return "splitButton";
	case UIA_StatusBarControlTypeId:
		return "statusBar";
	case UIA_TabControlTypeId:
		return "tab";
	case UIA_TabItemControlTypeId:
		return "tabItem";
	case UIA_TableControlTypeId:
		return "table";
	case UIA_TextControlTypeId:
		return "text";
	case UIA_ThumbControlTypeId:
		return "thumb";
	case UIA_TitleBarControlTypeId:
		return "titleBar";
	case UIA_ToolBarControlTypeId:
		return "toolBar";
	case UIA_ToolTipControlTypeId:
		return "toolTip";
	case UIA_TreeControlTypeId:
		return "tree";
	case UIA_TreeItemControlTypeId:
		return "treeItem";
	case UIA_WindowControlTypeId:
		return "window";
	default:
		return "unknown";
	}
}

std::string RoleForControl(std::string_view type) {
	if (type == "button" || type == "splitButton") {
		return "button";
	}
	if (type == "checkBox") {
		return "checkbox";
	}
	if (type == "comboBox") {
		return "combobox";
	}
	if (type == "edit") {
		return "field";
	}
	if (type == "hyperlink") {
		return "link";
	}
	if (type == "radioButton") {
		return "radio";
	}
	if (type == "scrollBar") {
		return "scrollbar";
	}
	if (type == "progressBar") {
		return "progress";
	}
	if (type == "window") {
		return "window";
	}
	if (type == "pane" || type == "group" || type == "custom" || type == "document") {
		return "container";
	}
	return std::string(type == "unknown" ? "unknown" : type);
}

struct Node {
	ComPtr<IUIAutomationElement> element;
	Node* parent = nullptr;
	int child_index = 0;
	std::string control_type = "unknown";
	std::string role = "unknown";
	std::optional<PixelRect> bounds;
	std::optional<std::wstring> name;
	std::optional<std::wstring> automation_id;
	std::optional<std::wstring> class_name;
	std::optional<std::wstring> framework_id;
	std::optional<bool> enabled;
	std::optional<bool> offscreen;
	std::optional<bool> focusable;
	std::optional<bool> focused;
	std::optional<bool> password;
	std::optional<std::wstring> value;
	std::optional<std::wstring> state;
	bool invoke = false;
	bool set_value = false;
	bool select = false;
	bool toggle = false;
	bool expand = false;
	bool collapse = false;
	bool scroll = false;
	bool focus = false;
	bool horizontal_scroll = false;
	bool vertical_scroll = false;
	std::vector<std::unique_ptr<Node>> children;
};

struct Tree {
	Limits limits;
	std::unique_ptr<Node> root;
	bool truncated = false;
	bool timed_out = false;
	int node_count = 0;
	int elapsed_milliseconds = 0;
	std::string detail;
};

struct TreeBuilder {
	IUIAutomation* automation = nullptr;
	IUIAutomationCacheRequest* cache = nullptr;
	IUIAutomationCondition* true_condition = nullptr;
	Tree* tree = nullptr;
	std::chrono::steady_clock::time_point deadline;

	bool Expired() {
		if (std::chrono::steady_clock::now() < deadline) {
			return false;
		}
		tree->timed_out = true;
		tree->truncated = true;
		return true;
	}
};

void PopulateNode(Node& node, bool* truncated) {
	node.name = CachedString(node.element.Get(), UIA_NamePropertyId, truncated);
	node.automation_id = CachedString(node.element.Get(), UIA_AutomationIdPropertyId, truncated);
	node.class_name = CachedString(node.element.Get(), UIA_ClassNamePropertyId, truncated);
	node.framework_id = CachedString(node.element.Get(), UIA_FrameworkIdPropertyId, truncated);
	node.enabled = CachedBoolean(node.element.Get(), UIA_IsEnabledPropertyId);
	node.offscreen = CachedBoolean(node.element.Get(), UIA_IsOffscreenPropertyId);
	node.focusable = CachedBoolean(node.element.Get(), UIA_IsKeyboardFocusablePropertyId);
	node.focused = CachedBoolean(node.element.Get(), UIA_HasKeyboardFocusPropertyId);
	node.password = CachedBoolean(node.element.Get(), UIA_IsPasswordPropertyId);
	node.bounds = CachedBounds(node.element.Get());
	node.control_type = ControlTypeName(
		CachedInteger(node.element.Get(), UIA_ControlTypePropertyId).value_or(0));
	node.role = RoleForControl(node.control_type);

	ComPtr<IUIAutomationInvokePattern> invoke;
	node.invoke = CachedPattern(node.element.Get(), UIA_InvokePatternId, invoke);
	ComPtr<IUIAutomationValuePattern> value;
	const bool has_value = CachedPattern(node.element.Get(), UIA_ValuePatternId, value);
	const bool non_password = node.password.has_value() && !*node.password;
	node.set_value = has_value && non_password;
	ComPtr<IUIAutomationSelectionItemPattern> selection;
	node.select = CachedPattern(node.element.Get(), UIA_SelectionItemPatternId, selection);
	ComPtr<IUIAutomationTogglePattern> toggle;
	node.toggle = CachedPattern(node.element.Get(), UIA_TogglePatternId, toggle);
	ComPtr<IUIAutomationExpandCollapsePattern> expand;
	const bool has_expand = CachedPattern(
		node.element.Get(), UIA_ExpandCollapsePatternId, expand);
	node.expand = has_expand;
	node.collapse = has_expand;
	ComPtr<IUIAutomationScrollPattern> scroll;
	const bool has_scroll = CachedPattern(node.element.Get(), UIA_ScrollPatternId, scroll);
	node.horizontal_scroll = CachedBoolean(
		node.element.Get(), UIA_ScrollHorizontallyScrollablePropertyId).value_or(false);
	node.vertical_scroll = CachedBoolean(
		node.element.Get(), UIA_ScrollVerticallyScrollablePropertyId).value_or(false);
	node.scroll = has_scroll && (node.horizontal_scroll || node.vertical_scroll);
	node.focus = node.enabled.value_or(false) && node.focusable.value_or(false);

	if (non_password && has_value) {
		BSTR current = nullptr;
		if (SUCCEEDED(value->get_CurrentValue(&current)) && current != nullptr) {
			node.value = LimitText(current, truncated);
			SysFreeString(current);
		}
	}

	const std::optional<long> toggle_state =
		CachedInteger(node.element.Get(), UIA_ToggleToggleStatePropertyId);
	if (toggle_state.has_value()) {
		switch (*toggle_state) {
		case ToggleState_On:
			node.state = L"on";
			break;
		case ToggleState_Off:
			node.state = L"off";
			break;
		default:
			node.state = L"indeterminate";
			break;
		}
	} else if (const std::optional<long> expand_state =
			CachedInteger(node.element.Get(), UIA_ExpandCollapseExpandCollapseStatePropertyId);
		expand_state.has_value()) {
		switch (*expand_state) {
		case ExpandCollapseState_Expanded:
			node.state = L"expanded";
			break;
		case ExpandCollapseState_Collapsed:
			node.state = L"collapsed";
			break;
		case ExpandCollapseState_PartiallyExpanded:
			node.state = L"partiallyExpanded";
			break;
		default:
			node.state = L"leaf";
			break;
		}
	} else if (const std::optional<bool> selected =
			CachedBoolean(node.element.Get(), UIA_SelectionItemIsSelectedPropertyId);
		selected.has_value()) {
		node.state = *selected ? L"selected" : L"unselected";
	}
}

std::unique_ptr<Node> BuildNode(
	TreeBuilder& builder,
	IUIAutomationElement* element,
	Node* parent,
	int child_index,
	int depth) {
	auto node = std::make_unique<Node>();
	element->AddRef();
	node->element.Attach(element);
	node->parent = parent;
	node->child_index = child_index;
	PopulateNode(*node, &builder.tree->truncated);
	++builder.tree->node_count;

	if (builder.Expired()) {
		return node;
	}

	ComPtr<IUIAutomationElementArray> children;
	const HRESULT found = element->FindAllBuildCache(
		TreeScope_Children,
		builder.true_condition,
		builder.cache,
		children.Put());
	if (FAILED(found) || !children) {
		// An inaccessible owner-drawn provider may expose a root and nothing below it. That sparse
		// answer is useful and honest, unlike treating it as an empty successful standard-control tree.
		if (builder.tree->detail.empty()) {
			builder.tree->detail =
				"Some UI Automation descendants were unavailable from the provider.";
		}
		return node;
	}

	int length = 0;
	if (FAILED(children->get_Length(&length)) || length <= 0) {
		return node;
	}
	if (depth >= builder.tree->limits.maximum_depth ||
		builder.tree->node_count >= builder.tree->limits.maximum_nodes) {
		builder.tree->truncated = true;
		return node;
	}

	for (int index = 0; index < length; ++index) {
		if (builder.tree->node_count >= builder.tree->limits.maximum_nodes) {
			builder.tree->truncated = true;
			break;
		}
		if (builder.Expired()) {
			break;
		}
		ComPtr<IUIAutomationElement> child;
		if (FAILED(children->GetElement(index, child.Put())) || !child) {
			continue;
		}
		node->children.push_back(BuildNode(
			builder,
			child.Get(),
			node.get(),
			index,
			depth + 1));
	}
	return node;
}

void AddCachedProperties(IUIAutomationCacheRequest* cache) {
	static constexpr PROPERTYID properties[] =
	{
		UIA_NamePropertyId,
		UIA_AutomationIdPropertyId,
		UIA_ClassNamePropertyId,
		UIA_FrameworkIdPropertyId,
		UIA_IsEnabledPropertyId,
		UIA_IsOffscreenPropertyId,
		UIA_IsKeyboardFocusablePropertyId,
		UIA_HasKeyboardFocusPropertyId,
		UIA_IsPasswordPropertyId,
		UIA_ControlTypePropertyId,
		UIA_BoundingRectanglePropertyId,
		UIA_ToggleToggleStatePropertyId,
		UIA_ExpandCollapseExpandCollapseStatePropertyId,
		UIA_SelectionItemIsSelectedPropertyId,
		UIA_ScrollHorizontallyScrollablePropertyId,
		UIA_ScrollVerticallyScrollablePropertyId,
	};
	for (const PROPERTYID property : properties) {
		(void)cache->AddProperty(property);
	}
	static constexpr PATTERNID patterns[] =
	{
		UIA_InvokePatternId,
		UIA_ValuePatternId,
		UIA_SelectionItemPatternId,
		UIA_TogglePatternId,
		UIA_ExpandCollapsePatternId,
		UIA_ScrollPatternId,
	};
	for (const PATTERNID pattern : patterns) {
		(void)cache->AddPattern(pattern);
	}
}

Tree BuildTree(uintptr_t handle, const Limits& limits) {
	const auto started = std::chrono::steady_clock::now();
	Tree tree;
	tree.limits = limits;
	if (!IsWindow(reinterpret_cast<HWND>(handle))) {
		tree.detail = "The window no longer exists.";
		return tree;
	}

	ComPtr<IUIAutomation> automation;
	HRESULT created = CoCreateInstance(
		CLSID_CUIAutomation8,
		nullptr,
		CLSCTX_INPROC_SERVER,
		__uuidof(IUIAutomation),
		reinterpret_cast<void**>(automation.Put()));
	if (FAILED(created)) {
		created = CoCreateInstance(
			CLSID_CUIAutomation,
			nullptr,
			CLSCTX_INPROC_SERVER,
			__uuidof(IUIAutomation),
			reinterpret_cast<void**>(automation.Put()));
	}
	if (FAILED(created)) {
		throw FatalError(
			"uia_unavailable",
			"Could not create the Windows UI Automation client.",
			created);
	}
	ComPtr<IUIAutomation2> automation2;
	if (SUCCEEDED(automation->QueryInterface(
			__uuidof(IUIAutomation2),
			reinterpret_cast<void**>(automation2.Put())))) {
		(void)automation2->put_ConnectionTimeout(limits.timeout_milliseconds);
		(void)automation2->put_TransactionTimeout(limits.timeout_milliseconds);
	}

	ComPtr<IUIAutomationElement> raw_root;
	const HRESULT root_result = automation->ElementFromHandle(
		reinterpret_cast<HWND>(handle),
		raw_root.Put());
	if (FAILED(root_result) || !raw_root) {
		tree.detail = "UI Automation did not expose a root element for this window.";
		return tree;
	}

	ComPtr<IUIAutomationCacheRequest> cache;
	const HRESULT cache_result = automation->CreateCacheRequest(cache.Put());
	if (FAILED(cache_result) || !cache) {
		throw FatalError(
			"uia_cache_request_failed",
			"Could not create a UI Automation cache request.",
			cache_result);
	}
	(void)cache->put_TreeScope(TreeScope_Element);
	AddCachedProperties(cache.Get());

	ComPtr<IUIAutomationCondition> true_condition;
	const HRESULT condition_result = automation->CreateTrueCondition(true_condition.Put());
	if (FAILED(condition_result) || !true_condition) {
		throw FatalError(
			"uia_condition_failed",
			"Could not create the UI Automation tree condition.",
			condition_result);
	}

	ComPtr<IUIAutomationElement> cached_root;
	const HRESULT cached_result = raw_root->BuildUpdatedCache(cache.Get(), cached_root.Put());
	IUIAutomationElement* root = SUCCEEDED(cached_result) && cached_root
		? cached_root.Get()
		: raw_root.Get();
	if (FAILED(cached_result)) {
		tree.detail = "The provider exposed only a sparse root; cached descendants were unavailable.";
	}

	TreeBuilder builder
	{
		automation.Get(),
		cache.Get(),
		true_condition.Get(),
		&tree,
		started + std::chrono::milliseconds(limits.timeout_milliseconds),
	};
	tree.root = BuildNode(builder, root, nullptr, 0, 0);
	tree.elapsed_milliseconds = static_cast<int>(std::min<std::int64_t>(
		std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now() - started).count(),
		std::numeric_limits<int>::max()));
	if (tree.timed_out) {
		tree.detail = "UI Automation traversal reached its timeout.";
	}
	return tree;
}

bool MatchesAtom(const Node& node, const SelectorAtom& selector) {
	if (selector.automation_id.has_value() &&
		(!node.automation_id.has_value() ||
			!EqualNoCase(*node.automation_id, *selector.automation_id))) {
		return false;
	}
	if (selector.control_type.has_value() &&
		!EqualNoCase(
			std::wstring(node.control_type.begin(), node.control_type.end()),
			*selector.control_type)) {
		return false;
	}
	if (selector.role.has_value() &&
		!EqualNoCase(
			std::wstring(node.role.begin(), node.role.end()),
			*selector.role)) {
		return false;
	}
	if (!MatchesText(node.name.value_or(L""), selector.name, selector.exact)) {
		return false;
	}
	return true;
}

bool MatchesType(const Node& node, const SelectorAtom& selector) {
	if (selector.control_type.has_value() &&
		!EqualNoCase(
			std::wstring(node.control_type.begin(), node.control_type.end()),
			*selector.control_type)) {
		return false;
	}
	if (selector.role.has_value() &&
		!EqualNoCase(
			std::wstring(node.role.begin(), node.role.end()),
			*selector.role)) {
		return false;
	}
	return true;
}

bool MatchesSelector(const Node& node, const Selector& selector) {
	const SelectorStrategy strategy = StrategyFor(selector);
	if (strategy == SelectorStrategy::AutomationIdAndControlType) {
		return node.automation_id.has_value() &&
			EqualNoCase(*node.automation_id, *selector.automation_id) &&
			MatchesType(node, selector);
	}
	if (strategy == SelectorStrategy::ControlTypeAndNameOrValue) {
		return MatchesType(node, selector) &&
			MatchesText(node.name.value_or(L""), selector.name, selector.exact) &&
			(!selector.value.has_value() ||
				(node.password == false &&
					MatchesText(node.value.value_or(L""), selector.value, selector.exact)));
	}

	if (!MatchesAtom(node, selector) ||
		(selector.value.has_value() &&
			(node.password != false ||
				!MatchesText(node.value.value_or(L""), selector.value, selector.exact)))) {
		return false;
	}
	if (!selector.ancestors.empty()) {
		const Node* current = node.parent;
		for (auto iterator = selector.ancestors.rbegin();
			iterator != selector.ancestors.rend();
			++iterator) {
			if (current == nullptr || !MatchesAtom(*current, *iterator)) {
				return false;
			}
			current = current->parent;
		}
	}
	return true;
}

void CollectMatches(const Node* node, const Selector& selector, std::vector<Node*>& matches) {
	if (node == nullptr) {
		return;
	}
	if (MatchesSelector(*node, selector)) {
		matches.push_back(const_cast<Node*>(node));
	}
	for (const auto& child : node->children) {
		CollectMatches(child.get(), selector, matches);
	}
}

std::vector<Node*> FindMatches(Tree& tree, const Selector& selector) {
	std::vector<Node*> matches;
	if (!tree.root) {
		return matches;
	}
	const SelectorStrategy strategy = StrategyFor(selector);
	if (strategy == SelectorStrategy::QualifiedFallback && !selector.path.empty()) {
		Node* current = tree.root.get();
		for (const int index : selector.path) {
			if (index < 0 || static_cast<size_t>(index) >= current->children.size()) {
				return matches;
			}
			current = current->children[static_cast<size_t>(index)].get();
		}
		if (MatchesSelector(*current, selector)) {
			matches.push_back(current);
		}
	} else {
		CollectMatches(tree.root.get(), selector, matches);
	}
	if (strategy == SelectorStrategy::QualifiedFallback && selector.index.has_value()) {
		if (static_cast<size_t>(*selector.index) >= matches.size()) {
			return {};
		}
		return { matches[static_cast<size_t>(*selector.index)] };
	}
	return matches;
}

void OptionalWide(JsonObject& object, std::string_view name, const std::optional<std::wstring>& value) {
	if (value.has_value()) {
		object.String(name, Utf8(*value));
	}
}

void OptionalBoolean(JsonObject& object, std::string_view name, const std::optional<bool>& value) {
	if (value.has_value()) {
		object.Boolean(name, *value);
	}
}

std::string RectJson(const PixelRect& rect) {
	JsonObject result;
	result.Signed("left", rect.left);
	result.Signed("top", rect.top);
	result.Signed("width", rect.width);
	result.Signed("height", rect.height);
	return result.Finish();
}

std::string PropertiesJson(const Node& node) {
	JsonObject result;
	OptionalWide(result, "name", node.name);
	OptionalWide(result, "automationId", node.automation_id);
	OptionalWide(result, "className", node.class_name);
	OptionalWide(result, "frameworkId", node.framework_id);
	OptionalBoolean(result, "enabled", node.enabled);
	OptionalBoolean(result, "offscreen", node.offscreen);
	OptionalBoolean(result, "focusable", node.focusable);
	OptionalBoolean(result, "focused", node.focused);
	OptionalBoolean(result, "password", node.password);
	if (node.password == false) {
		OptionalWide(result, "value", node.value);
	}
	OptionalWide(result, "state", node.state);
	return result.Finish();
}

std::string SupportedActionsJson(const Node& node) {
	JsonObject result;
	result.Boolean("invoke", node.invoke);
	result.Boolean("setValue", node.set_value);
	result.Boolean("select", node.select);
	result.Boolean("toggle", node.toggle);
	result.Boolean("expand", node.expand);
	result.Boolean("collapse", node.collapse);
	result.Boolean("scroll", node.scroll);
	result.Boolean("focus", node.focus);
	return result.Finish();
}

std::string ElementJson(const Node& node, bool include_children) {
	JsonObject result;
	result.String("controlType", node.control_type);
	result.String("role", node.role);
	if (node.bounds.has_value()) {
		result.Raw("bounds", RectJson(*node.bounds));
	}
	result.Raw("properties", PropertiesJson(node));
	result.Raw("supportedActions", SupportedActionsJson(node));
	JsonArray children;
	if (include_children) {
		for (const auto& child : node.children) {
			children.Raw(ElementJson(*child, true));
		}
	}
	result.Raw("children", children.Finish());
	return result.Finish();
}

std::string MetadataJson(const Tree& tree) {
	JsonObject result;
	result.Boolean("truncated", tree.truncated);
	result.Boolean("timedOut", tree.timed_out);
	result.Number("nodeCount", static_cast<std::uint64_t>(tree.node_count));
	result.Number("maximumDepth", static_cast<std::uint64_t>(tree.limits.maximum_depth));
	result.Number("maximumNodes", static_cast<std::uint64_t>(tree.limits.maximum_nodes));
	result.Number(
		"elapsedMilliseconds",
		static_cast<std::uint64_t>(std::max(tree.elapsed_milliseconds, 0)));
	if (!tree.detail.empty()) {
		result.String("detail", tree.detail);
	}
	return result.Finish();
}

std::string SelectorJson(const Selector& selector) {
	JsonObject result;
	OptionalWide(result, "automationId", selector.automation_id);
	OptionalWide(result, "controlType", selector.control_type);
	OptionalWide(result, "role", selector.role);
	OptionalWide(result, "name", selector.name);
	OptionalWide(result, "value", selector.value);
	result.Boolean("exact", selector.exact);
	if (!selector.ancestors.empty()) {
		JsonArray ancestors;
		for (const auto& ancestor : selector.ancestors) {
			JsonObject atom;
			OptionalWide(atom, "automationId", ancestor.automation_id);
			OptionalWide(atom, "controlType", ancestor.control_type);
			OptionalWide(atom, "role", ancestor.role);
			OptionalWide(atom, "name", ancestor.name);
			atom.Boolean("exact", ancestor.exact);
			ancestors.Raw(atom.Finish());
		}
		result.Raw("ancestors", ancestors.Finish());
	}
	if (!selector.path.empty()) {
		JsonArray path;
		for (const int index : selector.path) {
			path.Raw(std::to_string(index));
		}
		result.Raw("path", path.Finish());
	}
	if (selector.index.has_value()) {
		result.Signed("index", *selector.index);
	}
	return result.Finish();
}

Selector DerivedSelector(const Node& node) {
	Selector result;
	if (node.automation_id.has_value() && node.control_type != "unknown") {
		result.automation_id = node.automation_id;
		result.control_type = std::wstring(node.control_type.begin(), node.control_type.end());
		return result;
	}
	if (node.control_type != "unknown" && node.password == false && node.name.has_value()) {
		result.control_type = std::wstring(node.control_type.begin(), node.control_type.end());
		result.name = node.name;
		return result;
	}
	std::vector<int> reverse_path;
	for (const Node* current = &node; current->parent != nullptr; current = current->parent) {
		reverse_path.push_back(current->child_index);
	}
	std::reverse(reverse_path.begin(), reverse_path.end());
	result.path = std::move(reverse_path);
	if (result.path.empty()) {
		// The root has no child path. An explicit ordinal preserves the invariant that a derived
		// selector never means "pick the first match" when it has no semantic fields.
		result.index = 0;
	}
	return result;
}

std::string MatchJson(const Node& node) {
	JsonObject result;
	result.Raw("element", ElementJson(node, false));
	result.Raw("selector", SelectorJson(DerivedSelector(node)));
	return result.Finish();
}

std::string SnapshotJson(const Tree& tree) {
	JsonObject result;
	result.String("schemaVersion", "1.0");
	if (tree.root) {
		result.Raw("root", ElementJson(*tree.root, true));
	}
	result.Raw("metadata", MetadataJson(tree));
	return result.Finish();
}

std::string FindJson(const Tree& tree, const std::vector<Node*>& matches, int total_matches) {
	JsonArray output;
	for (const Node* match : matches) {
		output.Raw(MatchJson(*match));
	}
	JsonObject result;
	result.String("schemaVersion", "1.0");
	result.Raw("matches", output.Finish());
	result.Number("totalMatches", static_cast<std::uint64_t>(total_matches));
	result.Raw("metadata", MetadataJson(tree));
	return result.Finish();
}

std::string ActionJson(
	const Tree& tree,
	std::string_view action,
	bool success,
	std::string_view code,
	std::string_view detail,
	const Node* match,
	std::optional<int> value_length) {
	JsonObject result;
	result.String("schemaVersion", "1.0");
	result.Boolean("success", success);
	result.String("action", action);
	if (!code.empty()) {
		result.String("code", code);
	}
	if (!detail.empty()) {
		result.String("detail", detail);
	}
	if (match != nullptr) {
		result.Raw("match", MatchJson(*match));
	}
	if (value_length.has_value()) {
		result.Signed("valueLength", *value_length);
	}
	result.Raw("metadata", MetadataJson(tree));
	return result.Finish();
}

std::string WaitJson(
	const Tree& tree,
	std::string_view condition,
	bool satisfied,
	std::string_view code,
	std::string_view detail,
	const Node* match) {
	JsonObject result;
	result.String("schemaVersion", "1.0");
	result.Boolean("satisfied", satisfied);
	result.String("condition", condition);
	if (!code.empty()) {
		result.String("code", code);
	}
	if (!detail.empty()) {
		result.String("detail", detail);
	}
	if (match != nullptr) {
		result.Raw("match", MatchJson(*match));
	}
	result.Raw("metadata", MetadataJson(tree));
	return result.Finish();
}

std::string Envelope(std::string_view result) {
	JsonObject root;
	root.Number("schemaVersion", 1);
	root.Boolean("ok", true);
	root.String("helperVersion", Utf8(MOBILE_CANVAS_HELPER_VERSION));
	root.Raw("result", result);
	return root.Finish();
}

std::string SnapshotTimeoutEnvelope(const Limits& limits) {
	Tree tree;
	tree.limits = limits;
	tree.timed_out = true;
	tree.detail = "UI Automation traversal reached its timeout.";
	return Envelope(SnapshotJson(tree));
}

std::string FindTimeoutEnvelope(const Limits& limits) {
	Tree tree;
	tree.limits = limits;
	tree.timed_out = true;
	tree.detail = "UI Automation query reached its timeout.";
	return Envelope(FindJson(tree, {}, 0));
}

std::string ActionTimeoutEnvelope(const Limits& limits, std::string_view action) {
	Tree tree;
	tree.limits = limits;
	tree.timed_out = true;
	tree.detail = "UI Automation action reached its timeout.";
	return Envelope(ActionJson(tree, action, false, kUiTimeout, tree.detail, nullptr, std::nullopt));
}

std::string WaitTimeoutEnvelope(const Limits& limits, std::string_view condition) {
	Tree tree;
	tree.limits = limits;
	tree.timed_out = true;
	tree.detail = "UI Automation wait reached its timeout.";
	return Envelope(WaitJson(tree, condition, false, kUiTimeout, tree.detail, nullptr));
}

template <typename Operation>
std::string RunOnMta(
	int timeout_milliseconds,
	Operation operation,
	std::string timeout_response) {
	struct State {
		std::mutex mutex;
		std::condition_variable completed;
		bool done = false;
		std::string response;
		std::exception_ptr exception;
	};

	auto state = std::make_shared<State>();
	std::thread worker(
		[state, operation = std::move(operation)]() mutable {
			try {
				Apartment apartment;
				std::string response = operation();
				{
					std::lock_guard<std::mutex> lock(state->mutex);
					state->response = std::move(response);
					state->done = true;
				}
			} catch (...) {
				{
					std::lock_guard<std::mutex> lock(state->mutex);
					state->exception = std::current_exception();
					state->done = true;
				}
			}
			state->completed.notify_one();
		});

	std::unique_lock<std::mutex> lock(state->mutex);
	const auto budget = std::chrono::milliseconds(timeout_milliseconds + 250);
	if (!state->completed.wait_for(lock, budget, [&]() { return state->done; })) {
		// UIA calls can block inside a provider. The executable is intentionally short lived, so
		// detaching this MTA worker and returning lets process exit terminate that blocked call; the
		// managed bridge also kills the helper at its outer hard deadline.
		lock.unlock();
		worker.detach();
		return timeout_response;
	}
	lock.unlock();
	worker.join();
	if (state->exception) {
		std::rethrow_exception(state->exception);
	}
	return state->response;
}

std::string RunSnapshot(const SnapshotRequest& request) {
	return RunOnMta(
		request.limits.timeout_milliseconds,
		[request]() {
			return Envelope(SnapshotJson(BuildTree(request.handle, request.limits)));
		},
		SnapshotTimeoutEnvelope(request.limits));
}

std::string RunFind(const QueryRequest& request) {
	return RunOnMta(
		request.limits.timeout_milliseconds,
		[request]() {
			Tree tree = BuildTree(request.handle, request.limits);
			std::vector<Node*> all = FindMatches(tree, request.selector);
			const int total = static_cast<int>(std::min<size_t>(
				all.size(),
				static_cast<size_t>(std::numeric_limits<int>::max())));
			if (all.size() > static_cast<size_t>(request.limit)) {
				all.resize(static_cast<size_t>(request.limit));
				tree.truncated = true;
			}
			return Envelope(FindJson(tree, all, total));
		},
		FindTimeoutEnvelope(request.limits));
}

std::string ActionCapability(
	const Tree& tree,
	const ActionRequest& request,
	const Node* match,
	std::string_view detail) {
	return Envelope(ActionJson(
		tree,
		request.action,
		false,
		kUiCapabilityUnavailable,
		detail,
		match,
		request.action == "setValue" && request.value.has_value()
			? std::optional<int>(static_cast<int>(request.value->size()))
			: std::nullopt));
}

std::string RunAction(const ActionRequest& request) {
	return RunOnMta(
		request.limits.timeout_milliseconds,
		[request]() {
			Tree tree = BuildTree(request.handle, request.limits);
			if (tree.timed_out) {
				return Envelope(ActionJson(
					tree,
					request.action,
					false,
					kUiTimeout,
					tree.detail,
					nullptr,
					std::nullopt));
			}
			std::vector<Node*> matches = FindMatches(tree, request.selector);
			if (matches.empty()) {
				return Envelope(ActionJson(
					tree,
					request.action,
					false,
					kUiElementNotFound,
					"No current UI Automation element matches the selector.",
					nullptr,
					std::nullopt));
			}
			if (matches.size() > 1) {
				return Envelope(ActionJson(
					tree,
					request.action,
					false,
					kUiElementAmbiguous,
					"The selector matches more than one current UI Automation element.",
					nullptr,
					std::nullopt));
			}

			Node* target = matches[0];
			HRESULT result = E_FAIL;
			if (request.action == "invoke") {
				ComPtr<IUIAutomationInvokePattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_InvokePatternId, pattern)) {
					return ActionCapability(tree, request, target, "Invoke is not supported by this control.");
				}
				result = pattern->Invoke();
			} else if (request.action == "setValue") {
				if (target->password != false) {
					return Envelope(ActionJson(
						tree,
						request.action,
						false,
						kUiPasswordValueForbidden,
						"SetValue is never available for a password control.",
						target,
						static_cast<int>(request.value->size())));
				}
				ComPtr<IUIAutomationValuePattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_ValuePatternId, pattern)) {
					return ActionCapability(tree, request, target, "SetValue is not supported by this control.");
				}
				BSTR value = SysAllocStringLen(
					request.value->data(),
					static_cast<UINT>(request.value->size()));
				if (value == nullptr && !request.value->empty()) {
					result = E_OUTOFMEMORY;
				} else {
					result = pattern->SetValue(value);
					SysFreeString(value);
				}
			} else if (request.action == "select") {
				ComPtr<IUIAutomationSelectionItemPattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_SelectionItemPatternId, pattern)) {
					return ActionCapability(tree, request, target, "Select is not supported by this control.");
				}
				result = pattern->Select();
			} else if (request.action == "toggle") {
				ComPtr<IUIAutomationTogglePattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_TogglePatternId, pattern)) {
					return ActionCapability(tree, request, target, "Toggle is not supported by this control.");
				}
				result = pattern->Toggle();
			} else if (request.action == "expand" || request.action == "collapse") {
				ComPtr<IUIAutomationExpandCollapsePattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_ExpandCollapsePatternId, pattern)) {
					return ActionCapability(
						tree,
						request,
						target,
						"Expand/collapse is not supported by this control.");
				}
				result = request.action == "expand" ? pattern->Expand() : pattern->Collapse();
			} else if (request.action == "scroll") {
				ComPtr<IUIAutomationScrollPattern> pattern;
				if (!CurrentPattern(target->element.Get(), UIA_ScrollPatternId, pattern)) {
					return ActionCapability(tree, request, target, "Scroll is not supported by this control.");
				}
				const ScrollAmount amount = request.scroll->amount == "large"
					? ScrollAmount_LargeIncrement
					: ScrollAmount_SmallIncrement;
				ScrollAmount horizontal = ScrollAmount_NoAmount;
				ScrollAmount vertical = ScrollAmount_NoAmount;
				if (request.scroll->direction == "left") {
					horizontal = request.scroll->amount == "large"
						? ScrollAmount_LargeDecrement
						: ScrollAmount_SmallDecrement;
				} else if (request.scroll->direction == "right") {
					horizontal = amount;
				} else if (request.scroll->direction == "up") {
					vertical = request.scroll->amount == "large"
						? ScrollAmount_LargeDecrement
						: ScrollAmount_SmallDecrement;
				} else {
					vertical = amount;
				}
				if ((horizontal != ScrollAmount_NoAmount && !target->horizontal_scroll) ||
					(vertical != ScrollAmount_NoAmount && !target->vertical_scroll)) {
					return ActionCapability(
						tree,
						request,
						target,
						"Scroll is not available in that direction for this control.");
				}
				result = pattern->Scroll(horizontal, vertical);
			} else {
				if (!target->focus) {
					return ActionCapability(tree, request, target, "Focus is not supported by this control.");
				}
				result = target->element->SetFocus();
			}

			const std::optional<int> value_length = request.action == "setValue" &&
					request.value.has_value()
				? std::optional<int>(static_cast<int>(request.value->size()))
				: std::nullopt;
			if (FAILED(result)) {
				return Envelope(ActionJson(
					tree,
					request.action,
					false,
					kUiActionFailed,
					"The UI Automation provider refused the requested action.",
					target,
					value_length));
			}
			return Envelope(ActionJson(
				tree,
				request.action,
				true,
				"",
				"",
				target,
				value_length));
		},
		ActionTimeoutEnvelope(request.limits, request.action));
}

std::optional<std::wstring> PropertyValue(const Node& node, std::string_view property) {
	if (property == "name") {
		return node.name;
	}
	if (property == "enabled") {
		return node.enabled.has_value()
			? std::optional<std::wstring>(*node.enabled ? L"true" : L"false")
			: std::nullopt;
	}
	if (property == "offscreen") {
		return node.offscreen.has_value()
			? std::optional<std::wstring>(*node.offscreen ? L"true" : L"false")
			: std::nullopt;
	}
	if (property == "focusable") {
		return node.focusable.has_value()
			? std::optional<std::wstring>(*node.focusable ? L"true" : L"false")
			: std::nullopt;
	}
	if (property == "focused") {
		return node.focused.has_value()
			? std::optional<std::wstring>(*node.focused ? L"true" : L"false")
			: std::nullopt;
	}
	if (property == "value" && node.password == false) {
		return node.value;
	}
	return std::nullopt;
}

std::string RunWait(const WaitRequest& request) {
	return RunOnMta(
		request.limits.timeout_milliseconds,
		[request]() {
			const auto started = std::chrono::steady_clock::now();
			const auto deadline = started +
				std::chrono::milliseconds(request.limits.timeout_milliseconds);
			for (;;) {
				Tree tree = BuildTree(request.handle, request.limits);
				tree.elapsed_milliseconds = static_cast<int>(std::min<std::int64_t>(
					std::chrono::duration_cast<std::chrono::milliseconds>(
						std::chrono::steady_clock::now() - started).count(),
					std::numeric_limits<int>::max()));
				if (tree.timed_out) {
					return Envelope(WaitJson(
						tree,
						request.condition,
						false,
						kUiTimeout,
						tree.detail,
						nullptr));
				}
				std::vector<Node*> matches = FindMatches(tree, request.selector);
				if (request.condition == "notExists") {
					if (matches.empty()) {
						return Envelope(WaitJson(
							tree,
							request.condition,
							true,
							"",
							"",
							nullptr));
					}
				} else if (request.condition == "exists") {
					if (matches.size() > 1) {
						return Envelope(WaitJson(
							tree,
							request.condition,
							false,
							kUiElementAmbiguous,
							"The selector matches more than one current UI Automation element.",
							nullptr));
					}
					if (matches.size() == 1) {
						return Envelope(WaitJson(
							tree,
							request.condition,
							true,
							"",
							"",
							matches[0]));
					}
				} else {
					if (matches.size() > 1) {
						return Envelope(WaitJson(
							tree,
							request.condition,
							false,
							kUiElementAmbiguous,
							"The selector matches more than one current UI Automation element.",
							nullptr));
					}
					if (matches.size() == 1) {
						Node* target = matches[0];
						if (request.condition == "property" &&
							request.property == "value" && target->password != false) {
							return Envelope(WaitJson(
								tree,
								request.condition,
								false,
								kUiPasswordValueForbidden,
								"Password values are never observable by a wait.",
								target));
						}
						const std::optional<std::wstring> actual = request.condition == "state"
							? target->state
							: PropertyValue(*target, *request.property);
						if (actual.has_value() &&
							EqualNoCase(*actual, *request.expected_value)) {
							return Envelope(WaitJson(
								tree,
								request.condition,
								true,
								"",
								"",
								target));
						}
					}
				}

				if (std::chrono::steady_clock::now() >= deadline) {
					tree.timed_out = true;
					tree.elapsed_milliseconds = request.limits.timeout_milliseconds;
					tree.detail = "The requested UI Automation condition was not satisfied before timeout.";
					return Envelope(WaitJson(
						tree,
						request.condition,
						false,
						kUiTimeout,
						tree.detail,
						nullptr));
				}
				const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
					deadline - std::chrono::steady_clock::now());
				if (remaining.count() > 0) {
					std::this_thread::sleep_for(std::min(
						std::chrono::milliseconds(request.poll_milliseconds),
						remaining));
				}
			}
		},
		WaitTimeoutEnvelope(request.limits, request.condition));
}

} // namespace

std::string UiaSnapshotJson(std::string_view request_json) {
	return RunSnapshot(ParseSnapshotRequest(request_json));
}

std::string UiaFindJson(std::string_view request_json) {
	return RunFind(ParseQueryRequest(request_json));
}

std::string UiaActionJson(std::string_view request_json) {
	return RunAction(ParseActionRequest(request_json));
}

std::string UiaWaitJson(std::string_view request_json) {
	return RunWait(ParseWaitRequest(request_json));
}

} // namespace helper
