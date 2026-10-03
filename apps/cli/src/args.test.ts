import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs, resolveWorkflowPath } from "./args";

describe("parseCliArgs", () => {
  it("extracts positional workflow path", () => {
    expect(parseCliArgs(["custom/WORKFLOW.md"])).toEqual({ workflowPath: "custom/WORKFLOW.md" });
  });

  it("handles --help and -h flags", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
    expect(parseCliArgs(["-h"])).toEqual({ help: true });
    expect(parseCliArgs(["my/workflow.md", "--help"])).toEqual({ workflowPath: "my/workflow.md", help: true });
  });

  it("handles --version and -v flags", () => {
    expect(parseCliArgs(["--version"])).toEqual({ version: true });
    expect(parseCliArgs(["-v"])).toEqual({ version: true });
    expect(parseCliArgs(["my/workflow.md", "-v"])).toEqual({ workflowPath: "my/workflow.md", version: true });
  });

  it("returns empty object when no arguments are provided", () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it("ignores extra positional arguments after the first", () => {
    expect(parseCliArgs(["first.md", "second.md"])).toEqual({ workflowPath: "first.md" });
  });
});

describe("resolveWorkflowPath", () => {
  it("resolves explicit path against specified cwd", () => {
    const cwd = "/test/root";
    expect(resolveWorkflowPath("foo/WORKFLOW.md", cwd)).toBe(path.resolve(cwd, "foo/WORKFLOW.md"));
    expect(resolveWorkflowPath("/abs/WORKFLOW.md", cwd)).toBe(path.resolve("/abs/WORKFLOW.md"));
  });

  it("resolves default WORKFLOW.md against cwd when rawPath is omitted or empty", () => {
    const cwd = "/test/root";
    expect(resolveWorkflowPath(undefined, cwd)).toBe(path.resolve(cwd, "WORKFLOW.md"));
    expect(resolveWorkflowPath("", cwd)).toBe(path.resolve(cwd, "WORKFLOW.md"));
    expect(resolveWorkflowPath("   ", cwd)).toBe(path.resolve(cwd, "WORKFLOW.md"));
  });
});
