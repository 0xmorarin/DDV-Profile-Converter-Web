import { HEX_KEY, ZIP_INNER_NAME } from "./config.js";
import { aes256EcbDecrypt, aes256EcbEncrypt, hexToBytes } from "./aes.js";
import { createZipEntry, readZipEntry } from "./zip.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const key = hexToBytes(HEX_KEY);

class JsonTokenizer {
  constructor(text) {
    this.text = text;
    this.index = 0;
    this.buffered = null;
  }

  peek() {
    if (this.buffered === null) this.buffered = this.readNext();
    return this.buffered;
  }

  next() {
    if (this.buffered !== null) {
      const token = this.buffered;
      this.buffered = null;
      return token;
    }
    return this.readNext();
  }

  readNext() {
    this.skipWhitespace();
    if (this.index >= this.text.length) return { type: "eof", raw: "" };
    const start = this.index;
    const ch = this.text[this.index];

    if ("{}[],:".includes(ch)) {
      this.index++;
      return { type: ch, raw: ch };
    }

    if (ch === '"') return this.readString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.readNumber();

    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return { type: "true", raw: "true" };
    }

    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return { type: "false", raw: "false" };
    }

    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return { type: "null", raw: "null" };
    }

    throw new Error(`Invalid JSON token at character ${start}.`);
  }

  skipWhitespace() {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") break;
      this.index++;
    }
  }

  readString() {
    const start = this.index++;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      const ch = this.text[this.index++];
      if (ch === '"') return { type: "string", raw: this.text.slice(start, this.index) };
      if (code < 0x20) throw new Error(`Invalid control character in JSON string at character ${this.index - 1}.`);
      if (ch !== "\\") continue;
      if (this.index >= this.text.length) throw new Error("Unterminated JSON string escape.");
      const escaped = this.text[this.index++];
      if ('"\\/bfnrt'.includes(escaped)) continue;
      if (escaped !== "u") throw new Error(`Invalid JSON string escape at character ${this.index - 1}.`);
      if (this.index + 4 > this.text.length) throw new Error("Incomplete JSON Unicode escape.");
      const hex = this.text.slice(this.index, this.index + 4);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error(`Invalid JSON Unicode escape at character ${this.index}.`);
      this.index += 4;
    }
    throw new Error("Unterminated JSON string.");
  }

  readNumber() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index++;
    if (this.index >= this.text.length) throw new Error(`Invalid JSON number at character ${start}.`);

    if (this.text[this.index] === "0") {
      this.index++;
      if (this.index < this.text.length && /[0-9]/.test(this.text[this.index])) throw new Error(`Invalid leading zero in JSON number at character ${start}.`);
    } else if (/[1-9]/.test(this.text[this.index])) {
      while (this.index < this.text.length && /[0-9]/.test(this.text[this.index])) this.index++;
    } else {
      throw new Error(`Invalid JSON number at character ${start}.`);
    }

    if (this.text[this.index] === ".") {
      this.index++;
      const fractionStart = this.index;
      while (this.index < this.text.length && /[0-9]/.test(this.text[this.index])) this.index++;
      if (this.index === fractionStart) throw new Error(`Invalid JSON fraction at character ${start}.`);
    }

    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.index++;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index++;
      const exponentStart = this.index;
      while (this.index < this.text.length && /[0-9]/.test(this.text[this.index])) this.index++;
      if (this.index === exponentStart) throw new Error(`Invalid JSON exponent at character ${start}.`);
    }

    return { type: "number", raw: this.text.slice(start, this.index) };
  }
}

function decodeStringToken(token) {
  return JSON.parse(token.raw);
}

