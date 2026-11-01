// Experimental, local-only save timing editor. No automated repair heuristics.
// JSON.parse is used exclusively to inspect values, never to serialize a save.
const EDITABLE_EVENT_TYPES = new Set([
  "FishSpawningInVillage", "WildCropsSpawningInVillage", "FlowerSpawningInVillage",
  "ItemSpawning", "MiningRockTurningSpecial"
]);
const SUPPORTED_SCHEMAS = new Set(["624", "626"]);
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const pointerEscape = value => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isTimestamp = value => typeof value === "string" && TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));

function classifyTime(timestamp, nowMs) {
  const year = Number(timestamp.slice(0, 4));
  if (year >= 2100) return "long-range"; // Possible sentinel, not evidence of corruption.
  if (Date.parse(timestamp) > nowMs + 365 * 86400000) return "distant-future";
  if (Date.parse(timestamp) > nowMs) return "upcoming";
  return "past";
}

export function inspectTimingFields(jsonText, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new Error("Invalid reference time.");
  const profile = JSON.parse(jsonText); // Read-only; do not JSON.stringify(profile).
  if (!isRecord(profile) || !isRecord(profile.GameInfo)) throw new Error("Invalid profile structure.");
  const schema = String(profile.GameInfo.Version ?? "");
  const canWriteSchema = SUPPORTED_SCHEMAS.has(schema);
  const events = [];
  const map = profile.World?.RecurringEvents;
  if (isRecord(map)) {
    for (const [eventKey, wrapper] of Object.entries(map)) {
      if (!isRecord(wrapper)) continue;
      const variants = Object.entries(wrapper).filter(([, value]) => isRecord(value) && "NextOccurrence" in value);
      for (const [type, value] of variants) {
        const time = value.NextOccurrence;
        const valid = isTimestamp(time);
        const classification = valid ? classifyTime(time, nowMs) : "invalid";
        const editable = canWriteSchema && variants.length === 1 && EDITABLE_EVENT_TYPES.has(type) && valid && classification !== "long-range";
        events.push({
          pointer: `/World/RecurringEvents/${pointerEscape(eventKey)}/${pointerEscape(type)}/NextOccurrence`,
          eventKey, type, itemId: value.RecurringEventItemID == null ? "" : String(value.RecurringEventItemID),
          time: valid ? time : null, classification, editable,
          reason: !canWriteSchema ? "Unsupported save schema" : variants.length !== 1 ? "Ambiguous event variant" :
            !EDITABLE_EVENT_TYPES.has(type) ? "Event is not in the spawn editing allowlist" :
            !valid ? "Invalid or absent timestamp" : classification === "long-range" ? "Long-range date: possible sentinel" : ""
        });
      }
    }
  }
  events.sort((a,b) => a.type.localeCompare(b.type) || a.eventKey.localeCompare(b.eventKey, undefined, {numeric:true}));
  const diagnostic = [];
  const add = (pointer, value) => {
    if (isTimestamp(value)) diagnostic.push({pointer, time:value, classification:classifyTime(value, nowMs)});
  };
  add("/LastDailyReset", profile.LastDailyReset);
  add("/LastWeeklyReset", profile.LastWeeklyReset);
  add("/World/NextWeatherCheck", profile.World?.NextWeatherCheck);
  if (Array.isArray(profile.World?.Stores)) {
    profile.World.Stores.forEach((store,i) => add(`/World/Stores/${i}/LastRefresh`, store?.LastRefresh));
  } else if (isRecord(profile.World?.Stores)) {
    Object.entries(profile.World.Stores).forEach(([id,store]) => add(`/World/Stores/${pointerEscape(id)}/LastRefresh`, store?.LastRefresh));
  }
  return {schema, canWriteSchema, events, diagnostic};
}

