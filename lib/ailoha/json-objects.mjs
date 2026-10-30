export function parseJsonObjects(raw, maximumBytes, maximumDepth, maximumObjects) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > maximumBytes) throw new SyntaxError("JSON size");
  const objects = [];
  const stack = [];
  let start = 0;
  let separated = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (!stack.length && " \t\r\n".includes(character)) { separated = true; continue; }
    if (!stack.length) {
      if (character !== "{" || objects.length === maximumObjects || (objects.length && !separated)) throw new SyntaxError("JSON record");
      start = index;
      separated = false;
    }
    if (character === "{" || character === "[") {
      if (stack.length === maximumDepth) throw new SyntaxError("JSON depth");
      stack.push({ close: character === "{" ? "}" : "]", keys: character === "{" ? new Set() : null });
    } else if (character === "}" || character === "]") {
      if (stack.pop()?.close !== character) throw new SyntaxError("JSON container");
      if (!stack.length) objects.push(JSON.parse(raw.slice(start, index + 1)));
    } else if (character === '"') {
      const stringStart = index++;
      while (index < raw.length && raw[index] !== '"') index += raw[index] === "\\" ? 2 : 1;
      if (index >= raw.length) throw new SyntaxError("JSON string");
      let next = index + 1;
      while (next < raw.length && " \t\r\n".includes(raw[next])) next += 1;
      if (raw[next] === ":") {
        const key = JSON.parse(raw.slice(stringStart, index + 1));
        const keys = stack.at(-1)?.keys;
        if (!keys || keys.has(key)) throw new SyntaxError("JSON duplicate property");
        keys.add(key);
      }
    }
  }
  if (stack.length || !objects.length) throw new SyntaxError("JSON incomplete");
  return objects;
}
