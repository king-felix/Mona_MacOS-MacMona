import { describe, expect, it } from "vitest";
import { Transcript, classifyLinkTarget } from "../src/renderer/shell/ansi";

function text(transcript: Transcript): string {
  return transcript
    .render()
    .lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

describe("terminal transcript", () => {
  it("splits lines and treats CRLF as one newline", () => {
    const transcript = new Transcript();
    transcript.write("first\r\nsecond\nthird");
    expect(text(transcript)).toBe("first\nsecond\nthird");
  });

  it("overwrites the current line on a bare carriage return", () => {
    const transcript = new Transcript();
    transcript.write("progress 10%\rprogress 100%\n");
    expect(text(transcript)).toBe("progress 100%");
  });

  it("applies backspace and strips control characters", () => {
    const transcript = new Transcript();
    transcript.write("abc\b\bZ\u0007\n");
    expect(text(transcript)).toBe("aZ");
    expect(transcript.statsSnapshot().other).toBeGreaterThan(0);
  });

  it("keeps SGR emphasis as inert style spans", () => {
    const transcript = new Transcript();
    transcript.write("\u001b[1mbold\u001b[0m plain \u001b[31merror\u001b[39m\n");
    const spans = transcript.render().lines[0]!.spans;
    expect(spans.map((span) => [span.text, span.tone])).toEqual([
      ["bold", "bold"],
      [" plain ", "plain"],
      ["error", "error"],
    ]);
  });

  it("strips a hyperlink escape and leaves the label as inert text", () => {
    const transcript = new Transcript();
    transcript.write(
      "\u001b]8;;file:///etc/passwd\u0007click me\u001b]8;;\u0007\n" +
        "\u001b]8;;https://example.com\u0007site\u001b]8;;\u0007\n",
    );
    expect(text(transcript)).toBe("click me\nsite");
    const stats = transcript.statsSnapshot();
    expect(stats.osc).toBe(4);
    // Nothing in the rendered output is a link or a command.
    const rendered = JSON.stringify(transcript.render());
    expect(rendered).not.toContain("file:///etc/passwd");
    expect(rendered).not.toContain("https://example.com");
    expect(classifyLinkTarget("file:///etc/passwd")).toBe("inert");
    expect(classifyLinkTarget("javascript:alert(1)")).toBe("inert");
    expect(classifyLinkTarget("https://example.com")).toBe("https");
  });

  it("reassembles a sequence split across two writes", () => {
    const transcript = new Transcript();
    transcript.write("start \u001b[3");
    expect(transcript.pendingSequence()).toBe(true);
    transcript.write("1mred\u001b[0m end\n");
    const spans = transcript.render().lines[0]!.spans;
    expect(spans.some((span) => span.text.includes("red") && span.tone === "error")).toBe(true);
    expect(text(transcript)).toBe("start red end");
  });

  it("strips cursor addressing and private modes", () => {
    const transcript = new Transcript();
    transcript.write("\u001b[2J\u001b[H\u001b[?2004hhello\u001b[?2004l\n");
    expect(text(transcript)).toBe("hello");
    expect(transcript.statsSnapshot().csi).toBe(4);
  });

  it("bounds retained lines and reports what it dropped", () => {
    const transcript = new Transcript({ maxLines: 3 });
    transcript.write("1\n2\n3\n4\n5\n");
    expect(text(transcript)).toBe("3\n4\n5");
    expect(transcript.statsSnapshot().droppedLines).toBe(2);
  });

  it("clears only its own view", () => {
    const transcript = new Transcript();
    transcript.write("keep\n");
    transcript.clear();
    expect(text(transcript)).toBe("");
  });
});