// Locate exact source string lexemes by JSON Pointer. Leaves all untargeted bytes,
// including 64-bit integers, untouched. Input must have passed the converter's
// strict profile validation before this operation.
function findStringRanges(source, wanted) {
  let i = 0;
  const hits = new Map();
  const skip = () => { while (/\s/.test(source[i] ?? "") && i < source.length) i++; };
  function readString() {
    if (source[i] !== '"') throw new Error("Expected JSON string.");
    const start = i++;
    while (i < source.length) {
      const ch = source[i++];
      if (ch === "\\") { i++; continue; }
      if (ch === '"') return {start,end:i,value:JSON.parse(source.slice(start,i))};
    }
    throw new Error("Unterminated JSON string.");
  }
  function readValue(path, depth) {
    if (depth > 128) throw new Error("JSON nesting too deep.");
    skip();
    if (source[i] === "{") {
      i++; skip();
      const keys = new Set();
      while (source[i] !== "}") {
        const key = readString().value;
        if (keys.has(key)) throw new Error(`Duplicate JSON key at ${path || "/"}.`);
        keys.add(key);
        skip(); if (source[i++] !== ":") throw new Error("Missing colon.");
        readValue(`${path}/${pointerEscape(key)}`, depth + 1);
        skip(); if (source[i] === "}") break;
        if (source[i++] !== ",") throw new Error("Missing comma.");
        skip();
      }
      i++; return;
    }
    if (source[i] === "[") {
      i++; skip(); let index=0;
      while (source[i] !== "]") {
        readValue(`${path}/${index++}`, depth+1);
        skip(); if (source[i] === "]") break;
        if (source[i++] !== ",") throw new Error("Missing array comma.");
        skip();
      }
      i++; return;
    }
    if (source[i] === '"') {
      const token = readString();
      if (wanted.has(path)) {
        if (hits.has(path)) throw new Error(`Duplicate target path: ${path}`);
        hits.set(path, token);
      }
      return;
    }
    while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
  }
  readValue("",0); skip();
  if (i !== source.length) throw new Error("Unexpected trailing data.");
  return hits;
}

export function patchTimingFields(jsonText, edits, nowMs = Date.now()) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("No timing changes selected.");
  const inspected = inspectTimingFields(jsonText, nowMs);
  if (!inspected.canWriteSchema) throw new Error(`Unsupported save schema: ${inspected.schema}.`);
  const allowed = new Map(inspected.events.filter(x=>x.editable).map(x=>[x.pointer,x]));
  const replacements = new Map();
  for (const edit of edits) {
    if (!edit || typeof edit.pointer !== "string" || replacements.has(edit.pointer)) throw new Error("Duplicate or invalid edit.");
    const item = allowed.get(edit.pointer);
    if (!item) throw new Error(`Editing is not permitted at ${edit.pointer}.`);
    if (item.time !== edit.expected) throw new Error(`Original value mismatch at ${edit.pointer}.`);
    if (!isTimestamp(edit.value) || Number(edit.value.slice(0,4)) >= 2100 || Number(edit.value.slice(0,4)) < 2000) {
      throw new Error(`Invalid proposed date at ${edit.pointer}.`);
    }
    if (edit.value === item.time) continue;
    replacements.set(edit.pointer, edit.value);
  }
  if (!replacements.size) throw new Error("There are no effective changes.");
  const locations = findStringRanges(jsonText, new Set(replacements.keys()));
  if (locations.size !== replacements.size) throw new Error("One or more fields could not be located uniquely.");
  const patches = [];
  for (const [path, newTime] of replacements) {
    const original = allowed.get(path);
    const token = locations.get(path);
    if (token.value !== original.time) throw new Error(`Source token mismatch at ${path}.`);
    patches.push({start:token.start,end:token.end,replacement:JSON.stringify(newTime)});
  }
  let edited = jsonText;
  for (const patch of patches.sort((a,b)=>b.start-a.start)) {
    edited = edited.slice(0,patch.start) + patch.replacement + edited.slice(patch.end);
  }
  const verified = inspectTimingFields(edited, nowMs);
  const after = new Map(verified.events.map(x=>[x.pointer,x]));
  for (const [path,newTime] of replacements) {
    if (after.get(path)?.time !== newTime) throw new Error(`Post-edit verification failed at ${path}.`);
  }
  return {jsonText:edited,changes:[...replacements].map(([pointer,value])=>({pointer,before:allowed.get(pointer).time,after:value}))};
}
