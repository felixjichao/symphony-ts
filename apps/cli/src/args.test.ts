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

  it("recognizes repo-bootstrap subcommand and arguments", () => {
    expect(parseCliArgs(["repo-bootstrap", "--repo", "https://github.com/org/repo.git"])).toEqual({
      subcommand: "repo-bootstrap",
      subcommandArgs: ["--repo", "https://github.com/org/repo.git"],
    });
    expect(parseCliArgs(["bootstrap-repo", "--repo", "https://github.com/org/repo.git"])).toEqual({
      subcommand: "repo-bootstrap",
      subcommandArgs: ["--repo", "https://github.com/org/repo.git"],
    });
  });

  it("recognizes workspace bootstrap subcommand and arguments", () => {
    expect(parseCliArgs(["workspace", "bootstrap", "--repo", "https://github.com/org/repo.git"])).toEqual({
      subcommand: "repo-bootstrap",
      subcommandArgs: ["--repo", "https://github.com/org/repo.git"],
    });
  });

  it("recognizes delivery-skill subcommand and arguments", () => {
    expect(parseCliArgs(["delivery-skill", "run", "--repo", "org/repo", "--issue", "80"])).toEqual({
      subcommand: "delivery-skill",
      subcommandArgs: ["run", "--repo", "org/repo", "--issue", "80"],
    });
    expect(parseCliArgs(["delivery-skill", "halt", "--repo", "org/repo", "--issue", "80"])).toEqual({
      subcommand: "delivery-skill",
      subcommandArgs: ["halt", "--repo", "org/repo", "--issue", "80"],
    });
  });

  it("recognizes pr and delivery subcommands and arguments", () => {
    expect(parseCliArgs(["pr", "ensure", "--repo", "org/repo", "--issue", "81"])).toEqual({
      subcommand: "delivery",
      subcommandArgs: ["ensure", "--repo", "org/repo", "--issue", "81"],
    });
    expect(parseCliArgs(["delivery", "land", "--opt-in"])).toEqual({
      subcommand: "delivery",
      subcommandArgs: ["land", "--opt-in"],
    });
  });

  it("recognizes decision bridge subcommand and arguments", () => {
    expect(parseCliArgs(["decision", "bridge", "--store", "/data", "--port", "4040"])).toEqual({
      subcommand: "decision-bridge",
      subcommandArgs: ["--store", "/data", "--port", "4040"],
    });
    expect(parseCliArgs(["decision-bridge", "--store", "/data"])).toEqual({
      subcommand: "decision-bridge",
      subcommandArgs: ["--store", "/data"],
    });
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
