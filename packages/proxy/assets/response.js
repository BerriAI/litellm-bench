function valueAt(value, path) {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !(segment in current)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function equal(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key)
      && equal(left[key], right[key])
    );
}

export function matchesJsonChecks(parsed, checks) {
  return checks.every((check) => {
    const actual = valueAt(parsed, check.path);
    return actual.found && equal(actual.value, check.value);
  });
}

export function parseSseData(text) {
  return text.replace(/\r\n?/g, "\n").split(/\n\n+/).filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const data = lines.filter((line) => line === "data" || line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length === 0) throw new Error("SSE frame has no data field");
      const raw = data.join("\n");
      if (raw === "[DONE]") return raw;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    });
}

export function matchesSseResponse(text, expectation) {
  try {
    const events = parseSseData(text);
    return events.length === expectation.event_count
      && (
        expectation.terminal_data === undefined
        || equal(events[events.length - 1], expectation.terminal_data)
      )
      && expectation.jsonEquals.every(({ index, path, value }) =>
        index < events.length && matchesJsonChecks(events[index], [{ path, value }])
      );
  } catch (_) {
    return false;
  }
}
