import process from "node:process";

const { GITHUB_EVENT_NAME: event, DRIVER_PR_BASE_SHA: prBase, DRIVER_PUSH_BEFORE_SHA: pushBefore } = process.env;
const base = event === "pull_request" ? prBase : event === "push" ? pushBefore : undefined;
if (!base || !/^[0-9a-f]{40}$/i.test(base)) throw new Error(`Missing or invalid release baseline for ${event}`);
if (/^0{40}$/.test(base)) {
  if (event !== "push") throw new Error("A pull request must have a real release baseline");
} else {
  process.stdout.write(base);
}
