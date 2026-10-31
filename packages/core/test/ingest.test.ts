import { describe, expect, it } from "vitest";
import { LoomError, parseIngestPayload } from "../src/index.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const conversation = JSON.stringify({ title: "Kickoff", messages: [{ role: "user", content: "hi" }] });

describe("parseIngestPayload", () => {
  it("accepts a conversation file verbatim with JSON media type", () => {
    const input = parseIngestPayload("chat.json", utf8(conversation));
    expect(input).toMatchObject({ type: "conversation", mediaType: "application/json", title: "Kickoff" });
    expect(input.text).toBe(conversation);
  });

  it("treats markdown as a document titled by file name unless overridden", () => {
    expect(parseIngestPayload("dir/notes.md", utf8("# Notes"))).toMatchObject({ type: "document", title: "notes.md" });
    expect(parseIngestPayload("run.log", utf8("ok"), { type: "tool-output", title: "Build" })).toMatchObject({
      type: "tool-output",
      title: "Build",
    });
  });

  it.each([
    ["bad.json", utf8("{"), /not valid JSON/],
    ["empty-msgs.json", utf8('{"messages":[]}'), /at least one message/],
    ["extra.json", utf8('{"messages":[{"role":"user","content":"x"}],"x":1}'), /Invalid conversation/],
    ["blank.md", utf8("   \n"), /is empty/],
    ["binary.txt", new Uint8Array([0xff, 0xfe, 0x00]), /not valid UTF-8/],
    ["image.png", utf8("x"), /unsupported file type/],
  ])("rejects %s", (name, bytes, message) => {
    expect(() => parseIngestPayload(name, bytes)).toThrow(message);
  });

  it("refuses a non-conversation type for a conversation file", () => {
    expect(() => parseIngestPayload("chat.json", utf8(conversation), { type: "document" })).toThrow(LoomError);
  });
});
