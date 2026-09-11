import assert from "node:assert/strict";
import { buildBackupFileName, createEncryptedProfile, createPrettyProfile, loadProfile, parseProfileText } from "../js/profile.js";

const profileText = '{"GameInfo":{"Version":608,"LastCustomIdOwner":"3768951AEBEA42C5","Created":"2025-10-14T23:31:58.070966900Z","Modified":"2026-09-09T03:52:12.521318300Z","LastSaveDeviceInfo":{"deviceType":"DeviceType_Windows"}},"Player":{"Name":"Morarin","TimePlayedInMinutes":18867},"Unknown":{"Value":123,"Huge":9007199254740993123456789}}';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const plainBytes = encoder.encode(profileText);
const plain = await loadProfile(plainBytes);
assert.equal(plain.inputType, "plain");
assert.equal(plain.metadata.version, "608");
assert.equal(plain.metadata.playerName, "Morarin");
assert.equal(plain.metadata.timePlayedInMinutes, "18867");
assert.equal(buildBackupFileName(plain.metadata), "mdc3768951AEBEA42C5_v608_20260909T035212Z.profile.bak");

const encryptedBytes = await createEncryptedProfile(plain.jsonText, plain.metadata);
assert.ok(encryptedBytes.length > 0);
assert.equal(encryptedBytes.length % 16, 0);

const encrypted = await loadProfile(encryptedBytes);
assert.equal(encrypted.inputType, "encrypted");
assert.deepEqual(encrypted.metadata, plain.metadata);
assert.ok(encrypted.jsonText.includes("9007199254740993123456789"));

const prettyBytes = createPrettyProfile(encrypted.jsonText, encrypted.metadata);
const pretty = decoder.decode(prettyBytes);
assert.ok(pretty.includes('\n    "GameInfo": {'));
assert.ok(pretty.includes("9007199254740993123456789"));
assert.equal(parseProfileText(pretty).metadata.version, "608");

const fallbackMetadata = { ...plain.metadata, lastCustomIdOwner: null, modified: null };
assert.equal(buildBackupFileName(fallbackMetadata), "profile_v608_original.profile.bak");

console.log("Web converter round-trip tests passed.");
