// R12 — the hooks lint gate is a mechanism, not a claim.
//
// R11's independent review found a runtime blocker (`Rendered more hooks than
// during the previous render`) that `npm run lint` could not see, because the
// repository had no react-hooks plugin: "lint 0 errors" was never evidence for
// that class of defect (RD-023). The plugin is now configured; this test proves
// the configured gate actually rejects the two shapes that caused it, and that
// it does not fire on ordinary component code.
//
// It lints source text through the repository's own `eslint.config.mjs`, so the
// guarantee fails if the rule is downgraded, scoped away from the renderer, or
// removed.

import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

async function lintSource(source: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages
    .filter((message) => message.ruleId === "react-hooks/rules-of-hooks")
    .map((message) => message.message);
}

describe("react-hooks lint gate", () => {
  it("rejects a hook after an early return (the R11 production defect)", async () => {
    const messages = await lintSource(
      [
        "export function Panel(props: { detail: { id: string } | null }) {",
        "  if (!props.detail) return null;",
        "  const label = useLabel(props.detail.id);",
        "  return <div>{label}</div>;",
        "}",
        "function useLabel(id: string) { return id; }",
      ].join("\n"),
      "src/renderer/shell/__lint_fixture_conditional.tsx",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/conditionally|after an early return/i);
  });

  it("rejects a callback named like a hook, called from a plain function", async () => {
    const messages = await lintSource(
      [
        "function Actions(useThing: () => void) {",
        "  const run = () => useThing();",
        "  return run;",
        "}",
        "export function Picker(props: { useThing: () => void }) {",
        "  return <button onClick={() => Actions(props.useThing)()} />;",
        "}",
      ].join("\n"),
      "src/renderer/shell/__lint_fixture_naming.tsx",
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.join(" ")).toMatch(/React Hook "useThing"/);
  });

  it("accepts hooks at the top of a component and inside a custom hook", async () => {
    const messages = await lintSource(
      [
        "function useCounter() {",
        "  const [value, setValue] = useState(0);",
        "  return { value, setValue };",
        "}",
        "export function Counter() {",
        "  const { value, setValue } = useCounter();",
        "  useEffect(() => {}, [value]);",
        "  return <button onClick={() => setValue(value + 1)}>{value}</button>;",
        "}",
      ].join("\n"),
      "src/renderer/shell/__lint_fixture_clean.tsx",
    );
    expect(messages).toEqual([]);
  });
});