function normalizeText(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function makeMetadata() {
  return {
    version: null,
    lastCustomIdOwner: null,
    created: null,
    modified: null,
    playerName: null,
    timePlayedInMinutes: null,
    lastSaveDeviceType: null
  };
}

function isNonNegativeIntegerToken(token) {
  return token.type === "number" && !token.raw.startsWith("-") && !token.raw.includes(".") && !/[eE]/.test(token.raw);
}

function readOptionalStringValue(result, label) {
  if (result.type === "null") return null;
  if (result.type !== "string") throw new Error(`${label} is invalid.`);
  return decodeStringToken(result.token);
}

function parseProfileText(text) {
  const normalized = normalizeText(text);
  const tokenizer = new JsonTokenizer(normalized);
  const metadata = makeMetadata();
  let gameInfoSeen = false;
  let versionSeen = false;

  function parseValue(scope = "other") {
    const token = tokenizer.next();

    if (token.type === "{") {
      parseObject(scope);
      return { type: "object", token };
    }

    if (token.type === "[") {
      parseArray();
      return { type: "array", token };
    }

    if (["string", "number", "true", "false", "null"].includes(token.type)) {
      return { type: token.type, token };
    }

    throw new Error("Invalid JSON value.");
  }

  function parseArray() {
    if (tokenizer.peek().type === "]") {
      tokenizer.next();
      return;
    }

    while (true) {
      parseValue("other");
      const separator = tokenizer.next();
      if (separator.type === "]") return;
      if (separator.type !== ",") throw new Error("Invalid JSON array separator.");
    }
  }

  function parseObject(scope) {
    if (tokenizer.peek().type === "}") {
      tokenizer.next();
      return;
    }

    while (true) {
      const keyToken = tokenizer.next();
      if (keyToken.type !== "string") throw new Error("JSON object property name must be a string.");
      const keyName = decodeStringToken(keyToken);
      if (tokenizer.next().type !== ":") throw new Error("JSON object property is missing a colon.");

      if (scope === "root" && keyName === "GameInfo") {
        const result = parseValue("gameInfo");
        if (result.type !== "object") throw new Error("GameInfo is missing or invalid.");
        gameInfoSeen = true;
      } else if (scope === "root" && keyName === "Player") {
        const result = parseValue("player");
        if (result.type !== "object") throw new Error("Player is invalid.");
      } else if (scope === "gameInfo" && keyName === "Version") {
        const result = parseValue("other");
        if (!isNonNegativeIntegerToken(result.token)) throw new Error("GameInfo.Version is missing or invalid.");
        metadata.version = result.token.raw;
        versionSeen = true;
      } else if (scope === "gameInfo" && keyName === "LastCustomIdOwner") {
        metadata.lastCustomIdOwner = readOptionalStringValue(parseValue("other"), "LastCustomIdOwner");
      } else if (scope === "gameInfo" && keyName === "Created") {
        metadata.created = readOptionalStringValue(parseValue("other"), "Created");
      } else if (scope === "gameInfo" && keyName === "Modified") {
        metadata.modified = readOptionalStringValue(parseValue("other"), "Modified");
      } else if (scope === "gameInfo" && keyName === "LastSaveDeviceInfo") {
        const result = parseValue("deviceInfo");
        if (result.type !== "object" && result.type !== "null") throw new Error("GameInfo.LastSaveDeviceInfo is invalid.");
      } else if (scope === "player" && keyName === "Name") {
        metadata.playerName = readOptionalStringValue(parseValue("other"), "Name");
      } else if (scope === "player" && keyName === "TimePlayedInMinutes") {
        const result = parseValue("other");
        if (result.type === "null") {
          metadata.timePlayedInMinutes = null;
        } else {
          if (!isNonNegativeIntegerToken(result.token)) throw new Error("TimePlayedInMinutes is invalid.");
          metadata.timePlayedInMinutes = result.token.raw;
        }
      } else if (scope === "deviceInfo" && keyName === "deviceType") {
        metadata.lastSaveDeviceType = readOptionalStringValue(parseValue("other"), "deviceType");
      } else {
        parseValue("other");
      }

      const separator = tokenizer.next();
      if (separator.type === "}") return;
      if (separator.type !== ",") throw new Error("Invalid JSON object separator.");
    }
  }

  const root = parseValue("root");
  if (root.type !== "object") throw new Error("The profile root must be a JSON object.");
  if (tokenizer.next().type !== "eof") throw new Error("Unexpected data after the JSON document.");
  if (!gameInfoSeen) throw new Error("GameInfo is missing or invalid.");
  if (!versionSeen || metadata.version === null) throw new Error("GameInfo.Version is missing or invalid.");
  return { jsonText: normalized, metadata };
}

function formatJsonText(text, indented) {
  const tokenizer = new JsonTokenizer(normalizeText(text));
  const chunks = [];
  let indent = 0;
  let previous = null;
  let current = tokenizer.next();

  while (current.type !== "eof") {
    const next = tokenizer.peek();

    if (!indented) {
      chunks.push(current.raw);
    } else if (current.type === "{") {
      chunks.push("{");
      indent++;
      if (next.type !== "}") chunks.push("\n", "    ".repeat(indent));
    } else if (current.type === "[") {
      chunks.push("[");
      indent++;
      if (next.type !== "]") chunks.push("\n", "    ".repeat(indent));
    } else if (current.type === "}" || current.type === "]") {
      indent--;
      const opening = current.type === "}" ? "{" : "[";
      if (previous !== opening) chunks.push("\n", "    ".repeat(indent));
      chunks.push(current.raw);
    } else if (current.type === ",") {
      chunks.push(",\n", "    ".repeat(indent));
    } else if (current.type === ":") {
      chunks.push(": ");
    } else {
      chunks.push(current.raw);
    }

    previous = current.type;
    current = tokenizer.next();
  }

  return chunks.join("");
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameMetadata(a, b) {
  return a.version === b.version &&
    a.lastCustomIdOwner === b.lastCustomIdOwner &&
    a.created === b.created &&
    a.modified === b.modified &&
    a.playerName === b.playerName &&
    a.timePlayedInMinutes === b.timePlayedInMinutes &&
    a.lastSaveDeviceType === b.lastSaveDeviceType;
}

async function readEncrypted(raw) {
  const archiveBytes = aes256EcbDecrypt(raw, key);
  const jsonBytes = await readZipEntry(archiveBytes, ZIP_INNER_NAME);
  if (!jsonBytes) throw new Error("The encrypted profile does not contain the expected profile entry.");
  const jsonText = decoder.decode(jsonBytes);
  return parseProfileText(jsonText);
}

export async function loadProfile(raw) {
  if (!(raw instanceof Uint8Array) || raw.length === 0) throw new Error("The selected file is empty.");

  let decoded = null;
  try {
    decoded = decoder.decode(raw);
  } catch {
    decoded = null;
  }

  if (decoded !== null) {
    const trimmed = normalizeText(decoded).trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseProfileText(decoded);
      return { inputType: "plain", ...parsed };
    }
  }

  if (raw.length % 16 !== 0) throw new Error("This file is neither a valid DDV plaintext profile nor a valid encrypted DDV profile.");

  try {
    const parsed = await readEncrypted(raw);
    return { inputType: "encrypted", ...parsed };
  } catch (error) {
    throw new Error("This file is neither a valid DDV plaintext profile nor a valid encrypted DDV profile.", { cause: error });
  }
}

export function createPrettyProfile(jsonText, expectedMetadata) {
  const prettyText = formatJsonText(jsonText, true);
  const verified = parseProfileText(prettyText);
  if (!sameMetadata(verified.metadata, expectedMetadata)) throw new Error("Profile metadata changed during formatting.");
  return encoder.encode(prettyText);
}

export async function createEncryptedProfile(jsonText, expectedMetadata) {
  const minifiedText = formatJsonText(jsonText, false);
  const verifiedPlain = parseProfileText(minifiedText);
  if (!sameMetadata(verifiedPlain.metadata, expectedMetadata)) throw new Error("Profile metadata changed during minification.");
  const minifiedBytes = encoder.encode(minifiedText);
  const archiveBytes = await createZipEntry(ZIP_INNER_NAME, minifiedBytes);
  const encryptedBytes = aes256EcbEncrypt(archiveBytes, key);
  const decryptedArchive = aes256EcbDecrypt(encryptedBytes, key);
  const roundTripBytes = await readZipEntry(decryptedArchive, ZIP_INNER_NAME);
  if (!roundTripBytes || !sameBytes(roundTripBytes, minifiedBytes)) throw new Error("Encrypted profile round-trip verification failed.");
  const roundTrip = parseProfileText(decoder.decode(roundTripBytes));
  if (!sameMetadata(roundTrip.metadata, expectedMetadata)) throw new Error("Profile metadata changed during encryption.");
  return encryptedBytes;
}

export function buildBackupFileName(metadata) {
  const owner = metadata.lastCustomIdOwner;
  const modified = metadata.modified;
  const safeOwner = typeof owner === "string" && /^[A-Za-z0-9_-]+$/.test(owner);
  const match = typeof modified === "string" ? modified.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/) : null;
  if (safeOwner && match) {
    const timestamp = `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}Z`;
    return `mdc${owner}_v${metadata.version}_${timestamp}.profile.bak`;
  }
  return `profile_v${metadata.version}_original.profile.bak`;
}

export { formatJsonText, parseProfileText };
